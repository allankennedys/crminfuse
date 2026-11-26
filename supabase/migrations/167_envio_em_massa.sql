-- ============================================================
-- Envio em massa (167)
--
-- Uma campanha = uma mensagem (texto, ou mídia/áudio com legenda) para uma lista de
-- contatos, agora ou agendada. Quem cria é a Edge Function `broadcast` (token do usuário,
-- confere permissão e assinatura); quem envia é a `broadcast-run`, chamada a cada minuto
-- pelo pg_cron e logo após criar. O envio sai devagar de propósito (pausa aleatória entre
-- contatos) para não derrubar o número no WhatsApp.
-- ============================================================
create table if not exists public.broadcasts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by      uuid references public.users(id) on delete set null,
  session_id      uuid references public.whatsapp_sessions(id) on delete set null,
  name            text not null,
  kind            text not null check (kind in ('text', 'image', 'video', 'audio', 'document')),
  body            text,
  media_path      text,
  media_mime      text,
  media_name      text,
  delay_seconds   int  not null default 6 check (delay_seconds between 2 and 120),
  scheduled_at    timestamptz not null default now(),
  status          text not null default 'agendada'
                  check (status in ('agendada', 'enviando', 'concluida', 'cancelada', 'falhou')),
  error           text,
  total           int  not null default 0,
  sent            int  not null default 0,
  failed          int  not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
create index if not exists idx_broadcasts_org on public.broadcasts (organization_id, created_at desc);
create index if not exists idx_broadcasts_due on public.broadcasts (scheduled_at) where status in ('agendada', 'enviando');

create table if not exists public.broadcast_recipients (
  id              uuid primary key default gen_random_uuid(),
  broadcast_id    uuid not null references public.broadcasts(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id      uuid references public.crm_contacts(id) on delete set null,
  name            text,
  phone           text not null,
  status          text not null default 'pendente' check (status in ('pendente', 'enviado', 'falha')),
  error           text,
  sent_at         timestamptz,
  unique (broadcast_id, phone)
);
create index if not exists idx_broadcast_rcpt_pend on public.broadcast_recipients (broadcast_id, status);

alter table public.broadcasts enable row level security;
alter table public.broadcast_recipients enable row level security;

-- Leitura: quem edita contatos (e o admin) vê as campanhas da própria empresa.
-- Escrita: só as Edge Functions (service role).
drop policy if exists broadcasts_read on public.broadcasts;
create policy broadcasts_read on public.broadcasts for select to authenticated
  using (organization_id = public.current_org_id() and public.current_user_can('crm.contatos.editar'));
drop policy if exists broadcast_rcpt_read on public.broadcast_recipients;
create policy broadcast_rcpt_read on public.broadcast_recipients for select to authenticated
  using (organization_id = public.current_org_id() and public.current_user_can('crm.contatos.editar'));
revoke all on public.broadcasts, public.broadcast_recipients from anon;
grant select on public.broadcasts, public.broadcast_recipients to authenticated;

-- Pega as campanhas que já podem sair (agendadas vencidas, ou em andamento sem ninguém
-- cuidando) e trava por 170 s: dois disparos do worker nunca mexem na mesma campanha.
create or replace function public.broadcast_claim(p_limit int default 5)
returns setof public.broadcasts
language plpgsql security definer set search_path = public as $$
begin
  return query
  with due as (
    select b.id from public.broadcasts b
    where (b.status = 'agendada' and b.scheduled_at <= now())
       or (b.status = 'enviando' and (b.locked_until is null or b.locked_until < now()))
    order by b.scheduled_at
    limit greatest(p_limit, 1)
    for update skip locked
  )
  update public.broadcasts b set
    status = 'enviando',
    locked_until = now() + interval '170 seconds',
    started_at = coalesce(b.started_at, now())
  from due where b.id = due.id
  returning b.*;
end $$;
revoke all on function public.broadcast_claim(int) from public, anon, authenticated;

-- Resultado de um contato + contadores da campanha, de uma vez.
create or replace function public.broadcast_mark(p_recipient uuid, p_ok boolean, p_error text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare v_b uuid;
begin
  update public.broadcast_recipients r set
    status = case when p_ok then 'enviado' else 'falha' end,
    error = case when p_ok then null else left(p_error, 300) end,
    sent_at = case when p_ok then now() end
  where r.id = p_recipient and r.status = 'pendente'
  returning r.broadcast_id into v_b;
  if v_b is null then return; end if;
  update public.broadcasts b set
    sent = b.sent + case when p_ok then 1 else 0 end,
    failed = b.failed + case when p_ok then 0 else 1 end
  where b.id = v_b;
end $$;
revoke all on function public.broadcast_mark(uuid, boolean, text) from public, anon, authenticated;

-- Aciona o worker na hora (pg_net, sem esperar resposta): usado ao criar um envio imediato.
create or replace function public.broadcast_acionar()
returns void
language plpgsql security definer set search_path = public as $$
declare v_key text;
begin
  select value into v_key from public.platform_settings where key = 'signup_secret';
  if v_key is null or v_key = '' then return; end if;
  perform net.http_post(
    url := 'https://ywdctgawnfaheeeazzgb.supabase.co/functions/v1/broadcast-run',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-servidor-key', v_key),
    body := '{}'::jsonb
  );
end $$;
revoke all on function public.broadcast_acionar() from public, anon, authenticated;

-- Worker: a cada minuto.
select cron.unschedule('broadcast-run') where exists (select 1 from cron.job where jobname = 'broadcast-run');
select cron.schedule('broadcast-run', '* * * * *', $$
  select net.http_post(
    url := 'https://ywdctgawnfaheeeazzgb.supabase.co/functions/v1/broadcast-run',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-servidor-key', (select value from public.platform_settings where key = 'signup_secret')),
    body := '{}'::jsonb
  );
$$);
