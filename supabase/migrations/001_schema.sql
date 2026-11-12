-- ============================================================
-- PH Groups — Schema completo (multi-tenant + RLS)
-- Execute no SQL Editor do Supabase ou via `supabase db push`
-- ============================================================

create extension if not exists "uuid-ossp";

-- ------------------------------------------------------------
-- ORGANIZATIONS (tenant raiz)
-- ------------------------------------------------------------
create table public.organizations (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- USERS (perfil vinculado ao auth.users)
-- ------------------------------------------------------------
create type public.user_role as enum ('admin', 'operator', 'viewer');

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  full_name text,
  role public.user_role not null default 'operator',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index idx_users_org on public.users(organization_id);

-- Helper: organização do usuário autenticado (evita recursão em RLS)
create or replace function public.current_org_id()
returns uuid
language sql stable security definer set search_path = public as $$
  select organization_id from public.users where id = auth.uid()
$$;

create or replace function public.current_user_role()
returns public.user_role
language sql stable security definer set search_path = public as $$
  select role from public.users where id = auth.uid()
$$;

-- Trigger: cria organização + perfil no signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  org_id uuid;
begin
  insert into public.organizations (name)
  values (coalesce(new.raw_user_meta_data->>'organization_name', split_part(new.email, '@', 1)))
  returning id into org_id;

  insert into public.users (id, organization_id, email, full_name, role)
  values (new.id, org_id, new.email, new.raw_user_meta_data->>'full_name', 'admin');

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- WHATSAPP SESSIONS (instâncias Evolution API)
-- ------------------------------------------------------------
create type public.session_status as enum ('disconnected', 'connecting', 'connected', 'error');

create table public.whatsapp_sessions (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  instance_name text not null unique,
  phone_number text,
  status public.session_status not null default 'disconnected',
  rate_limit_per_min int not null default 20,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_sessions_org on public.whatsapp_sessions(organization_id);

-- ------------------------------------------------------------
-- GROUPS
-- ------------------------------------------------------------
create table public.groups (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  group_jid text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index idx_groups_org on public.groups(organization_id);

-- Associação grupo <-> sessões (um grupo pode enviar por N números)
create table public.group_sessions (
  group_id uuid not null references public.groups(id) on delete cascade,
  session_id uuid not null references public.whatsapp_sessions(id) on delete cascade,
  primary key (group_id, session_id)
);

create table public.group_participants (
  id uuid primary key default uuid_generate_v4(),
  group_id uuid not null references public.groups(id) on delete cascade,
  jid text not null,
  name text,
  is_admin boolean not null default false,
  synced_at timestamptz not null default now()
);

create index idx_participants_group on public.group_participants(group_id);

-- ------------------------------------------------------------
-- MESSAGES (conteúdo criado pelo usuário)
-- ------------------------------------------------------------
create type public.media_type as enum ('text', 'image', 'audio', 'video', 'document');

create table public.messages (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid references public.users(id) on delete set null,
  media_type public.media_type not null default 'text',
  content text,
  media_url text,
  caption text,
  file_name text,
  created_at timestamptz not null default now()
);

create index idx_messages_org on public.messages(organization_id);

-- ------------------------------------------------------------
-- MESSAGE QUEUE (nenhum envio acontece fora daqui)
-- ------------------------------------------------------------
create type public.queue_status as enum ('pending', 'processing', 'sent', 'failed', 'cancelled');
create type public.queue_priority as enum ('urgent', 'normal', 'low');

create table public.message_queue (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  session_id uuid references public.whatsapp_sessions(id) on delete set null,
  priority public.queue_priority not null default 'normal',
  status public.queue_status not null default 'pending',
  attempts int not null default 0,
  max_attempts int not null default 3,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_queue_org on public.message_queue(organization_id);
create index idx_queue_claim on public.message_queue(status, next_attempt_at, priority);

-- ------------------------------------------------------------
-- MESSAGE LOGS (todo envio gera log — obrigatório)
-- ------------------------------------------------------------
create type public.log_status as enum ('sent', 'failed', 'queued', 'retrying');

create table public.message_logs (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  queue_id uuid references public.message_queue(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,
  group_id uuid references public.groups(id) on delete set null,
  session_id uuid references public.whatsapp_sessions(id) on delete set null,
  status public.log_status not null,
  media_type public.media_type not null default 'text',
  detail text,
  created_at timestamptz not null default now()
);

create index idx_logs_org_date on public.message_logs(organization_id, created_at desc);

-- ------------------------------------------------------------
-- SCHEDULES
-- ------------------------------------------------------------
create type public.schedule_status as enum ('scheduled', 'executed', 'cancelled', 'failed');

create table public.schedules (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  priority public.queue_priority not null default 'normal',
  scheduled_at timestamptz not null,
  timezone text not null default 'America/Sao_Paulo',
  status public.schedule_status not null default 'scheduled',
  executed_at timestamptz,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index idx_schedules_due on public.schedules(status, scheduled_at);
create index idx_schedules_org on public.schedules(organization_id);

-- ------------------------------------------------------------
-- AUTOMATION RULES
-- ------------------------------------------------------------
create table public.automation_rules (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  trigger_event text not null, -- ex: 'group.message_received', 'session.connected'
  trigger_group_id uuid references public.groups(id) on delete cascade,
  action_message_id uuid references public.messages(id) on delete cascade,
  action_group_id uuid references public.groups(id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index idx_automation_org on public.automation_rules(organization_id);

-- ------------------------------------------------------------
-- RPC: claim de lote da fila com lock (evita duplicidade)
-- ------------------------------------------------------------
create or replace function public.claim_queue_batch(worker_id text, batch_size int default 10)
returns setof public.message_queue
language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.message_queue q
  set status = 'processing',
      locked_at = now(),
      locked_by = worker_id,
      updated_at = now()
  where q.id in (
    select id from public.message_queue
    where organization_id = public.current_org_id()
      and status = 'pending'
      and next_attempt_at <= now()
    order by
      case priority when 'urgent' then 0 when 'normal' then 1 else 2 end,
      created_at
    limit batch_size
    for update skip locked
  )
  returning q.*;
end;
$$;

-- RPC: libera locks travados há mais de 5 min (worker morreu)
create or replace function public.release_stale_locks()
returns void
language sql security definer set search_path = public as $$
  update public.message_queue
  set status = 'pending', locked_at = null, locked_by = null, updated_at = now()
  where status = 'processing'
    and organization_id = public.current_org_id()
    and locked_at < now() - interval '5 minutes';
$$;

-- ------------------------------------------------------------
-- ROW LEVEL SECURITY (isolamento total por organization_id)
-- ------------------------------------------------------------
alter table public.organizations enable row level security;
alter table public.users enable row level security;
alter table public.whatsapp_sessions enable row level security;
alter table public.groups enable row level security;
alter table public.group_sessions enable row level security;
alter table public.group_participants enable row level security;
alter table public.messages enable row level security;
alter table public.message_queue enable row level security;
alter table public.message_logs enable row level security;
alter table public.schedules enable row level security;
alter table public.automation_rules enable row level security;

create policy org_select on public.organizations
  for select using (id = public.current_org_id());

create policy users_select on public.users
  for select using (organization_id = public.current_org_id());
create policy users_admin_write on public.users
  for update using (organization_id = public.current_org_id() and public.current_user_role() = 'admin');
create policy users_admin_insert on public.users
  for insert with check (organization_id = public.current_org_id() and public.current_user_role() = 'admin');

-- Padrão: leitura para todos da org; escrita para admin/operator
create policy sessions_select on public.whatsapp_sessions
  for select using (organization_id = public.current_org_id());
create policy sessions_write on public.whatsapp_sessions
  for all using (organization_id = public.current_org_id() and public.current_user_role() in ('admin','operator'))
  with check (organization_id = public.current_org_id());

create policy groups_select on public.groups
  for select using (organization_id = public.current_org_id());
create policy groups_write on public.groups
  for all using (organization_id = public.current_org_id() and public.current_user_role() in ('admin','operator'))
  with check (organization_id = public.current_org_id());

create policy group_sessions_all on public.group_sessions
  for all using (
    exists (select 1 from public.groups g where g.id = group_id and g.organization_id = public.current_org_id())
  );

create policy participants_all on public.group_participants
  for all using (
    exists (select 1 from public.groups g where g.id = group_id and g.organization_id = public.current_org_id())
  );

create policy messages_select on public.messages
  for select using (organization_id = public.current_org_id());
create policy messages_write on public.messages
  for all using (organization_id = public.current_org_id() and public.current_user_role() in ('admin','operator'))
  with check (organization_id = public.current_org_id());

create policy queue_select on public.message_queue
  for select using (organization_id = public.current_org_id());
create policy queue_write on public.message_queue
  for all using (organization_id = public.current_org_id() and public.current_user_role() in ('admin','operator'))
  with check (organization_id = public.current_org_id());

create policy logs_select on public.message_logs
  for select using (organization_id = public.current_org_id());
create policy logs_insert on public.message_logs
  for insert with check (organization_id = public.current_org_id());

create policy schedules_select on public.schedules
  for select using (organization_id = public.current_org_id());
create policy schedules_write on public.schedules
  for all using (organization_id = public.current_org_id() and public.current_user_role() in ('admin','operator'))
  with check (organization_id = public.current_org_id());

create policy automation_select on public.automation_rules
  for select using (organization_id = public.current_org_id());
create policy automation_write on public.automation_rules
  for all using (organization_id = public.current_org_id() and public.current_user_role() = 'admin')
  with check (organization_id = public.current_org_id());

-- ------------------------------------------------------------
-- REALTIME
-- ------------------------------------------------------------
alter publication supabase_realtime add table public.message_queue;
alter publication supabase_realtime add table public.message_logs;
alter publication supabase_realtime add table public.whatsapp_sessions;
