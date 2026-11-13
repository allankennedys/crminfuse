-- ============================================================
-- Cadastro e convite com o Google (etapa 2)
--
-- Para o Google criar usuário o cadastro precisa estar ligado no provedor de
-- autenticação. Isso reabre a porta de criação direta (signUp com a chave
-- pública), então o banco passa a decidir quem pode nascer em auth.users:
--   • provedor google  → pode; nasce SEM organização e SEM perfil (não vê nada
--     até concluir o cadastro da empresa ou aceitar um convite, feitos pelo servidor);
--   • criado pelas nossas funções (app_metadata.servidor = true) → pode;
--   • qualquer outro (ex.: signUp direto por e-mail) → recusado.
-- ============================================================
create or replace function public.bloquear_cadastro_direto()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.raw_app_meta_data->>'provider', 'email') = 'google'
     or coalesce(new.raw_app_meta_data->>'servidor', '') = 'true' then
    return new;
  end if;
  raise exception 'Cadastro direto desativado. Use a tela de cadastro do sistema.';
end $$;

drop trigger if exists a_bloquear_cadastro_direto on auth.users;
create trigger a_bloquear_cadastro_direto
  before insert on auth.users
  for each row execute function public.bloquear_cadastro_direto();

-- Quem chega pelo Google não ganha organização automática: o cadastro da empresa
-- (com CPF/CNPJ, limite por IP e plano) e o aceite de convite passam pelo servidor.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  org_id uuid;
  uname text;
begin
  if coalesce(new.raw_app_meta_data->>'provider', 'email') = 'google' then
    return new;
  end if;

  uname := lower(coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)));

  insert into public.organizations (name)
  values (coalesce(new.raw_user_meta_data->>'organization_name', uname))
  returning id into org_id;

  insert into public.users (id, organization_id, email, username, full_name, role)
  values (new.id, org_id, new.email, uname, new.raw_user_meta_data->>'full_name', 'admin');

  return new;
end;
$$;
