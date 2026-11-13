-- ============================================================
-- Notificação push (aviso com o app fechado)
--
-- push_subscriptions: um registro por aparelho/navegador que aceitou receber
-- avisos. Cada usuário gerencia só os seus (RLS); quem envia é o servidor.
--
-- Quem recebe aviso de mensagem nova (wa_push_recipients):
--   • conversa COM atendente: só ele (se ainda atende e tem acesso ao número);
--   • conversa na Fila: quem enxerga a Fila (restrição desligada ou "ver
--     todas") e tem acesso ao número.
--
-- Lembretes vencidos: um job a cada minuto chama a função "push" (que confere
-- o segredo PUSH_SECRET) e ela avisa uma vez cada lembrete (push_notified_at).
--
-- ATENÇÃO: este arquivo tem marcadores a trocar na hora de aplicar, como a 043:
--   __SUPABASE_REF__  → ref do projeto
--   __PUSH_SECRET__   → o mesmo valor do secret PUSH_SECRET das funções
-- ============================================================

create table if not exists public.push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  endpoint        text not null unique,
  p256dh          text not null,
  auth            text not null,
  user_agent      text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_push_subs_user on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;
drop policy if exists push_subs_own on public.push_subscriptions;
create policy push_subs_own on public.push_subscriptions
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid() and organization_id = public.current_org_id());

alter table public.wa_tasks add column if not exists push_notified_at timestamptz;

-- Quem deve receber o aviso desta conversa. Só o servidor chama.
create or replace function public.wa_push_recipients(p_conversation uuid)
returns table (user_id uuid)
language plpgsql stable security definer set search_path = public as $$
declare
  v_conv public.wa_conversations;
begin
  select * into v_conv from public.wa_conversations c where c.id = p_conversation;
  if not found then return; end if;

  if v_conv.assigned_to is not null then
    if public.wa_eligible(v_conv.organization_id, v_conv.assigned_to)
       and public.wa_user_has_session(v_conv.assigned_to, v_conv.session_id) then
      return query select v_conv.assigned_to;
    end if;
    return;
  end if;

  return query
    select u.id
    from public.users u
    where u.organization_id = v_conv.organization_id
      and u.is_active
      and public.user_has_perm(u.id, 'atendimento.ver')
      and (public.user_has_perm(u.id, 'atendimento.ver_todas') or not public.wa_restricted(v_conv.organization_id))
      and public.wa_user_has_session(u.id, v_conv.session_id);
end;
$$;
revoke all on function public.wa_push_recipients(uuid) from public, anon, authenticated;

-- Lembretes vencidos, a cada minuto.
do $$
begin
  perform cron.unschedule('push-lembretes');
exception when others then null;
end;
$$;

select cron.schedule(
  'push-lembretes',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://__SUPABASE_REF__.supabase.co/functions/v1/push',
    headers := '{"Content-Type": "application/json", "x-push-secret": "__PUSH_SECRET__"}'::jsonb,
    body := '{"action": "tasks"}'::jsonb
  );
  $$
);
