-- ============================================================
-- SaaS: cada número (instância da Evolution) pertence a quem o criou
--
-- A Evolution é COMPARTILHADA com outros sistemas (inclusive o da PH): a
-- chave global enxerga todas as instâncias do servidor. O que impede um
-- usuário daqui de mexer na instância de outro é este banco — o proxy
-- (Edge Function evolution) e a wa-chat só operam instância que está em
-- whatsapp_sessions E é do usuário. Por isso:
--
--   1. created_by: o dono. Só ele vê, conecta, desconecta e remove.
--      Número sem dono (usuário apagado) fica com o admin da organização.
--   2. O painel NÃO cria linha aqui. Quem cria é a Edge Function, depois
--      de criar a instância na Evolution com um nome gerado por ela — antes
--      o painel aceitava qualquer nome e "adotava" instância que já existia
--      no servidor, inclusive de outro sistema.
--   3. Nome da instância, organização, dono e chat_enabled não mudam pelo
--      painel (trigger). Trocar o nome por outro já existente na Evolution
--      era a outra porta para a instância alheia.
-- ============================================================

alter table public.whatsapp_sessions
  add column if not exists created_by uuid references public.users(id) on delete set null;

create index if not exists idx_sessions_owner on public.whatsapp_sessions(organization_id, created_by);

create or replace function public.session_is_mine(p_org uuid, p_owner uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select p_org = public.current_org_id()
    and (
      p_owner = auth.uid()
      or (p_owner is null and public.current_user_role() = 'admin')
    );
$$;

-- ---------- Políticas ----------
drop policy if exists sessions_select on public.whatsapp_sessions;
drop policy if exists sessions_write  on public.whatsapp_sessions;
drop policy if exists sessions_update on public.whatsapp_sessions;
drop policy if exists sessions_delete on public.whatsapp_sessions;

create policy sessions_select on public.whatsapp_sessions
  for select using (
    public.session_is_mine(organization_id, created_by)
    and public.current_user_can('painel.numeros.ver')
  );

create policy sessions_update on public.whatsapp_sessions
  for update using (
    public.session_is_mine(organization_id, created_by)
    and public.current_user_can('painel.numeros.editar')
  )
  with check (
    public.session_is_mine(organization_id, created_by)
    and public.current_user_can('painel.numeros.editar')
  );

create policy sessions_delete on public.whatsapp_sessions
  for delete using (
    public.session_is_mine(organization_id, created_by)
    and public.current_user_can('painel.numeros.editar')
  );

-- Sem política de insert: só a Edge Function (service role) cria.

-- ---------- Identidade imutável pelo painel ----------
create or replace function public.whatsapp_sessions_guard()
returns trigger
language plpgsql as $$
begin
  -- current_user é o papel de quem chamou: 'authenticated' para o painel,
  -- 'service_role' para as Edge Functions, 'postgres' para migration.
  if current_user in ('authenticated', 'anon') and (
       new.instance_name   is distinct from old.instance_name
    or new.organization_id is distinct from old.organization_id
    or new.created_by      is distinct from old.created_by
    or new.chat_enabled    is distinct from old.chat_enabled
  ) then
    raise exception 'Nome, dono e atendimento do número só mudam pelo servidor';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_whatsapp_sessions_guard on public.whatsapp_sessions;
create trigger trg_whatsapp_sessions_guard
  before update on public.whatsapp_sessions
  for each row execute function public.whatsapp_sessions_guard();

-- ---------- O que depende do número ----------

-- Ligar grupo a número: só a um número seu. A subconsulta passa pela RLS
-- de whatsapp_sessions, que já é por dono.
drop policy if exists group_sessions_write on public.group_sessions;
create policy group_sessions_write on public.group_sessions
  for all using (
    exists (select 1 from public.groups g where g.id = group_id and g.organization_id = public.current_org_id())
    and exists (select 1 from public.whatsapp_sessions s where s.id = session_id)
    and public.current_user_can('painel.grupos.editar')
  )
  with check (
    exists (select 1 from public.groups g where g.id = group_id and g.organization_id = public.current_org_id())
    and exists (select 1 from public.whatsapp_sessions s where s.id = session_id)
    and public.current_user_can('painel.grupos.editar')
  );

-- Grupos descobertos em cada número (067): só os dos seus números.
drop policy if exists session_groups_select on public.session_groups;
create policy session_groups_select on public.session_groups
  for select using (
    organization_id = public.current_org_id()
    and exists (select 1 from public.whatsapp_sessions s where s.id = session_id)
  );

drop policy if exists group_discovery_select on public.group_discovery;
create policy group_discovery_select on public.group_discovery
  for select using (
    organization_id = public.current_org_id()
    and exists (select 1 from public.whatsapp_sessions s where s.id = session_id)
  );

-- Pedir a lista de grupos de um número: só do seu.
create or replace function public.request_group_discovery(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if not public.current_user_can('painel.grupos.editar') then
    raise exception 'Seu perfil não tem a permissão "painel.grupos.editar" para importar grupos';
  end if;

  select s.organization_id into v_org
    from public.whatsapp_sessions s
   where s.id = p_session_id
     and public.session_is_mine(s.organization_id, s.created_by);

  if v_org is null then
    raise exception 'Número não encontrado entre os seus';
  end if;

  insert into public.group_discovery (session_id, organization_id, status, requested_at)
  values (p_session_id, v_org, 'pending', now())
  on conflict (session_id) do update
    set status         = 'pending',
        requested_at   = now(),
        started_at     = null,
        finished_at    = null,
        net_request_id = null,
        error          = null,
        found          = 0,
        attempts       = 0
    where public.group_discovery.status not in ('pending', 'running')
       or public.group_discovery.requested_at < now() - interval '10 minutes';
end;
$$;

-- ---------- Atendimento (116) ----------
-- A lista de números da tela de atendimento: os seus (mine = true, os que
-- você pode ligar/desligar) e, só para mostrar o rótulo, os números das
-- conversas que você enxerga.
drop function if exists public.wa_sessions_list();
create function public.wa_sessions_list()
returns table (id uuid, instance_name text, phone_number text, status text, chat_enabled boolean, mine boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (
    public.current_user_can('atendimento.ver')
    or public.current_user_can('atendimento.ver_todas')
    or public.current_user_can('atendimento.configurar')
  ) then
    return;
  end if;

  return query
    select s.id, s.instance_name, s.phone_number, s.status::text, s.chat_enabled,
           public.session_is_mine(s.organization_id, s.created_by)
    from public.whatsapp_sessions s
    where s.organization_id = public.current_org_id()
      and (
        public.session_is_mine(s.organization_id, s.created_by)
        or exists (
          select 1 from public.wa_conversations c
          where c.session_id = s.id and public.wa_can_see(c.organization_id, c.assigned_to)
        )
      )
    order by s.created_at;
end;
$$;

-- ---------- Envio por número escolhido ----------
-- Agendamento, fila e jobs de participantes aceitam um session_id vindo do
-- painel, e o worker respeita a escolha sem perguntar de quem é o número.
-- A RLS dessas tabelas confere só a organização da LINHA — dava para
-- agendar envio pelo número de outra organização informando o id dele.
-- Aqui: o número tem que ser da mesma organização sempre, e, vindo do
-- painel, tem que ser do próprio usuário.
create or replace function public.guard_session_choice()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_org   uuid;
  v_owner uuid;
begin
  if new.session_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.session_id is not distinct from old.session_id then
    return new;
  end if;

  select s.organization_id, s.created_by into v_org, v_owner
  from public.whatsapp_sessions s where s.id = new.session_id;

  if v_org is distinct from new.organization_id then
    raise exception 'Número não pertence a esta organização';
  end if;

  -- Função security definer: current_user aqui é o dono da função, não
  -- quem chamou. O papel da requisição vem do JWT ('authenticated' = painel;
  -- worker e Edge Functions usam service_role e passam).
  if coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'authenticated'
     and not public.session_is_mine(v_org, v_owner) then
    raise exception 'Só dá para enviar pelos seus próprios números';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_queue_session_guard on public.message_queue;
create trigger trg_queue_session_guard
  before insert or update of session_id on public.message_queue
  for each row execute function public.guard_session_choice();

drop trigger if exists trg_schedules_session_guard on public.schedules;
create trigger trg_schedules_session_guard
  before insert or update of session_id on public.schedules
  for each row execute function public.guard_session_choice();

drop trigger if exists trg_participant_jobs_session_guard on public.participant_jobs;
create trigger trg_participant_jobs_session_guard
  before insert or update of session_id on public.participant_jobs
  for each row execute function public.guard_session_choice();
