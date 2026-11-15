-- Mensagens que o webhook não conseguiu gravar ficam guardadas aqui (o evento
-- completo), para não se perderem em silêncio: dá para ver o erro e reenviar o
-- evento. Sem políticas: só o service role (a função) lê e grava.
create table if not exists public.wa_webhook_failures (
  id          bigint generated always as identity primary key,
  session_id  uuid,
  event       text,
  error       text,
  payload     jsonb,
  created_at  timestamptz not null default now()
);
alter table public.wa_webhook_failures enable row level security;
create index if not exists idx_wa_webhook_failures_created on public.wa_webhook_failures(created_at desc);
