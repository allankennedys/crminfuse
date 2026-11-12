-- ============================================================
-- Aviso ao n8n quando uma venda é EXCLUÍDA (fluxo de reembolso)
--
-- Excluir venda é o oposto do 068: some dinheiro do relatório, e o outro
-- lado (gateway, planilha, financeiro) precisa saber para estornar. A chave
-- dessa conciliação é o external_id (036) — o número do pedido no sistema de
-- origem. É por ele que o fluxo acha o que estornar; sem ele o aviso ainda
-- sai, mas o fluxo só tem telefone e valor para casar à mão.
--
-- POR QUE PELO BANCO, E NÃO PELO NAVEGADOR
--
-- Mesmo motivo da 068: o webhook do n8n não responde CORS, um fetch do
-- painel morreria no preflight e a venda sumiria sem ninguém saber — falha
-- silenciosa, a pior aqui. Pelo pg_net a chamada sai do servidor.
--
-- E, por ser trigger, vale para TODO caminho de exclusão: o botão da lixeira
-- no drawer do contato, um delete futuro pela crm-api, e o SQL manual. Se
-- fosse no crmService.deleteSale, o primeiro caminho novo nasceria mudo.
--
-- ROLLBACK ANULA O AVISO
--
-- net.http_post enfileira DENTRO da transação (068/070/079): exclusão que
-- falhar no meio leva o webhook junto, e o n8n não recebe estorno de venda
-- que continua lá.
--
-- OS DOIS CAMINHOS DE EXCLUSÃO
--
-- 1. A venda sozinha (lixeira do drawer). O contato continua existindo.
-- 2. O CONTATO inteiro é excluído — crm_sales.contact_id é `on delete
--    cascade` (031), então as vendas dele vão junto.
--
-- O caso 2 exige cuidado, e é o motivo de existirem DUAS triggers aqui. Na
-- cascata, quando a trigger da venda dispara, a linha do contato JÁ FOI
-- apagada: o cascade do Postgres roda depois do delete do pai. O aviso sairia
-- sem nome, sem telefone, sem canal — justamente o que o fluxo de reembolso
-- precisa para achar o cliente.
--
-- Por isso a exclusão de contato é avisada ANTES, por uma trigger BEFORE
-- DELETE em crm_contacts, que percorre as vendas com o contato ainda inteiro.
-- A trigger da venda então reconhece a cascata (contato não encontrado) e se
-- cala, para não mandar o mesmo estorno duas vezes, um deles pelado.
--
-- Resultado: o corpo tem SEMPRE a mesma forma, nos dois caminhos. O que
-- distingue é `deleted_with_contact`.
--
-- >>> SE O FLUXO EMITE ESTORNO DE VERDADE <<<
--
-- Filtre por `deleted_with_contact = false`. Apagar um cadastro duplicado
-- excluiria N vendas e, sem o filtro, viraria N estornos que ninguém pediu.
-- Quem só registra/avisa pode processar os dois.
--
-- O QUE O AVISO NÃO DESFAZ
--
-- O Purchase que já foi para a Meta. crm_events.sale_id não tem FK de
-- propósito (072): o evento sobrevive à venda, porque o que foi enviado não
-- volta atrás. O bloco `meta_event` diz em que pé está — `sent` significa
-- que a Meta já contabilizou a compra e nenhum estorno aqui a remove de lá.
-- ============================================================

-- ------------------------------------------------------------
-- O corpo e o POST, num lugar só
--
-- As duas triggers mandam o MESMO payload; escrever o jsonb duas vezes seria
-- garantir que um dia divergissem. Recebe os registros já lidos por quem
-- chama, porque só o chamador sabe se o contato ainda existe.
--
-- security definer: o schema net não é acessível ao usuário autenticado, e o
-- payload junta etapa, autor e evento da Meta — leituras que a RLS recusaria
-- em cascata. Não repete checagem de permissão como a 068 faz: aqui não há
-- RPC exposta ao cliente, e a linha só chega até aqui depois de a RLS ter
-- autorizado o DELETE.
-- ------------------------------------------------------------
create or replace function public.crm_sale_deleted_notify(
  p_sale public.crm_sales,
  p_contact public.crm_contacts,
  -- true quando o disparo veio da exclusão do contato (cascata).
  p_with_contact boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Infuse: a URL vem de integration_urls (041); sem cadastro, não envia.
  v_url constant text := public.integration_url('n8n_venda_excluida');
  v_stage    public.crm_stages;
  v_event    public.crm_events;
  v_seq      int;
  v_total    int;
  v_author   text;
  v_assignee text;
  v_actor    text;
  v_body     jsonb;
begin
  select * into v_stage from public.crm_stages where id = p_contact.stage_id;

  -- O evento de conversão desta venda (072). Continua existindo depois da
  -- exclusão — é ele que responde se a Meta já recebeu o Purchase.
  select * into v_event
  from public.crm_events
  where sale_id = p_sale.id and event_type = 'conversion'
  order by created_at desc
  limit 1;

  -- Posição da venda na vida do cliente, na ordem canônica (sold_at,
  -- created_at, id) — a mesma da 031, da 068 e da 079.
  --
  -- Na exclusão da venda sozinha esta função roda DEPOIS da crm_sales_sync
  -- (ver o nome da trigger, lá embaixo): a linha já não existe, e a
  -- comparação estrita `<` conta quantas vendas vinham antes dela. Na
  -- cascata roda ANTES de qualquer exclusão, com tudo no lugar. Nos dois
  -- casos o `+ 1` dá a posição que a venda ocupava.
  select count(*) + 1 into v_seq
  from public.crm_sales s
  where s.contact_id = p_sale.contact_id
    and (s.sold_at, s.created_at, s.id) < (p_sale.sold_at, p_sale.created_at, p_sale.id);

  -- Quantas vendas SOBRAM no cliente depois desta sair. Na cascata é zero
  -- por definição: o cadastro inteiro está indo embora junto.
  if p_with_contact then
    v_total := 0;
  else
    select count(*) into v_total
    from public.crm_sales s
    where s.contact_id = p_sale.contact_id;
  end if;

  select coalesce(nullif(trim(u.full_name), ''), u.email) into v_author
  from public.users u where u.id = p_sale.created_by;

  select coalesce(nullif(trim(u.full_name), ''), u.email) into v_assignee
  from public.users u where u.id = p_contact.assigned_to;

  select coalesce(nullif(trim(u.full_name), ''), u.email) into v_actor
  from public.users u where u.id = auth.uid();

  v_body := jsonb_build_object(
    'event', 'venda_excluida',
    'sent_at', now(),
    'organization_id', p_sale.organization_id,
    -- O filtro do fluxo: true = o cadastro inteiro foi apagado, não é um
    -- estorno de uma venda específica.
    'deleted_with_contact', p_with_contact,
    -- Quem clicou. Nulo quando a exclusão veio de fora de uma sessão
    -- autenticada (SQL manual, service role).
    'deleted_by', auth.uid(),
    'deleted_by_name', v_actor,
    -- Era a compra que levou o contato ao funil? O estorno da primeira é
    -- outra conversa do ponto de vista do relatório e da Meta.
    'was_first_sale', v_seq = 1,
    'sale_number', v_seq,
    'remaining_sales_count', v_total,
    'sale', jsonb_build_object(
      'id', p_sale.id,
      -- A CHAVE DO ESTORNO: id do pedido no sistema de origem (036). Nulo
      -- nas vendas lançadas à mão pela tela, que nunca tiveram um.
      'external_id', p_sale.external_id,
      'value_cents', p_sale.value_cents,
      -- Já em reais para o fluxo não dividir por 100 do outro lado.
      'value', round(p_sale.value_cents::numeric / 100, 2),
      'creatives', p_sale.creatives,
      'sold_at', p_sale.sold_at,
      'note', p_sale.note,
      'payment_method', p_sale.payment_method,
      'payment_method_label', case p_sale.payment_method
        when 'pix'     then 'Pix'
        when 'credito' then 'Crédito'
        when 'debito'  then 'Débito'
        when 'boleto'  then 'Boleto'
        else null
      end,
      'created_at', p_sale.created_at,
      'created_by', p_sale.created_by,
      'created_by_name', v_author
    ),
    -- O que a Meta já sabe desta venda. null = nunca virou evento (cliente
    -- que não veio de anúncio). status 'sent' = o Purchase já foi
    -- contabilizado lá e NÃO é desfeito por esta exclusão.
    'meta_event', case when v_event.id is null then null else jsonb_build_object(
      'id', v_event.id,
      'status', v_event.status,
      'sent_at', v_event.sent_at,
      'ad_source', v_event.payload->>'ad_source'
    ) end,
    'contact', jsonb_build_object(
      'id', p_contact.id,
      'name', p_contact.name,
      'phone', p_contact.phone,
      -- A identidade do número (069): mesma forma para as quatro grafias que
      -- circulam. É por ela que o n8n casa o contato com a conversa.
      'phone_id', public.crm_phone_id(p_contact.phone),
      'email', p_contact.email,
      'channel', p_contact.channel,
      'origem', p_contact.origem,
      'source_id', p_contact.source_id,
      'ctwaclid', p_contact.ctwaclid,
      'campaign_id', p_contact.campaign_id,
      'conversation_id', p_contact.conversation_id,
      'tags', to_jsonb(p_contact.tags),
      'stage_id', p_contact.stage_id,
      'stage_name', v_stage.name,
      'assigned_to', p_contact.assigned_to,
      'assigned_to_name', v_assignee,
      'created_at', p_contact.created_at,
      -- Totais do contato. Na exclusão da venda sozinha já vêm RECALCULADOS
      -- pela crm_sales_sync (031), isto é, sem a venda que está saindo — é o
      -- estado que o painel vai mostrar. Na cascata são os de antes, porque
      -- o cadastro inteiro deixa de existir logo em seguida.
      'sales_count', p_contact.sales_count,
      'first_sale_value_cents', p_contact.value_cents,
      'sales_total_cents', p_contact.sales_total_cents,
      'sales_total', round(p_contact.sales_total_cents::numeric / 100, 2)
    )
  );

  if v_url is null then
    return;
  end if;

  perform net.http_post(
    url := v_url,
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := v_body,
    -- 15s, como na 068/070/079: o tempo é do processo de background do
    -- pg_net, não de quem clicou em excluir — a tela não espera por isto.
    timeout_milliseconds := 15000
  );
end;
$$;

comment on function public.crm_sale_deleted_notify(public.crm_sales, public.crm_contacts, boolean) is
  'Monta e envia ao n8n o aviso de venda excluída (fluxo de reembolso), com '
  'external_id, contato e situação do evento na Meta. Chamada pelas triggers '
  'de exclusão de venda e de contato — não é para ser chamada à mão.';

revoke all on function public.crm_sale_deleted_notify(public.crm_sales, public.crm_contacts, boolean) from public;

-- ------------------------------------------------------------
-- CAMINHO 1 — a venda sozinha
--
-- Contato não encontrado significa cascata: o delete do contato já passou e
-- a trigger BEFORE dele (caminho 2) já avisou, com os dados completos. Sair
-- calado aqui é o que evita o aviso duplicado e pelado.
-- ------------------------------------------------------------
create or replace function public.crm_sale_delete_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact public.crm_contacts;
begin
  select * into v_contact from public.crm_contacts where id = old.contact_id;
  if not found then
    return null;
  end if;

  perform public.crm_sale_deleted_notify(old, v_contact, false);
  return null;
end;
$$;

comment on function public.crm_sale_delete_webhook() is
  'Avisa o n8n quando uma venda é excluída sozinha. Cascata da exclusão do '
  'contato é ignorada aqui — quem avisa é crm_contact_delete_sales_webhook.';

-- AFTER, e não BEFORE: o aviso só vale para linha que de fato saiu.
--
-- O NOME DA TRIGGER IMPORTA. Triggers AFTER da mesma tabela disparam em
-- ordem ALFABÉTICA, e a crm_sales_sync (031) é quem recalcula os totais do
-- contato. "crm_sales_webhook_delete" vem depois de "crm_sales_sync", então o
-- payload leva o contato já sem esta venda. Renomear para algo antes de
-- "crm_sales_sync" faria o webhook mandar totais que incluem a venda
-- excluída — errado, e silenciosamente.
drop trigger if exists crm_sales_webhook_delete on public.crm_sales;
create trigger crm_sales_webhook_delete
  after delete on public.crm_sales
  for each row
  execute function public.crm_sale_delete_webhook();

-- ------------------------------------------------------------
-- CAMINHO 2 — o contato inteiro
--
-- BEFORE DELETE, e é o ponto todo: aqui o contato, as vendas e os eventos
-- ainda estão de pé, então o aviso sai completo. Depois do cascade não teria
-- como — a linha do contato já não existe.
--
-- Um aviso POR VENDA, como na 079: cada um é um estorno distinto, com
-- external_id próprio. Juntar num array só obrigaria o fluxo a desempacotar
-- para fazer o que já faria em duas execuções.
--
-- Contato sem venda nenhuma não gera aviso: o loop não roda.
--
-- UNIFICAR CONTATOS NÃO DISPARA ESTORNO, e não por sorte: a crm_merge_contacts
-- (077) MOVE as vendas para o sobrevivente (passo 1) antes de apagar o
-- descartado (passo 3). Quando esta trigger roda, o cadastro que sai já não
-- tem venda nenhuma e o loop não encontra nada. Inverter essa ordem lá
-- transformaria toda fusão numa enxurrada de estornos falsos.
-- ------------------------------------------------------------
create or replace function public.crm_contact_delete_sales_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale public.crm_sales;
begin
  for v_sale in
    select * from public.crm_sales
    where contact_id = old.id
    order by sold_at, created_at, id
  loop
    perform public.crm_sale_deleted_notify(v_sale, old, true);
  end loop;

  return old;
end;
$$;

comment on function public.crm_contact_delete_sales_webhook() is
  'Avisa o n8n de cada venda que a exclusão de um contato vai levar junto. '
  'BEFORE DELETE porque depois do cascade o contato já não existe para o '
  'payload. Marca deleted_with_contact = true.';

-- BEFORE: é a única janela em que o contato ainda existe. Retorna old para
-- não cancelar a exclusão.
drop trigger if exists crm_contacts_webhook_delete_sales on public.crm_contacts;
create trigger crm_contacts_webhook_delete_sales
  before delete on public.crm_contacts
  for each row
  execute function public.crm_contact_delete_sales_webhook();
