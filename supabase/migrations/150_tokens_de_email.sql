-- ============================================================
-- Login por e-mail: verificação de e-mail, recuperação de senha e troca de
-- e-mail. Tudo por links enviados pelo sistema (Resend), com a identidade da
-- Infuse. Cada link carrega um código de uso único; só o HASH fica no banco.
--   kind: 'verify'       confirma o e-mail do cadastro
--         'reset'        redefinir a senha (vale 1 hora)
--         'email_change' trocar o e-mail de acesso (guarda o novo em new_email)
-- Escrita e leitura só pelo servidor (função auth-email).
-- ============================================================

create table if not exists public.auth_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null check (kind in ('verify', 'reset', 'email_change')),
  token_hash  text not null unique,
  new_email   text,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists idx_auth_tokens_user on public.auth_tokens(user_id, kind, created_at desc);
alter table public.auth_tokens enable row level security;
-- Sem policies: nem o navegador lê nem escreve.
