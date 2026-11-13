-- ============================================================
-- Atendimento: notas internas, respostas rápidas e lembretes de retorno
--
-- 1. NOTAS INTERNAS (wa_notes): recado entre atendentes dentro da conversa,
--    que o cliente nunca vê. Visível para quem enxerga a conversa
--    (wa_can_see); escrita pela RPC, que confere isso.
-- 2. RESPOSTAS RÁPIDAS (wa_quick_replies): textos prontos com atalho
--    ("/preco"). Quem atende lê; quem configura o atendimento escreve.
-- 3. LEMBRETES (wa_tasks): "voltar a falar com este cliente em tal dia".
--    Cada um vê os seus; "ver todas" vê os da organização.
-- ============================================================

-- ---------- 1. Notas ----------
create table if not exists public.wa_notes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.wa_conversations(id) on delete cascade,
  author          uuid references public.users(id) on delete set null,
  body            text not null check (length(btrim(body)) between 1 and 4000),
  created_at      timestamptz not null default clock_timestamp()
);
create index if not exists idx_wa_notes_conv on public.wa_notes(conversation_id, created_at);

alter table public.wa_notes enable row level security;
drop policy if exists wa_notes_select on public.wa_notes;
create policy wa_notes_select on public.wa_notes
  for select using (exists (select 1 from public.wa_conversations c where c.id = conversation_id));

alter publication supabase_realtime add table public.wa_notes;

create or replace function public.wa_add_note(p_conversation uuid, p_body text)
returns public.wa_notes
language plpgsql security definer set search_path = public as $$
declare
  v_conv public.wa_conversations := public.wa_visible_conversation(p_conversation);
  v_row  public.wa_notes;
begin
  if nullif(btrim(coalesce(p_body, '')), '') is null then
    raise exception 'Escreva a nota';
  end if;
  insert into public.wa_notes (organization_id, conversation_id, author, body)
  values (v_conv.organization_id, v_conv.id, auth.uid(), left(btrim(p_body), 4000))
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.wa_add_note(uuid, text) from public, anon;
grant execute on function public.wa_add_note(uuid, text) to authenticated;

-- ---------- 2. Respostas rápidas ----------
create table if not exists public.wa_quick_replies (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  shortcut        text not null check (shortcut ~ '^[a-z0-9_-]{1,30}$'),
  body            text not null check (length(btrim(body)) between 1 and 4000),
  created_by      uuid references public.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (organization_id, shortcut)
);

alter table public.wa_quick_replies enable row level security;
drop policy if exists wa_qr_select on public.wa_quick_replies;
create policy wa_qr_select on public.wa_quick_replies
  for select using (organization_id = public.current_org_id() and public.current_user_can('atendimento.ver'));
drop policy if exists wa_qr_write on public.wa_quick_replies;
create policy wa_qr_write on public.wa_quick_replies
  for all using (organization_id = public.current_org_id() and public.current_user_can('atendimento.configurar'))
  with check (organization_id = public.current_org_id() and public.current_user_can('atendimento.configurar'));

-- ---------- 3. Lembretes ----------
create table if not exists public.wa_tasks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.wa_conversations(id) on delete cascade,
  assigned_to     uuid not null references public.users(id) on delete cascade,
  title           text not null check (length(btrim(title)) between 1 and 200),
  due_at          timestamptz not null,
  done_at         timestamptz,
  created_by      uuid references public.users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists idx_wa_tasks_user on public.wa_tasks(assigned_to, due_at) where done_at is null;
create index if not exists idx_wa_tasks_conv on public.wa_tasks(conversation_id, due_at);

alter table public.wa_tasks enable row level security;
drop policy if exists wa_tasks_select on public.wa_tasks;
create policy wa_tasks_select on public.wa_tasks
  for select using (
    organization_id = public.current_org_id()
    and (assigned_to = auth.uid() or public.current_user_can('atendimento.ver_todas')
         or exists (select 1 from public.wa_conversations c where c.id = conversation_id))
  );

create or replace function public.wa_task_create(
  p_conversation uuid, p_title text, p_due timestamptz, p_assignee uuid default null
)
returns public.wa_tasks
language plpgsql security definer set search_path = public as $$
declare
  v_conv public.wa_conversations := public.wa_visible_conversation(p_conversation);
  v_to   uuid := coalesce(p_assignee, auth.uid());
  v_row  public.wa_tasks;
begin
  if nullif(btrim(coalesce(p_title, '')), '') is null then
    raise exception 'Escreva o lembrete';
  end if;
  if v_to is distinct from auth.uid() and not public.current_user_can('atendimento.atribuir') then
    raise exception 'Você só pode criar lembrete para você';
  end if;
  if not public.wa_eligible(v_conv.organization_id, v_to) then
    raise exception 'Esta pessoa não atende conversas';
  end if;
  insert into public.wa_tasks (organization_id, conversation_id, assigned_to, title, due_at, created_by)
  values (v_conv.organization_id, v_conv.id, v_to, left(btrim(p_title), 200), p_due, auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.wa_task_done(p_id uuid, p_done boolean default true)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.wa_tasks t set done_at = case when p_done then now() else null end
  where t.id = p_id and t.organization_id = public.current_org_id()
    and (t.assigned_to = auth.uid() or t.created_by = auth.uid() or public.current_user_can('atendimento.atribuir'));
  if not found then
    raise exception 'Lembrete não encontrado';
  end if;
end;
$$;

create or replace function public.wa_task_delete(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.wa_tasks t
  where t.id = p_id and t.organization_id = public.current_org_id()
    and (t.assigned_to = auth.uid() or t.created_by = auth.uid() or public.current_user_can('atendimento.atribuir'));
end;
$$;

revoke all on function public.wa_task_create(uuid, text, timestamptz, uuid) from public, anon;
revoke all on function public.wa_task_done(uuid, boolean) from public, anon;
revoke all on function public.wa_task_delete(uuid) from public, anon;
grant execute on function public.wa_task_create(uuid, text, timestamptz, uuid) to authenticated;
grant execute on function public.wa_task_done(uuid, boolean) to authenticated;
grant execute on function public.wa_task_delete(uuid) to authenticated;
