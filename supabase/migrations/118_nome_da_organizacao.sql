-- ============================================================
-- Admin renomeia a própria organização
--
-- O nome aparece no cabeçalho do CRM, ao lado da logo. organizations só
-- tem política de leitura (001); a escrita é esta RPC, para o admin mexer
-- no NOME e em mais nada da linha — e só da organização dele.
-- ============================================================

create or replace function public.org_rename(p_name text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
begin
  if not exists (
    select 1 from public.users u
    where u.id = auth.uid() and u.role = 'admin' and u.is_active
  ) then
    raise exception 'Só administradores podem mudar o nome da organização';
  end if;

  if length(v_name) < 2 or length(v_name) > 60 then
    raise exception 'O nome precisa ter entre 2 e 60 caracteres';
  end if;

  update public.organizations set name = v_name where id = public.current_org_id();
  return v_name;
end;
$$;

revoke all on function public.org_rename(text) from public, anon;
grant execute on function public.org_rename(text) to authenticated;
