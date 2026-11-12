-- ============================================================
-- CRM — Funções de relatório (aba Relatórios)
--
-- Mesmo padrão do dashboard (007): agregações no banco, `security
-- definer`, isolamento por public.current_org_id(), datas no fuso
-- America/Sao_Paulo para bater com o "hoje" do usuário.
--
-- Definição de CONVERSÃO usada em todo o arquivo: o contato entrou, em
-- algum momento, numa etapa marcada como conversão (is_conversion). A
-- prova é uma linha em crm_stage_history apontando para essa etapa —
-- durável mesmo que o contato seja depois movido para outra coluna, e
-- independente de o card estar ou não no funil agora.
--
-- Definição de TAXA DE CONVERSÃO: coorte por criação. Dos leads criados
-- no período, a fração que converteu (a qualquer tempo). Dá uma taxa
-- real ≤ 100%, em vez de dividir dois fluxos diferentes (leads que
-- entraram ÷ conversões que aconteceram), que pode passar de 100% e
-- engana. É a leitura honesta de "quanto do que entrou virou venda".
-- ============================================================

-- Um contato converteu? (subconsulta reaproveitada pelos relatórios)
-- Encapsula a regra num só lugar: se a definição mudar, muda aqui.
create or replace function public.crm_has_converted(p_contact uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.crm_stage_history h
    join public.crm_stages s on s.id = h.to_stage_id
    where h.contact_id = p_contact
      and s.is_conversion
  );
$$;

-- ------------------------------------------------------------
-- Visão geral (KPIs de topo). Uma linha só.
-- ------------------------------------------------------------
create or replace function public.crm_report_overview(days int default 30)
returns table(
  total_leads          bigint,
  converted            bigint,
  conversion_rate      numeric,   -- % (uma casa), null se não houve lead
  revenue_cents        bigint,    -- soma do valor dos convertidos
  avg_ticket_cents     bigint,    -- ticket médio dos convertidos
  avg_hours_to_convert numeric    -- tempo médio criação → 1ª conversão (h)
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
-- Série temporal: leads que entraram x conversões que aconteceram,
-- por dia. Série completa (dias sem movimento viram zero).
--
-- Aqui é FLUXO por dia (não coorte): mostra o volume ao longo do tempo,
-- não a taxa da coorte. As duas linhas respondem perguntas diferentes e
-- o gráfico deixa isso claro rotulando "Leads" e "Conversões".
-- ------------------------------------------------------------
create or replace function public.crm_report_timeseries(days int default 30)
returns table(day date, leads bigint, conversions bigint)
language sql stable security definer set search_path = public as $$
  select
    gs::date as day,
    (
      select count(*) from public.crm_contacts c
      where c.organization_id = public.current_org_id()
        and (c.created_at at time zone 'America/Sao_Paulo')::date = gs::date
    ) as leads,
    (
      select count(*) from public.crm_stage_history h
      join public.crm_stages s on s.id = h.to_stage_id
      where h.organization_id = public.current_org_id()
        and s.is_conversion
        and (h.created_at at time zone 'America/Sao_Paulo')::date = gs::date
    ) as conversions
  from generate_series(
    (now() at time zone 'America/Sao_Paulo')::date - (days - 1),
    (now() at time zone 'America/Sao_Paulo')::date,
    interval '1 day'
  ) gs
  order by gs;
$$;

-- ------------------------------------------------------------
-- Conversão por ORIGEM (coorte). Só origens preenchidas: contatos sem
-- origem não entram — é o "contando apenas os disponíveis". Ordena da
-- origem com mais leads para a com menos.
-- ------------------------------------------------------------
create or replace function public.crm_report_by_origem(days int default 30)
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
  group by c.origem
  order by count(*) desc, c.origem;
$$;

-- ------------------------------------------------------------
-- Conversão por CANAL (coorte). Mesmo desenho da origem; só canais
-- preenchidos entram.
-- ------------------------------------------------------------
create or replace function public.crm_report_by_channel(days int default 30)
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
  group by c.channel
  order by count(*) desc, c.channel;
$$;
