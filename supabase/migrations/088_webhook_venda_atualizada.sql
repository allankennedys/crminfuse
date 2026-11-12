-- ============================================================
-- Aviso ao n8n quando uma venda é ALTERADA
--
-- Irmã da 082 (exclusão) e da 070 (criação): fecha o ciclo de vida da venda
-- do lado de fora. O fluxo do n8n mantém a venda espelhada em outro sistema,
-- e para atualizar lá ele precisa dos dois estados — o antigo para ACHAR o
-- registro, o novo para gravar. Por isso o corpo leva `sale_before` e
-- `sale`, e nunca só o delta.
--
-- O QUE DISPARA
--
--   • valor           (crm_sales.value_cents)
--   • forma de pagamento (crm_sales.payment_method)
--   • data da venda   (crm_sales.sold_at)
--   • dono da venda   — ver abaixo, são dois caminhos
--
-- O QUE NÃO DISPARA, de propósito: criativos, observação, external_id, e
-- tudo que é do contato e não muda de quem é a venda — etiquetas, origem,
-- id de anúncio, etapa, responsável. Mexer nesses campos não altera nada no
-- sistema de destino, e um webhook por edição de etiqueta viraria ruído que
-- o fluxo aprende a ignorar — inclusive quando não devia.
--
-- OS DOIS CAMINHOS DO DONO
--
-- Dono da venda = canal do contato dela (080: um cadastro por número+canal).
-- Ele muda de dois jeitos, e os dois avisam:
--
--   1. O CONTATO troca de canal. Todas as vendas dele mudam de dono de uma
--      vez, então sai um aviso POR VENDA — o mesmo formato do caminho 1, e a
--      mesma escolha da 082 na cascata: o fluxo processa uma venda por
--      execução, sem desempacotar array.
--
--   2. A VENDA muda de contato (crm_sales.contact_id). É como a 077 move
--      venda numa fusão, e é como a tela de mover venda entre canais leva
--      uma venda para o cadastro do outro WhatsApp. Aqui o canal do contato
--      de origem não mudou — mudou de qual cadastro a venda é.
--
-- Nos dois casos `contact_before` e `contact` vêm preenchidos e diferentes;
-- é comparando o `channel` dos dois que o fluxo vê a troca de dono.
--
-- POR QUE PELO BANCO, E NÃO PELO NAVEGADOR
--
-- Mesmo motivo da 068/082: o webhook do n8n não responde CORS, e um fetch do
-- painel morreria no preflight sem ninguém saber. Sendo trigger, também vale
-- para todo caminho de alteração — a tela, a crm-api, a fusão de contatos e
-- o SQL manual.
--
-- ROLLBACK ANULA O AVISO: net.http_post enfileira DENTRO da transação, então
-- update que falhar no meio leva o webhook junto.
--
-- UM AVISO POR LINHA. Update em massa pelo SQL Editor gera um POST por venda
-- tocada. É o preço de ser trigger, e é o mesmo da 082 — se um dia precisar
-- de carga silenciosa, o caminho é `alter table ... disable trigger`, não
-- afrouxar a condição aqui.
--
-- ORDEM DE DEPLOY: esta migration ANTES do frontend de mover venda entre
-- canais. Sem ela a tela funciona e o n8n não fica sabendo. Aplicar pelo SQL
-- Editor. Nunca por db push.
-- ============================================================

-- ------------------------------------------------------------
-- Posição da venda na vida do cliente
--
-- A ordem canônica é (sold_at, created_at, id) — a mesma da 031, 068, 079 e
-- 082. Vira função porque aqui ela é calculada QUATRO vezes por disparo:
-- antes e depois, e o "antes" pode ser em outro contato quando a venda
-- mudou de cadastro.
--
-- `s.id <> p_id` é obrigatório: diferente da 082, a linha ainda existe
-- quando isto roda, e sem o filtro ela contaria a si mesma.
--
-- Ressalva conhecida: num update em massa que mexa no sold_at de várias
-- vendas do mesmo cliente, a posição "antes" é calculada contra as linhas
-- já atualizadas das outras. Não vale a pena versionar a tabela inteira por
-- isso — o campo é contexto, não a chave de nada.
-- ------------------------------------------------------------
create or replace function public.crm_sale_position(
  p_contact    uuid,
  p_sold_at    timestamptz,
  p_created_at timestamptz,
  p_id         uuid
)
returns int
language sql
stable
set search_path = public
as $$
  select count(*)::int + 1
  from public.crm_sales s
  where s.contact_id = p_contact
    and s.id <> p_id
    and (s.sold_at, s.created_at, s.id) < (p_sold_at, p_created_at, p_id);
$$;

comment on function public.crm_sale_position(uuid, timestamptz, timestamptz, uuid) is
  'Posição da venda entre as do mesmo contato, na ordem canônica '
  '(sold_at, created_at, id). 1 = é a primeira, a que leva ao funil.';

revoke all on function public.crm_sale_position(uuid, timestamptz, timestamptz, uuid) from public;

-- ------------------------------------------------------------
-- A venda em jsonb
--
-- Existe para os dois estados saírem com a MESMA forma. Escrever o objeto
-- duas vezes na função de aviso seria garantir que um dia divergissem, e um
-- `sale_before` com campo a menos que `sale` é exatamente o tipo de coisa
-- que o outro lado só descobre em produção.
-- ------------------------------------------------------------
create or replace function public.crm_sale_webhook_json(
  p_sale     public.crm_sales,
  p_position int
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_author text;
begin
  select coalesce(nullif(trim(u.full_name), ''), u.email) into v_author
  from public.users u where u.id = p_sale.created_by;

  return jsonb_build_object(
    'id', p_sale.id,
    -- A CHAVE DA CONCILIAÇÃO: id do pedido no sistema de origem (036). Nulo
    -- nas vendas lançadas à mão, que nunca tiveram um.
    'external_id', p_sale.external_id,
    'contact_id', p_sale.contact_id,
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
    -- Mudar a data pode trocar QUAL venda é a primeira, e a primeira é a que
    -- levou o contato ao funil e virou conversão na Meta. Por isso a posição
    -- vem nos dois estados, e não uma vez só no topo.
    'sale_number', p_position,
    'was_first_sale', p_position = 1,
    'created_at', p_sale.created_at,
    'created_by', p_sale.created_by,
    'created_by_name', v_author
  );
end;
$$;

comment on function public.crm_sale_webhook_json(public.crm_sales, int) is
  'A venda no formato do webhook, com rótulo de pagamento e posição na vida '
  'do cliente. Usada nos dois estados (antes/depois) do aviso de alteração.';

revoke all on function public.crm_sale_webhook_json(public.crm_sales, int) from public;

-- ------------------------------------------------------------
-- O contato em jsonb — mesmos campos da 082, pelo mesmo motivo
-- ------------------------------------------------------------
create or replace function public.crm_contact_webhook_json(p_contact public.crm_contacts)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_stage    public.crm_stages;
  v_assignee text;
begin
  if p_contact.id is null then
    return null;
  end if;

  select * into v_stage from public.crm_stages where id = p_contact.stage_id;

  select coalesce(nullif(trim(u.full_name), ''), u.email) into v_assignee
  from public.users u where u.id = p_contact.assigned_to;

  return jsonb_build_object(
    'id', p_contact.id,
    'name', p_contact.name,
    'phone', p_contact.phone,
    -- A identidade do número (069): mesma forma para as quatro grafias que
    -- circulam. É por ela que o n8n casa o contato com a conversa.
    'phone_id', public.crm_phone_id(p_contact.phone),
    'email', p_contact.email,
    -- É ESTE campo que diz de quem é a venda.
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
    'sales_count', p_contact.sales_count,
    'first_sale_value_cents', p_contact.value_cents,
    'sales_total_cents', p_contact.sales_total_cents,
    'sales_total', round(p_contact.sales_total_cents::numeric / 100, 2)
  );
end;
$$;

comment on function public.crm_contact_webhook_json(public.crm_contacts) is
  'O contato no formato dos webhooks de venda. Mesmos campos da 082.';

revoke all on function public.crm_contact_webhook_json(public.crm_contacts) from public;

-- ------------------------------------------------------------
-- O corpo e o POST, num lugar só
--
-- Os dois caminhos mandam o MESMO payload. Recebe os quatro registros já
-- lidos por quem chama, porque só o chamador sabe de onde veio a mudança.
--
-- security definer: o schema net não é acessível ao usuário autenticado, e o
-- corpo junta etapa, autor e evento da Meta — leituras que a RLS recusaria
-- em cascata. A linha só chega até aqui depois de a RLS ter autorizado o
-- UPDATE, então não há o que checar de novo.
-- ------------------------------------------------------------
create or replace function public.crm_sale_updated_notify(
  p_before         public.crm_sales,
  p_after          public.crm_sales,
  p_contact_before public.crm_contacts,
  p_contact_after  public.crm_contacts,
  p_changed        text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url constant text :=
    'https://n8n-n8n.40lgqg.easypanel.host/webhook/687f320b-6797-44b1-b578-cc41001bccb0-atualizar-venda';
  v_event public.crm_events;
  v_actor text;
  v_body  jsonb;
begin
  -- O evento de conversão desta venda (072). Diz se a Meta já contabilizou o
  -- Purchase com o valor ANTIGO: status 'sent' significa que a correção aqui
  -- não a alcança mais. 'pending' ainda escoa com o valor novo (042).
  select * into v_event
  from public.crm_events
  where sale_id = p_after.id and event_type = 'conversion'
  order by created_at desc
  limit 1;

  select coalesce(nullif(trim(u.full_name), ''), u.email) into v_actor
  from public.users u where u.id = auth.uid();

  v_body := jsonb_build_object(
    'event', 'venda_atualizada',
    'sent_at', now(),
    'organization_id', p_after.organization_id,
    -- Quais campos mudaram, para o fluxo não precisar comparar os dois
    -- objetos campo a campo. 'channel' aqui significa TROCA DE DONO.
    'changed', to_jsonb(p_changed),
    'owner_changed', p_changed @> array['channel'],
    -- Quem editou. Nulo quando veio de fora de uma sessão autenticada
    -- (SQL manual, service role, automação).
    'updated_by', auth.uid(),
    'updated_by_name', v_actor,
    -- OS DOIS ESTADOS. `sale_before` é para o fluxo ACHAR o registro do outro
    -- lado (external_id, ou valor+data se não houver); `sale` é o que ele
    -- grava. Mesma forma nos dois, sempre.
    'sale_before', public.crm_sale_webhook_json(
      p_before,
      public.crm_sale_position(p_before.contact_id, p_before.sold_at, p_before.created_at, p_before.id)
    ),
    'sale', public.crm_sale_webhook_json(
      p_after,
      public.crm_sale_position(p_after.contact_id, p_after.sold_at, p_after.created_at, p_after.id)
    ),
    -- O cadastro dono da venda, antes e depois. Iguais quando a mudança foi
    -- só no dinheiro. Diferentes quando a venda trocou de dono — é o
    -- `channel` dos dois que o fluxo compara.
    --
    -- Ressalva: os TOTAIS do contato (sales_count, sales_total_cents) já vêm
    -- recalculados nos dois, porque a crm_sales_sync (031) roda antes desta
    -- trigger. Quem precisa do total anterior o reconstrói a partir de
    -- sale_before.value_cents; o que é fiel nos dois é a identidade, e é
    -- dela que sai o dono.
    'contact_before', public.crm_contact_webhook_json(p_contact_before),
    'contact', public.crm_contact_webhook_json(p_contact_after),
    -- O que a Meta já sabe desta venda. null = nunca virou evento.
    'meta_event', case when v_event.id is null then null else jsonb_build_object(
      'id', v_event.id,
      'status', v_event.status,
      'sent_at', v_event.sent_at,
      'ad_source', v_event.payload->>'ad_source'
    ) end
  );

  perform net.http_post(
    url := v_url,
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := v_body,
    -- 15s, como na 068/070/079/082: o tempo é do processo de background do
    -- pg_net, não de quem clicou em salvar — a tela não espera por isto.
    timeout_milliseconds := 15000
  );
end;
$$;

comment on function public.crm_sale_updated_notify(public.crm_sales, public.crm_sales, public.crm_contacts, public.crm_contacts, text[]) is
  'Monta e envia ao n8n o aviso de venda alterada, com o estado antes e '
  'depois. Chamada pelas triggers de update de venda e de canal do contato — '
  'não é para ser chamada à mão.';

revoke all on function public.crm_sale_updated_notify(public.crm_sales, public.crm_sales, public.crm_contacts, public.crm_contacts, text[]) from public;

-- ------------------------------------------------------------
-- CAMINHO 1 — a venda mudou
--
-- Só os quatro campos que interessam. Criativos, observação e external_id
-- passam batido de propósito: não mudam nada no sistema de destino.
--
-- MUDAR DE CONTATO SÓ CONTA SE MUDAR DE CANAL. É a regra do pedido: o dono
-- da venda é o canal, não o cadastro. Fusão de duplicados (077) move as
-- vendas entre cadastros do MESMO canal — dono nenhum mudou ali, e avisar
-- transformaria toda limpeza de base numa enxurrada de atualizações que o
-- fluxo processaria à toa.
-- ------------------------------------------------------------
create or replace function public.crm_sale_update_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed text[] := '{}';
  v_moved   boolean := new.contact_id is distinct from old.contact_id;
  v_antes   public.crm_contacts;
  v_depois  public.crm_contacts;
begin
  if new.value_cents is distinct from old.value_cents then
    v_changed := v_changed || 'value_cents';
  end if;
  if new.payment_method is distinct from old.payment_method then
    v_changed := v_changed || 'payment_method';
  end if;
  if new.sold_at is distinct from old.sold_at then
    v_changed := v_changed || 'sold_at';
  end if;

  select * into v_depois from public.crm_contacts where id = new.contact_id;

  if v_moved then
    select * into v_antes from public.crm_contacts where id = old.contact_id;
    -- crm_channel_key (069): compara sem caixa e sem espaço nas pontas, a
    -- mesma chave do índice único. "PH" e "ph " são o mesmo dono.
    if public.crm_channel_key(v_antes.channel)
       is distinct from public.crm_channel_key(v_depois.channel) then
      v_changed := v_changed || 'channel';
    end if;
  else
    v_antes := v_depois;
  end if;

  -- Nada que interesse mudou. Sai calado.
  if array_length(v_changed, 1) is null then
    return null;
  end if;

  -- A venda trocou de cadastro E há motivo para avisar: registra o
  -- movimento, mesmo quando o canal é o mesmo.
  if v_moved then
    v_changed := v_changed || 'contact_id';
  end if;

  perform public.crm_sale_updated_notify(old, new, v_antes, v_depois, v_changed);
  return null;
end;
$$;

comment on function public.crm_sale_update_webhook() is
  'Avisa o n8n quando valor, forma de pagamento, data ou canal de uma venda '
  'mudam. Criativos, observação e troca de cadastro dentro do mesmo canal '
  'não avisam.';

-- AFTER, não BEFORE: o aviso só vale para alteração que de fato gravou.
--
-- O NOME DA TRIGGER IMPORTA, pelo mesmo motivo da 082. Triggers AFTER da
-- mesma tabela disparam em ordem ALFABÉTICA, e a crm_sales_sync (031) é quem
-- recalcula os totais do contato. "crm_sales_webhook_update" vem depois de
-- "crm_sales_sync", então o payload leva o contato já recalculado. Renomear
-- para algo antes de "crm_sales_sync" faria o aviso sair com totais velhos.
drop trigger if exists crm_sales_webhook_update on public.crm_sales;
create trigger crm_sales_webhook_update
  after update on public.crm_sales
  for each row
  execute function public.crm_sale_update_webhook();

-- ------------------------------------------------------------
-- CAMINHO 2 — o contato trocou de canal
--
-- Todas as vendas do cadastro mudam de dono de uma vez. Um aviso POR VENDA,
-- como a 082 faz na cascata: cada venda é uma atualização distinta do outro
-- lado, com external_id próprio. Juntar num array só obrigaria o fluxo a
-- desempacotar para fazer o que já faria em N execuções.
--
-- A venda em si não mudou, então `sale_before` e `sale` saem iguais — o que
-- difere é `contact_before.channel` contra `contact.channel`.
--
-- Cadastro sem venda nenhuma não gera aviso: o loop não roda.
-- ------------------------------------------------------------
create or replace function public.crm_contact_channel_sales_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale public.crm_sales;
begin
  if public.crm_channel_key(new.channel)
     is not distinct from public.crm_channel_key(old.channel) then
    return null;
  end if;

  for v_sale in
    select * from public.crm_sales where contact_id = new.id
  loop
    perform public.crm_sale_updated_notify(v_sale, v_sale, old, new, array['channel']);
  end loop;

  return null;
end;
$$;

comment on function public.crm_contact_channel_sales_webhook() is
  'Avisa o n8n, uma vez por venda, quando o contato troca de canal — todas '
  'as vendas dele mudam de dono junto.';

drop trigger if exists crm_contacts_webhook_channel on public.crm_contacts;
create trigger crm_contacts_webhook_channel
  after update of channel on public.crm_contacts
  for each row
  execute function public.crm_contact_channel_sales_webhook();
