-- 006_username.sql
-- Login por username. O Supabase Auth continua usando email internamente
-- (username -> username@phgroups.local), mas o username é a identidade
-- visível do usuário. Cadastro público removido: só admin cria usuários.

-- Coluna username (única globalmente, case-insensitive via lower)
alter table public.users add column if not exists username text;

-- Backfill: usa a parte local do email atual
update public.users
set username = lower(split_part(email, '@', 1))
where username is null;

-- Índice único case-insensitive
create unique index if not exists idx_users_username_unique
  on public.users (lower(username));

-- Trigger de signup: agora também grava o username vindo do metadata
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  org_id uuid;
  uname text;
begin
  uname := lower(coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)));

  insert into public.organizations (name)
  values (coalesce(new.raw_user_meta_data->>'organization_name', uname))
  returning id into org_id;

  insert into public.users (id, organization_id, email, username, full_name, role)
  values (new.id, org_id, new.email, uname, new.raw_user_meta_data->>'full_name', 'admin');

  return new;
end;
$$;
