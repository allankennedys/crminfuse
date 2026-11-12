-- ============================================================
-- PH Groups — Funções de relatório do Dashboard
--
-- Agregações rodam no banco (não no navegador): preciso a qualquer
-- volume e sem esbarrar no limite de 1000 linhas do PostgREST.
--
-- Todas são `security definer` e filtram por public.current_org_id(),
-- seguindo o mesmo padrão de isolamento por organização do schema.
-- Datas/horas são agrupadas no fuso America/Sao_Paulo (mesmo default
-- dos agendamentos), para bater com o "hoje" do usuário brasileiro.
-- ============================================================

-- Envios x falhas por dia (série completa, dias sem envio viram zero)
create or replace function public.report_daily(days int default 7)
returns table(day date, sent bigint, failed bigint)
language sql stable security definer set search_path = public as $$
  select gs::date as day,
    count(l.id) filter (where l.status = 'sent')   as sent,
    count(l.id) filter (where l.status = 'failed') as failed
  from generate_series(
    (now() at time zone 'America/Sao_Paulo')::date - (days - 1),
    (now() at time zone 'America/Sao_Paulo')::date,
    interval '1 day'
  ) gs
  left join public.message_logs l
    on l.organization_id = public.current_org_id()
   and (l.created_at at time zone 'America/Sao_Paulo')::date = gs::date
  group by gs
  order by gs;
$$;

-- Envios por hora do dia (0–23) — revela os melhores horários
create or replace function public.report_hourly(days int default 7)
returns table(hour int, sent bigint)
language sql stable security definer set search_path = public as $$
  select g.h as hour, count(l.id) as sent
  from generate_series(0, 23) g(h)
  left join public.message_logs l
    on l.organization_id = public.current_org_id()
   and l.status = 'sent'
   and l.created_at >= now() - make_interval(days => days)
   and extract(hour from (l.created_at at time zone 'America/Sao_Paulo'))::int = g.h
  group by g.h
  order by g.h;
$$;

-- Distribuição dos envios por tipo de mídia
create or replace function public.report_by_media(days int default 7)
returns table(media_type text, total bigint)
language sql stable security definer set search_path = public as $$
  select l.media_type::text, count(*)
  from public.message_logs l
  where l.organization_id = public.current_org_id()
    and l.status = 'sent'
    and l.created_at >= now() - make_interval(days => days)
  group by l.media_type
  order by count(*) desc;
$$;

-- Grupos que mais receberam (com falhas para calcular taxa de sucesso)
create or replace function public.report_top_groups(days int default 7, lim int default 8)
returns table(group_id uuid, name text, sent bigint, failed bigint)
language sql stable security definer set search_path = public as $$
  select l.group_id, g.name,
    count(*) filter (where l.status = 'sent')   as sent,
    count(*) filter (where l.status = 'failed') as failed
  from public.message_logs l
  join public.groups g on g.id = l.group_id
  where l.organization_id = public.current_org_id()
    and l.created_at >= now() - make_interval(days => days)
    and l.status in ('sent', 'failed')
  group by l.group_id, g.name
  order by count(*) filter (where l.status = 'sent') desc
  limit lim;
$$;

-- Desempenho por número (sessão) — inclui números sem envio no período
create or replace function public.report_by_session(days int default 7)
returns table(
  session_id uuid, instance_name text, phone_number text,
  status public.session_status, rate_limit_per_min int,
  sent bigint, failed bigint
)
language sql stable security definer set search_path = public as $$
  select s.id, s.instance_name, s.phone_number, s.status, s.rate_limit_per_min,
    count(l.id) filter (where l.status = 'sent')   as sent,
    count(l.id) filter (where l.status = 'failed') as failed
  from public.whatsapp_sessions s
  left join public.message_logs l
    on l.session_id = s.id
   and l.created_at >= now() - make_interval(days => days)
   and l.status in ('sent', 'failed')
  where s.organization_id = public.current_org_id()
  group by s.id
  order by count(l.id) filter (where l.status = 'sent') desc;
$$;

-- Principais motivos de falha (agrupa pela mensagem de erro)
create or replace function public.report_failure_reasons(days int default 7, lim int default 6)
returns table(reason text, total bigint)
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(btrim(l.detail), ''), 'Sem detalhe') as reason, count(*)
  from public.message_logs l
  where l.organization_id = public.current_org_id()
    and l.status = 'failed'
    and l.created_at >= now() - make_interval(days => days)
  group by reason
  order by count(*) desc
  limit lim;
$$;
