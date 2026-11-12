-- ============================================================
-- Remove o que era da operação da PH e refaz a Jornada com o que o CRM
-- rastreia sozinho
--
-- SAI:
--   • Utmify (097/096): fila, gatilho, credencial e o processo agendado
--   • resumos de anúncios para o n8n (078/086/094): processos agendados
--     (as funções ads-daily/ads-campaigns também saem do projeto)
--   • avisos de venda para o n8n e de reembolso para o sistema de comissão
--     (068/070/079/082/088/104) e a tabela de URLs (041)
--   • portfólio (091) e a Jornada antiga, que lia as etiquetas do robô da
--     PH num banco externo (060–064, 083–092) e a tabela conversation_messages
--   • ID de venda da Kirvano (105) e o "papel na jornada" das etapas (060)
--   • lista de grupos por número (067): o painel de grupos não existe aqui
--
-- FICA E É RENOMEADO: os processos agendados que são do produto (status
-- dos números, conversões para a Meta, arquivar convertidos, automações
-- de etapa) perdem o prefixo "ph-groups".
--
-- ENTRA: crm_journey_native — a Jornada só com etapas do funil, conversas
-- do WhatsApp, vendas e origem.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Processos agendados
-- ------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select jobname from cron.job
    where jobname in ('ph-groups-utmify-worker', 'ph-groups-ads-daily', 'ph-groups-ads-campaigns', 'ph-groups-discovery')
  loop
    perform cron.unschedule(r.jobname);
  end loop;

  for r in
    select v.old_name, v.new_name, j.schedule, j.command
    from (values
      ('ph-groups-worker', 'whatsapp-worker'),
      ('ph-groups-crm-worker', 'crm-meta-worker'),
      ('ph-groups-crm-archive-converted', 'crm-archive-converted'),
      ('ph-groups-crm-stage-automations', 'crm-stage-automations')
    ) v(old_name, new_name)
    join cron.job j on j.jobname = v.old_name
  loop
    perform cron.schedule(r.new_name, r.schedule, r.command);
    perform cron.unschedule(r.old_name);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 2. Gatilhos de integração da PH
-- ------------------------------------------------------------
drop trigger if exists crm_events_merge_webhook on public.crm_events;
drop trigger if exists crm_contacts_webhook_delete_sales on public.crm_contacts;
drop trigger if exists crm_sales_webhook_delete on public.crm_sales;
drop trigger if exists crm_contacts_webhook_channel on public.crm_contacts;
drop trigger if exists crm_sales_webhook_update on public.crm_sales;
drop trigger if exists crm_contacts_refund_webhook_channel on public.crm_contacts;
drop trigger if exists crm_sales_refund_webhook on public.crm_sales;
drop trigger if exists trg_crm_sales_utmify on public.crm_sales;

-- ------------------------------------------------------------
-- 3. Funções (todas as versões de cada nome)
-- ------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (
        p.proname = any (array[
          'crm_sale_webhook', 'crm_sale_webhook_status', 'crm_merge_conversion_webhook',
          'crm_contact_delete_sales_webhook', 'crm_sale_deleted_notify', 'crm_sale_delete_webhook',
          'crm_contact_channel_sales_webhook', 'crm_contact_webhook_json', 'crm_sale_position',
          'crm_sale_updated_notify', 'crm_sale_update_webhook', 'crm_sale_webhook_json',
          'crm_contact_channel_refund_webhook', 'crm_refund_notify', 'crm_sale_refund_webhook',
          'crm_utmify_enfileirar', 'crm_utmify_pedido', 'crm_portfolio_register',
          'crm_first_human_touch', 'integration_url',
          'request_group_discovery', 'discovery_retry_or_fail', 'process_group_discovery'
        ])
        or p.proname like 'crm_report_journey%'
      )
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 4. Tabelas e colunas
-- ------------------------------------------------------------
drop table if exists public.crm_utmify_queue cascade;
drop table if exists public.crm_refund_notifications cascade;
drop table if exists public.crm_portfolio_entries cascade;
drop table if exists public.conversation_messages cascade;
drop table if exists public.integration_urls cascade;
drop table if exists public.group_discovery cascade;
drop table if exists public.session_groups cascade;

alter table public.crm_settings drop column if exists utmify_api_token;
alter table public.crm_sales drop column if exists kirvano_sale_id cascade;
alter table public.crm_stages drop column if exists journey_role cascade;

-- ------------------------------------------------------------
-- 5. "Ganho" azul (o pedido foi trocar todo verde por azul)
-- ------------------------------------------------------------
update public.crm_stages set color = '#2f8cff' where lower(color) = '#22c55e';

do $$
declare
  v_def text;
begin
  select pg_get_functiondef('public.crm_bootstrap()'::regprocedure) into v_def;
  if position('#22c55e' in v_def) > 0 then
    execute replace(v_def, '#22c55e', '#2f8cff');
  end if;
end $$;

-- ------------------------------------------------------------
-- 6. Jornada nativa
--
-- Coorte = contatos criados no período (mesmo recorte da aba Funil). Para
-- cada um, o que o próprio sistema registrou:
--   etapas .... por quais colunas passou (histórico + etapa atual) e quanto
--               tempo levou para chegar em cada uma
--   conversa .. se tem conversa no WhatsApp, se foi respondido, em quanto
--               tempo, quantas mensagens até comprar, e onde está parado
--   vendas .... se comprou, quanto, e em quanto tempo
--   origem .... conversão e receita por origem
-- ------------------------------------------------------------
create or replace function public.crm_journey_native(
  p_from date,
  p_to date,
  p_channel text default null,
  p_origem text default null
)
returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_org uuid := public.current_org_id();
  v_ini timestamptz := (p_from::timestamp at time zone 'America/Sao_Paulo');
  v_fim timestamptz := ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo');
  v     jsonb;
begin
  if not exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'admin' and u.is_active
  ) then
    raise exception 'Relatório disponível só para administradores';
  end if;

  with
  st as (
    select s.id, s.name, s.color, s.position, s.is_conversion
    from public.crm_stages s where s.organization_id = v_org
  ),
  coorte as (
    select c.id, c.created_at, c.stage_id,
           coalesce(nullif(btrim(c.origem), ''), 'Sem origem') as origem,
           coalesce(c.sales_total_cents, 0) as receita
    from public.crm_contacts c
    where c.organization_id = v_org
      and c.created_at >= v_ini and c.created_at < v_fim
      and (p_channel is null or public.crm_channel_key(c.channel) = public.crm_channel_key(p_channel))
      and (p_origem is null
           or lower(extensions.unaccent(coalesce(nullif(btrim(c.origem), ''), 'Sem origem')))
              = lower(extensions.unaccent(btrim(p_origem))))
  ),
  passagens as (
    select x.contact_id, x.stage_id, min(x.em) as em
    from (
      select h.contact_id, h.to_stage_id as stage_id, h.created_at as em
      from public.crm_stage_history h join coorte k on k.id = h.contact_id
      where h.to_stage_id is not null
      union all
      select k.id, k.stage_id, k.created_at from coorte k where k.stage_id is not null
    ) x
    group by 1, 2
  ),
  venda1 as (
    select s.contact_id, min(s.sold_at) as em
    from public.crm_sales s join coorte k on k.id = s.contact_id
    group by 1
  ),
  convertidos as (
    select k.id from coorte k
    where exists (select 1 from venda1 v where v.contact_id = k.id)
       or exists (select 1 from passagens p join st on st.id = p.stage_id where p.contact_id = k.id and st.is_conversion)
  ),
  -- A conversa de cada lead (a mais antiga, se houver mais de uma).
  conv as (
    select distinct on (k.id) k.id as contact_id, wc.id as conversation_id
    from coorte k join public.wa_conversations wc on wc.contact_id = k.id
    order by k.id, wc.created_at
  ),
  ticket1 as (
    select distinct on (c.contact_id) c.contact_id, t.opened_at, t.first_response_at
    from conv c join public.wa_tickets t on t.conversation_id = c.conversation_id
    order by c.contact_id, t.opened_at
  ),
  ultima as (
    select distinct on (c.contact_id) c.contact_id, m.from_me, m.wa_timestamp
    from conv c join public.wa_messages m on m.conversation_id = c.conversation_id
    where m.type <> 'reaction'
    order by c.contact_id, m.wa_timestamp desc
  )
  select jsonb_build_object(
    'resumo', jsonb_build_object(
      'leads', (select count(*) from coorte),
      'convertidos', (select count(*) from convertidos),
      'receita_cents', (select coalesce(sum(k.receita), 0) from coorte k join convertidos c on c.id = k.id),
      'dias_ate_compra', (
        select round((avg(extract(epoch from v.em - k.created_at)) / 86400)::numeric, 1)
        from venda1 v join coorte k on k.id = v.contact_id where v.em >= k.created_at
      ),
      'dias_ate_compra_mediana', (
        select round((percentile_cont(0.5) within group (order by extract(epoch from v.em - k.created_at)) / 86400)::numeric, 1)
        from venda1 v join coorte k on k.id = v.contact_id where v.em >= k.created_at
      ),
      'com_conversa', (select count(*) from conv),
      'respondidos', (select count(*) from ticket1 where first_response_at is not null),
      'tpr_min', (
        select round((avg(extract(epoch from first_response_at - opened_at)) / 60)::numeric, 1)
        from ticket1 where first_response_at is not null and first_response_at >= opened_at
      ),
      'msgs_ate_compra', (
        select round(avg(n)::numeric, 1) from (
          select (select count(*) from public.wa_messages m
                  where m.conversation_id = c.conversation_id and m.type <> 'reaction' and m.wa_timestamp <= v.em) as n
          from conv c join venda1 v on v.contact_id = c.contact_id
        ) x
      ),
      -- Não comprou e a última palavra foi nossa há mais de 24 h: o cliente sumiu.
      'aguardando_cliente', (
        select count(*) from ultima u
        where u.from_me and u.wa_timestamp < now() - interval '24 hours'
          and u.contact_id not in (select id from convertidos)
      ),
      -- Não comprou e a última palavra foi do cliente: está esperando a gente.
      'aguardando_equipe', (
        select count(*) from ultima u
        where not u.from_me and u.contact_id not in (select id from convertidos)
      )
    ),
    'etapas', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', st.id, 'nome', st.name, 'cor', st.color, 'conversao', st.is_conversion,
        'passaram', (select count(*) from passagens p where p.stage_id = st.id),
        'agora', (select count(*) from coorte k where k.stage_id = st.id),
        'dias_ate', (
          select round((avg(extract(epoch from p.em - k.created_at)) / 86400)::numeric, 1)
          from passagens p join coorte k on k.id = p.contact_id
          where p.stage_id = st.id and p.em > k.created_at
        )
      ) order by st.position), '[]'::jsonb)
      from st
    ),
    'por_origem', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'origem', o.origem, 'leads', o.leads, 'convertidos', o.conv, 'receita_cents', o.receita
      ) order by o.leads desc), '[]'::jsonb)
      from (
        select k.origem, count(*) as leads,
               count(c.id) as conv,
               coalesce(sum(k.receita) filter (where c.id is not null), 0) as receita
        from coorte k left join convertidos c on c.id = k.id
        group by k.origem
      ) o
    )
  ) into v;

  return v;
end;
$$;

revoke all on function public.crm_journey_native(date, date, text, text) from public, anon;
grant execute on function public.crm_journey_native(date, date, text, text) to authenticated;
