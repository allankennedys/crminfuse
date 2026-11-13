-- ============================================================
-- Corrige o bloqueio de cadastro direto (153).
-- O Auth grava app_metadata DEPOIS de inserir o usuário, então o gatilho nunca via
-- app_metadata.servidor e recusava até o cadastro feito pelas nossas funções.
-- Agora as funções mandam um segredo em user_metadata.servidor_key (guardado em
-- platform_settings, que o app não lê). O gatilho confere o segredo e o REMOVE do
-- usuário logo em seguida, para ninguém ler o segredo pelo próprio perfil.
-- ============================================================
insert into public.platform_settings (key, value)
values ('signup_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

create or replace function public.bloquear_cadastro_direto()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_secret text;
begin
  if coalesce(new.raw_app_meta_data->>'provider', 'email') = 'google' then
    return new;
  end if;
  select value into v_secret from public.platform_settings where key = 'signup_secret';
  if v_secret is not null and coalesce(new.raw_user_meta_data->>'servidor_key', '') = v_secret then
    new.raw_user_meta_data := new.raw_user_meta_data - 'servidor_key';
    return new;
  end if;
  raise exception 'Cadastro direto desativado. Use a tela de cadastro do sistema.';
end $$;
