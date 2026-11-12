-- ============================================================
-- Relatórios do CRM filtráveis por canal do WhatsApp
--
-- A aba Relatórios já quebrava conversão por origem e por canal, mas o
-- período era o único filtro global. Aqui adicionamos um p_channel opcional
-- às quatro RPCs de 016, para que todos os blocos (KPIs, série temporal e
-- os dois breakdowns) respondam ao canal escolhido no topo da tela.
--
-- p_channel default null = "todos os canais" — o comportamento antigo. Como
-- o parâmetro tem default, a chamada só com { days } continua resolvendo
-- para estas mesmas funções, então a ordem de deploy migration → frontend
-- não deixa nenhuma janela quebrada.
--
-- Precisamos DROP antes do CREATE porque acrescentar um parâmetro cria uma
-- sobrecarga nova em vez de substituir; manter as duas versões deixaria a
-- chamada por { days } ambígua ("function is not unique").
-- ============================================================

drop function if exists public.crm_report_overview(int);
drop function if exists public.crm_report_timeseries(int);
drop function if exists public.crm_report_by_origem(int);
drop function if exists public.crm_report_by_channel(int);

-- ------------------------------------------------------------
-- Visão geral (KPIs de topo). Uma linha só.
-- ------------------------------------------------------------
create or replace function public.crm_report_overview(days int default 30, p_channel text default null)
returns table(
  total_leads          bigint,
  converted            bigint,
  conversion_rate      numeric,
  revenue_cents        bigint,
  avg_ticket_cents     bigint,
  avg_hours_to_convert numeric
)
language sql stable security definer set search_path = public as $$
  with base as (
    select
      c.value_cents,
      c.created_at,
      (
        select min(h.created_at)
        from public.crm_stage_history h
        join public.crm_stages s on s.id = h.to_stage_id
        where h.contact_id = c.id and s.is_conversion
      ) as converted_at
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and c.created_at >= now() - make_interval(days => days)
      and (p_channel is null or c.channel = p_channel)
  )
  select
    count(*)::bigint,
    count(converted_at)::bigint,
    round(100.0 * count(converted_at) / nullif(count(*), 0), 1),
    coalesce(sum(value_cents) filter (where converted_at is not null), 0)::bigint,
    (coalesce(sum(value_cents) filter (where converted_at is not null), 0)
      / nullif(count(converted_at), 0))::bigint,
    round(
      (avg(extract(epoch from (converted_at - created_at)) / 3600.0)
        filter (where converted_at is not null))::numeric,
      1
    )
  from base;
$$;

-- ------------------------------------------------------------
-- Série temporal: leads que entraram x conversões que aconteceram, por dia.
-- ------------------------------------------------------------
create or replace function public.crm_report_timeseries(days int default 30, p_channel text default null)
returns table(day date, leads bigint, conversions bigint)
language sql stable security definer set search_path = public as $$
  select
    gs::date as day,
    (
      select count(*) from public.crm_contacts c
      where c.organization_id = public.current_org_id()
        and (c.created_at at time zone 'America/Sao_Paulo')::date = gs::date
        and (p_channel is null or c.channel = p_channel)
    ) as leads,
    (
      select count(*) from public.crm_stage_history h
      join public.crm_stages s on s.id = h.to_stage_id
      where h.organization_id = public.current_org_id()
        and s.is_conversion
        and (h.created_at at time zone 'America/Sao_Paulo')::date = gs::date
        and (p_channel is null or exists (
          select 1 from public.crm_contacts c2
          where c2.id = h.contact_id and c2.channel = p_channel
        ))
    ) as conversions
  from generate_series(
    (now() at time zone 'America/Sao_Paulo')::date - (days - 1),
    (now() at time zone 'America/Sao_Paulo')::date,
    interval '1 day'
  ) gs
  order by gs;
$$;

-- ------------------------------------------------------------
-- Conversão por ORIGEM (coorte). Só origens preenchidas.
-- ------------------------------------------------------------
create or replace function public.crm_report_by_origem(days int default 30, p_channel text default null)
returns table(
  origem          text,
  leads           bigint,
  converted       bigint,
  conversion_rate numeric,
  revenue_cents   bigint
)
language sql stable security definer set search_path = public as $$
  select
    c.origem,
    count(*)::bigint,
    count(*) filter (where conv.converted)::bigint,
    round(100.0 * count(*) filter (where conv.converted) / nullif(count(*), 0), 1),
    coalesce(sum(c.value_cents) filter (where conv.converted), 0)::bigint
  from public.crm_contacts c
  cross join lateral (
    select public.crm_has_converted(c.id) as converted
  ) conv
  where c.organization_id = public.current_org_id()
    and c.created_at >= now() - make_interval(days => days)
    and c.origem is not null
    and c.origem <> ''
    and (p_channel is null or c.channel = p_channel)
  group by c.origem
  order by count(*) desc, c.origem;
$$;

-- ------------------------------------------------------------
-- Conversão por CANAL (coorte). Só canais preenchidos. Com p_channel
-- escolhido, a tabela naturalmente mostra só aquele canal.
-- ------------------------------------------------------------
create or replace function public.crm_report_by_channel(days int default 30, p_channel text default null)
returns table(
  channel         text,
  leads           bigint,
  converted       bigint,
  conversion_rate numeric,
  revenue_cents   bigint
)
language sql stable security definer set search_path = public as $$
  select
    c.channel,
    count(*)::bigint,
    count(*) filter (where conv.converted)::bigint,
    round(100.0 * count(*) filter (where conv.converted) / nullif(count(*), 0), 1),
    coalesce(sum(c.value_cents) filter (where conv.converted), 0)::bigint
  from public.crm_contacts c
  cross join lateral (
    select public.crm_has_converted(c.id) as converted
  ) conv
  where c.organization_id = public.current_org_id()
    and c.created_at >= now() - make_interval(days => days)
    and c.channel is not null
    and c.channel <> ''
    and (p_channel is null or c.channel = p_channel)
  group by c.channel
  order by count(*) desc, c.channel;
$$;
