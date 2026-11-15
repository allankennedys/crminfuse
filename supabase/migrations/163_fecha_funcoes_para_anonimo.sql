-- ============================================================
-- Auditoria de segurança: o papel anônimo (a chave anon é pública, vai no
-- navegador) podia executar quase todas as funções SECURITY DEFINER do schema
-- public, porque o Postgres concede EXECUTE a PUBLIC por padrão. Várias aceitam
-- o id da organização como argumento quando não há usuário logado (é assim que o
-- service role as usa): crm_merge_duplicate_contacts(null) fundia/apagava
-- contatos de TODAS as empresas, crm_contact_claim/for_channel criavam contatos
-- em qualquer empresa, crm_contact_lookup lia contatos de outra empresa.
--
-- Correção: tira EXECUTE de PUBLIC e anon em tudo; mantém para authenticated e
-- service_role exatamente onde já tinham (funções que a 161 e outras já
-- restringiram continuam restritas). Só trial_days segue aberta ao anônimo
-- (a tela de cadastro mostra os dias de teste).
-- Funções novas também nascem sem acesso anônimo.
-- ============================================================
do $mig$
declare
  r record;
  v_auth boolean;
  v_svc  boolean;
begin
  for r in
    select p.oid, p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind in ('f', 'p')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    v_auth := has_function_privilege('authenticated', r.oid, 'execute');
    v_svc  := has_function_privilege('service_role', r.oid, 'execute');
    execute format('revoke execute on function %s from public, anon', r.sig);
    if v_auth then execute format('grant execute on function %s to authenticated', r.sig); end if;
    if v_svc  then execute format('grant execute on function %s to service_role', r.sig); end if;
  end loop;
end
$mig$;

grant execute on function public.trial_days() to anon, authenticated, service_role;

alter default privileges for role postgres in schema public revoke execute on functions from public, anon;
