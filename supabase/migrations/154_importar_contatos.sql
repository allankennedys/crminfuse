-- ============================================================
-- Importação de contatos por planilha
--
-- p_rows: [{ n, name, phone, email, tags[], value_cents, description, custom{} }]
-- Pula quem já existe (mesmo telefone, tolerante ao 9 extra) e linhas inválidas.
-- p_dry = true só confere e conta, sem gravar.
--
-- security INVOKER: vale a RLS (só a própria organização) e o guard de assinatura.
-- Quem não pode editar contatos recebe erro.
-- ============================================================
create or replace function public.crm_import_contacts(
  p_rows     jsonb,
  p_stage    uuid default null,
  p_tag      text default null,
  p_assigned uuid default null,
  p_dry      boolean default false
) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
  r jsonb;
  v_n int;
  v_name text;
  v_digits text;
  v_key text;
  v_tags text[];
  v_cents bigint;
  v_created int := 0;
  v_dup int := 0;
  v_invalid jsonb := '[]'::jsonb;
  v_seen text[] := '{}';
begin
  if v_org is null or not public.current_user_can('crm.contatos.editar') then
    raise exception 'Você não tem permissão para importar contatos.';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Formato inválido.'; end if;
  if jsonb_array_length(p_rows) > 1000 then raise exception 'Máximo de 1000 linhas por envio.'; end if;
  if p_stage is not null and not exists (select 1 from public.crm_stages where id = p_stage and organization_id = v_org) then
    raise exception 'Etapa inválida.';
  end if;
  if p_assigned is not null and not exists (select 1 from public.users where id = p_assigned and organization_id = v_org and is_active) then
    raise exception 'Responsável inválido.';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_n := coalesce((r->>'n')::int, 0);
    v_name := btrim(coalesce(r->>'name', ''));
    v_digits := regexp_replace(coalesce(r->>'phone', ''), '\D', '', 'g');
    -- sem DDI: celular/fixo brasileiro (10 ou 11 dígitos) ganha o 55
    if length(v_digits) in (10, 11) then v_digits := '55' || v_digits; end if;

    if v_name = '' then
      v_invalid := v_invalid || jsonb_build_object('n', v_n, 'reason', 'sem nome'); continue;
    end if;
    if length(v_name) > 120 then v_name := left(v_name, 120); end if;
    if length(v_digits) < 12 or length(v_digits) > 15 then
      v_invalid := v_invalid || jsonb_build_object('n', v_n, 'reason', 'telefone inválido'); continue;
    end if;

    v_key := public.crm_phone_key(v_digits);
    if v_key = any(v_seen)
       or exists (select 1 from public.crm_contacts c where c.organization_id = v_org and c.phone_key = v_key) then
      v_dup := v_dup + 1; continue;
    end if;
    v_seen := v_seen || v_key;

    v_tags := coalesce(array(select btrim(t) from jsonb_array_elements_text(coalesce(r->'tags', '[]'::jsonb)) t where btrim(t) <> ''), '{}');
    if p_tag is not null and btrim(p_tag) <> '' and not (btrim(p_tag) = any(v_tags)) then
      v_tags := v_tags || btrim(p_tag);
    end if;
    v_cents := coalesce((r->>'value_cents')::bigint, 0);

    if not p_dry then
      begin
        insert into public.crm_contacts
          (organization_id, stage_id, name, email, phone, tags, value_cents, description, custom, assigned_to, origem, created_by)
        values
          (v_org, p_stage, v_name, nullif(btrim(coalesce(r->>'email', '')), ''), v_digits, v_tags, greatest(v_cents, 0),
           nullif(btrim(coalesce(r->>'description', '')), ''), coalesce(r->'custom', '{}'::jsonb), p_assigned, 'Importação', auth.uid());
      exception when unique_violation then
        v_dup := v_dup + 1; continue;
      end;
    end if;
    v_created := v_created + 1;
  end loop;

  return jsonb_build_object('created', v_created, 'duplicates', v_dup, 'invalid', v_invalid);
end $$;
revoke all on function public.crm_import_contacts(jsonb, uuid, text, uuid, boolean) from public, anon;
grant execute on function public.crm_import_contacts(jsonb, uuid, text, uuid, boolean) to authenticated;
