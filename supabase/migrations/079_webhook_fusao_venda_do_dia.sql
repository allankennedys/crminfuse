-- ============================================================
-- Aviso ao n8n quando uma unificação enfileira venda DE HOJE para a Meta
--
-- Unificar dois cadastros pode desenterrar uma venda que nunca tinha sido
-- enviada — a que nasceu no cadastro sem clique de anúncio e só agora
-- encontrou o dono certo. A 077 enfileira essas vendas no passo 7
-- (crm_enqueue_pending_conversions com source 'fusao'); daí em diante quem
-- decide é o crm-worker, no ciclo de 30 minutos.
--
-- Esta migration avisa o n8n no momento do enfileiramento, e SÓ quando a
-- venda é do dia corrente em São Paulo.
--
-- POR QUE SÓ AS DE HOJE
--
-- A régua não é preferência: é a janela de 7 dias da Conversions API. O
-- worker (crm-worker/index.ts, eventTime) manda a data real da venda quando
-- ela cabe na janela e, quando não cabe, manda o instante do enfileiramento
-- — a compra entra no Gerenciador com a data errada, mas entra. Venda de
-- hoje é o único caso em que a data que chega à Meta é, com certeza, a data
-- que o relatório de Vendas mostra. É esse o recorte que o fluxo do n8n pede.
--
-- Vendas mais antigas continuam sendo enfileiradas e enviadas como sempre.
-- Elas só não geram aviso.
--
-- POR QUE UMA TRIGGER, E NÃO UMA LINHA DENTRO DA crm_merge_contacts
--
-- A condição inteira cabe na linha que acabou de ser inserida em crm_events,
-- e a alternativa custaria reescrever as ~150 linhas da crm_merge_contacts
-- só para acrescentar uma chamada no fim — toda ela reexposta a erro de
-- transcrição, numa função que apaga cadastro e mexe no que já foi à Meta.
--
-- O WHEN é o filtro barato: `source = 'fusao'` é gravado no payload apenas
-- pela unificação manual da 077 (é o único lugar do banco que passa esse
-- valor). Os outros caminhos de conversão — etapa, venda manual, landing,
-- API — inserem em crm_events com outro source e não chegam a executar a
-- função.
--
-- ROLLBACK ANULA O AVISO
--
-- O net.http_post enfileira DENTRO da transação: a unificação que falhar no
-- meio leva o webhook junto, e o n8n não recebe aviso de fusão que não
-- aconteceu. É o mesmo comportamento da 068/070.
--
-- UM AVISO POR VENDA
--
-- Fusão que enfileira duas vendas de hoje dispara dois webhooks, um por
-- venda. Cada um representa um Purchase distinto a caminho da Meta, com
-- sale_id próprio — juntar os dois num aviso só obrigaria o fluxo a
-- desempacotar array para fazer o que já faria em duas execuções.
--
-- ATENÇÃO: "VAI PARA A META", NÃO "FOI"
--
-- No instante deste aviso o evento está `pending`. Quem envia é o worker, em
-- até 30 minutos, e o resultado ainda pode ser `failed` (a Meta recusou) ou
-- `skipped` (o cliente que ficou não qualifica como anúncio). Este webhook
-- diz que a venda ENTROU NA FILA. Para o resultado confirmado, o gancho
-- teria de ser na virada para `sent`, que é outra coisa.
-- ============================================================

-- ------------------------------------------------------------
-- >>> PREENCHA A URL ANTES DE APLICAR <<<
--
-- Sem uma URL de webhook válida a função posta no vazio e o pg_net registra
-- a falha em silêncio, de fusão em fusão. Troque a constante v_url abaixo
-- pela URL do webhook do n8n (o painel do n8n mostra a de produção no nó
-- "Webhook"), no mesmo formato da 070:
--
--   https://SEU-N8N/webhook/<id>-<nome-do-fluxo>  (Infuse: cadastre em integration_urls, 041)
-- ------------------------------------------------------------

create or replace function public.crm_merge_conversion_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Infuse: a URL vem de integration_urls (041); sem cadastro, não envia.
  v_url constant text := public.integration_url('n8n_fusao_venda_do_dia');
  v_sale     public.crm_sales;
  v_contact  public.crm_contacts;
  v_stage    public.crm_stages;
  v_seq      int;
  v_total    int;
  v_body     jsonb;
begin
  select * into v_sale from public.crm_sales where id = new.sale_id;
  if not found then
    return null;
  end if;

  -- O CORTE DO DIA. `sold_at` é timestamptz e o dia é o de São Paulo, como
  -- em todo o resto do CRM (007, 016): comparar em UTC jogaria a venda das
  -- 21h30 para o dia seguinte e o aviso não sairia.
  if (v_sale.sold_at at time zone 'America/Sao_Paulo')::date
     is distinct from (now() at time zone 'America/Sao_Paulo')::date then
    return null;
  end if;

  select * into v_contact from public.crm_contacts where id = new.contact_id;
  if not found then
    return null;
  end if;

  select * into v_stage from public.crm_stages where id = v_contact.stage_id;

  select count(*) into v_total
  from public.crm_sales where contact_id = v_contact.id;

  -- Posição desta venda na vida do cliente, na mesma ordem canônica da 031
  -- (sold_at, created_at, id). Depois da fusão ela conta as duas bases
  -- juntas: é justamente isso que o fluxo precisa saber para não tratar
  -- como primeira compra quem já comprava pelo outro cadastro.
  select count(*) into v_seq
  from public.crm_sales s
  where s.contact_id = v_contact.id
    and (s.sold_at, s.created_at, s.id) <= (v_sale.sold_at, v_sale.created_at, v_sale.id);

  v_body := jsonb_build_object(
    'event', 'fusao_conversao_do_dia',
    'sent_at', now(),
    'organization_id', new.organization_id,
    -- Id do evento na fila, para o fluxo conseguir consultar o desfecho
    -- depois (crm_events.status) em vez de supor que foi enviado.
    'event_id', new.id,
    -- Por qual caminho a conversão vai à Meta: 'ctwa', 'site' ou 'origem'.
    'ad_source', new.payload->>'ad_source',
    'is_first_sale', v_seq = 1,
    'sale_number', v_seq,
    'sale', jsonb_build_object(
      'id', v_sale.id,
      'value_cents', v_sale.value_cents,
      -- Já em reais para o fluxo não ter que dividir por 100 do outro lado.
      'value', round(v_sale.value_cents::numeric / 100, 2),
      'creatives', v_sale.creatives,
      'sold_at', v_sale.sold_at,
      'note', v_sale.note,
      'external_id', v_sale.external_id,
      'payment_method', v_sale.payment_method,
      'payment_method_label', case v_sale.payment_method
        when 'pix'     then 'Pix'
        when 'credito' then 'Crédito'
        when 'debito'  then 'Débito'
        when 'boleto'  then 'Boleto'
        else null
      end,
      'created_at', v_sale.created_at
    ),
    'contact', jsonb_build_object(
      'id', v_contact.id,
      'name', v_contact.name,
      'phone', v_contact.phone,
      -- A identidade do número (069): mesma forma para as quatro grafias
      -- que circulam. É por ela que o n8n casa o contato com a conversa.
      'phone_id', public.crm_phone_id(v_contact.phone),
      'email', v_contact.email,
      'channel', v_contact.channel,
      'origem', v_contact.origem,
      'ctwaclid', v_contact.ctwaclid,
      'campaign_id', v_contact.campaign_id,
      'conversation_id', v_contact.conversation_id,
      'stage_id', v_contact.stage_id,
      'stage_name', v_stage.name,
      'created_at', v_contact.created_at,
      'sales_count', v_total,
      'sales_total_cents', v_contact.sales_total_cents,
      'sales_total', round(v_contact.sales_total_cents::numeric / 100, 2)
    )
  );

  if v_url is null then
    return null;
  end if;

  perform net.http_post(
    url := v_url,
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := v_body,
    -- 15s, como na 070: o tempo é do processo de background do pg_net, não
    -- de quem clicou em unificar — a tela não espera por isto.
    timeout_milliseconds := 15000
  );

  return null;
end;
$$;

comment on function public.crm_merge_conversion_webhook() is
  'Avisa o n8n quando a unificação de contatos (077) enfileira para a Meta '
  'uma venda do dia corrente. Só as de hoje: fora da janela de 7 dias da '
  'Conversions API o worker manda a data do enfileiramento, não a da venda.';

-- AFTER, e não BEFORE: o aviso só faz sentido para linha que ficou gravada.
-- Retorna null porque é AFTER FOR EACH ROW — o valor é ignorado.
drop trigger if exists crm_events_merge_webhook on public.crm_events;
create trigger crm_events_merge_webhook
  after insert on public.crm_events
  for each row
  when (
    new.payload->>'source' = 'fusao'
    and new.event_type = 'conversion'
    and new.sale_id is not null
    and new.status = 'pending'
  )
  execute function public.crm_merge_conversion_webhook();
