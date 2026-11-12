-- ============================================================
-- Worker server-side: pg_cron aciona a Edge Function "worker"
-- a cada minuto. O painel deixa de processar envios no navegador.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ------------------------------------------------------------
-- Jobs de adição/remoção de participantes (processados em lotes
-- pelo worker — continuam mesmo com o painel fechado)
-- ------------------------------------------------------------
create type public.participant_job_status as enum ('pending', 'processing', 'done', 'failed');

create table public.participant_jobs (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  session_id uuid not null references public.whatsapp_sessions(id) on delete cascade,
  action text not null check (action in ('add', 'remove')),
  phones text[] not null,
  processed int not null default 0,
  total int not null,
  status public.participant_job_status not null default 'pending',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_participant_jobs_pending on public.participant_jobs(status, created_at);

alter table public.participant_jobs enable row level security;

create policy participant_jobs_select on public.participant_jobs
  for select using (organization_id = public.current_org_id());
create policy participant_jobs_insert on public.participant_jobs
  for insert with check (
    organization_id = public.current_org_id()
    and public.current_user_role() in ('admin', 'operator')
  );

-- ------------------------------------------------------------
-- Heartbeat do worker (para o badge Online/Offline do painel)
-- ------------------------------------------------------------
create table public.worker_status (
  id int primary key default 1 check (id = 1),
  last_run_at timestamptz
);

insert into public.worker_status (id) values (1) on conflict do nothing;

alter table public.worker_status enable row level security;
create policy worker_status_select on public.worker_status
  for select to authenticated using (true);

-- ------------------------------------------------------------
-- RPCs do worker (sem filtro de organização — uso exclusivo do
-- service role; revogadas para clientes)
-- ------------------------------------------------------------
create or replace function public.claim_queue_batch_worker(p_worker text, p_limit int default 20)
returns setof public.message_queue
language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.message_queue q
  set status = 'processing',
      locked_at = now(),
      locked_by = p_worker,
      updated_at = now()
  where q.id in (
    select id from public.message_queue
    where status = 'pending'
      and next_attempt_at <= now()
    order by
      case priority when 'urgent' then 0 when 'normal' then 1 else 2 end,
      created_at
    limit p_limit
    for update skip locked
  )
  returning q.*;
end;
$$;

create or replace function public.release_stale_locks_worker()
returns void
language sql security definer set search_path = public as $$
  update public.message_queue
  set status = 'pending', locked_at = null, locked_by = null, updated_at = now()
  where status = 'processing'
    and locked_at < now() - interval '5 minutes';
$$;

revoke all on function public.claim_queue_batch_worker(text, int) from public, anon, authenticated;
revoke all on function public.release_stale_locks_worker() from public, anon, authenticated;

-- ------------------------------------------------------------
-- Realtime
-- ------------------------------------------------------------
alter publication supabase_realtime add table public.participant_jobs;
alter publication supabase_realtime add table public.worker_status;

-- ------------------------------------------------------------
-- Cron: aciona o worker a cada minuto, 24/7
-- ------------------------------------------------------------
select cron.schedule(
  'ph-groups-worker',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://__SUPABASE_REF__.supabase.co/functions/v1/worker',
    headers := '{"Content-Type": "application/json", "x-worker-secret": "__WORKER_SECRET__"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
