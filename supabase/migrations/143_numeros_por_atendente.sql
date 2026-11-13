-- ============================================================
-- Números por atendente
--
-- O admin escolhe a quais números de WhatsApp cada atendente tem acesso. Sem
-- linha em wa_user_sessions = acesso a TODOS (o padrão, como era). Com linha,
-- só os números da lista: o atendente não vê conversas dos outros números, não
-- recebe distribuição automática deles, não inicia conversa por eles e não
-- pode receber transferência de conversa deles. Admin sempre vê todos.
--
-- Também: chat_manual_off marca o número que alguém desligou do atendimento à
-- mão, para a ligação automática (que acontece quando o número conecta) não o
-- religar.
-- ============================================================

alter table public.whatsapp_sessions
  add column if not exists chat_manual_off boolean not null default false;

create table if not exists public.wa_user_sessions (
  user_id         uuid primary key references public.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  session_ids     uuid[] not null default '{}'
);
alter table public.wa_user_sessions enable row level security;
drop policy if exists wa_user_sessions_select on public.wa_user_sessions;
create policy wa_user_sessions_select on public.wa_user_sessions
  for select using (
    organization_id = public.current_org_id()
    and (user_id = auth.uid() or public.current_user_can('atendimento.configurar'))
  );
-- Sem policy de escrita: só pelas funções abaixo.

-- O usuário pode usar este número? (sem linha = todos; admin = todos)
create or replace function public.wa_user_has_session(p_user uuid, p_session uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
           (select (p_session is null) or (p_session = any(u.session_ids))
            from public.wa_user_sessions u where u.user_id = p_user),
           true
         )
         or exists (select 1 from public.users x where x.id = p_user and x.role = 'admin');
$$;
revoke all on function public.wa_user_has_session(uuid, uuid) from public, anon, authenticated;

-- Para quem está logado (usada nas políticas e nas listas da tela).
create or replace function public.wa_session_ok(p_session uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.wa_user_has_session(auth.uid(), p_session);
$$;
revoke all on function public.wa_session_ok(uuid) from public, anon;
grant execute on function public.wa_session_ok(uuid) to authenticated;

-- Admin do atendimento: quem tem acesso a quê.
create or replace function public.wa_user_sessions_list()
returns table (user_id uuid, session_ids uuid[])
language sql stable security definer set search_path = public as $$
  select u.user_id, u.session_ids from public.wa_user_sessions u
  where u.organization_id = public.current_org_id()
    and public.current_user_can('atendimento.configurar');
$$;
revoke all on function public.wa_user_sessions_list() from public, anon;
grant execute on function public.wa_user_sessions_list() to authenticated;

-- p_sessions null = todos os números (apaga a restrição).
create or replace function public.wa_user_sessions_set(p_user uuid, p_sessions uuid[])
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
begin
  if not public.current_user_can('atendimento.configurar') then
    raise exception 'Sem permissão para configurar o atendimento';
  end if;
  if not exists (select 1 from public.users u where u.id = p_user and u.organization_id = v_org) then
    raise exception 'Usuário não encontrado';
  end if;
  if p_sessions is null then
    delete from public.wa_user_sessions where user_id = p_user;
    return;
  end if;
  if exists (
    select 1 from unnest(p_sessions) x
    where not exists (select 1 from public.whatsapp_sessions s where s.id = x and s.organization_id = v_org)
  ) then
    raise exception 'Número inválido';
  end if;
  insert into public.wa_user_sessions (user_id, organization_id, session_ids)
  values (p_user, v_org, p_sessions)
  on conflict (user_id) do update set session_ids = excluded.session_ids;
end;
$$;
revoke all on function public.wa_user_sessions_set(uuid, uuid[]) from public, anon;
grant execute on function public.wa_user_sessions_set(uuid, uuid[]) to authenticated;

-- Todos os números da organização, para o admin montar os acessos (a lista
-- normal só traz os que a pessoa usa ou que têm conversa visível).
create or replace function public.wa_sessions_all()
returns table (id uuid, instance_name text, phone_number text, status text, chat_enabled boolean, mine boolean)
language sql stable security definer set search_path = public as $$
  select s.id, s.instance_name, s.phone_number, s.status::text, s.chat_enabled,
         public.session_is_mine(s.organization_id, s.created_by)
  from public.whatsapp_sessions s
  where s.organization_id = public.current_org_id()
    and public.current_user_can('atendimento.configurar')
  order by s.created_at;
$$;
revoke all on function public.wa_sessions_all() from public, anon;
grant execute on function public.wa_sessions_all() to authenticated;

-- ---------- Conversas: a RLS passa a considerar o número ----------
drop policy if exists wa_conv_select on public.wa_conversations;
create policy wa_conv_select on public.wa_conversations
  for select using (
    public.wa_can_see(organization_id, assigned_to)
    and public.wa_session_ok(session_id)
  );

-- ---------- Funções existentes: acrescenta a checagem do número ----------
create or replace function pg_temp.wa_patch(p_fn text, p_old text, p_new text)
returns void
language plpgsql as $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = p_fn and p.prokind = 'f';
  if v_def is null then
    raise exception 'Função % não encontrada', p_fn;
  end if;
  if position(p_new in v_def) > 0 then
    return; -- já aplicado
  end if;
  v_new := replace(v_def, p_old, p_new);
  if v_new = v_def then
    raise exception 'Função %: trecho esperado não encontrado (%)', p_fn, left(p_old, 60);
  end if;
  execute v_new;
end;
$$;

-- Conversa visível (usada por todas as ações sobre uma conversa).
select pg_temp.wa_patch('wa_visible_conversation',
  'where c.id = p_conversation and public.wa_can_see(c.organization_id, c.assigned_to);',
  'where c.id = p_conversation and public.wa_can_see(c.organization_id, c.assigned_to)
    and public.wa_session_ok(c.session_id);');

-- Lista filtrada (etiqueta, compra, data…).
select pg_temp.wa_patch('wa_conversas_filtradas',
  'where public.wa_can_see(c.organization_id, c.assigned_to)',
  'where public.wa_can_see(c.organization_id, c.assigned_to)
    and public.wa_session_ok(c.session_id)');

-- Números que aparecem na tela (filtro de canal) e para iniciar conversa.
select pg_temp.wa_patch('wa_sessions_list',
  'where s.organization_id = public.current_org_id()
      and (',
  'where s.organization_id = public.current_org_id()
      and public.wa_session_ok(s.id)
      and (');
select pg_temp.wa_patch('wa_start_sessions',
  'where s.organization_id = public.current_org_id() and s.chat_enabled',
  'where s.organization_id = public.current_org_id() and s.chat_enabled and public.wa_session_ok(s.id)');
select pg_temp.wa_patch('wa_open_conversation',
  'raise exception ''Este número não está ligado ao atendimento'';
  end if;',
  'raise exception ''Este número não está ligado ao atendimento'';
  end if;
  if not public.wa_user_has_session(p_user, p_session) then
    raise exception ''Você não tem acesso a este número'';
  end if;');

-- Distribuição automática: só para quem tem acesso ao número da conversa.
select pg_temp.wa_patch('wa_pick_attendant',
  'or not public.wa_agent_has_capacity(p_org, v_rule.target_user);',
  'or not public.wa_agent_has_capacity(p_org, v_rule.target_user)
               or not public.wa_user_has_session(v_rule.target_user, p_session);');
select pg_temp.wa_patch('wa_pick_attendant',
  'and public.wa_agent_has_capacity(p_org, v_set.fixed_user) then',
  'and public.wa_agent_has_capacity(p_org, v_set.fixed_user)
       and public.wa_user_has_session(v_set.fixed_user, p_session) then');
select pg_temp.wa_patch('wa_pick_attendant',
  'and public.wa_agent_has_capacity(p_org, u.id)
  order by',
  'and public.wa_agent_has_capacity(p_org, u.id)
    and public.wa_user_has_session(u.id, p_session)
  order by');

-- Transferência: o destino precisa ter acesso ao número.
select pg_temp.wa_patch('wa_transfer',
  'if p_to is not null and not public.wa_eligible(v_conv.organization_id, p_to) then',
  'if p_to is not null and (not public.wa_eligible(v_conv.organization_id, p_to)
                            or not public.wa_user_has_session(p_to, v_conv.session_id)) then');
