-- ============================================================
-- Ao tirar um atendente da organização, o admin escolhe o destino das conversas
-- abertas dele: outro atendente, distribuição aleatória ou voltar para a fila.
-- Só o servidor (service role, via admin-users) chama esta função.
-- Respeita os números que cada atendente pode usar (wa_user_has_session).
-- ============================================================
create or replace function public.wa_reassign_user(p_from uuid, p_mode text, p_to uuid default null)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_conv record;
  v_pick uuid;
  v_total int := 0;
begin
  select organization_id into v_org from public.users where id = p_from;
  if v_org is null then return 0; end if;
  if p_mode not in ('user', 'random', 'queue') then raise exception 'modo inválido'; end if;

  if p_mode = 'user' then
    if p_to is null or p_to = p_from
       or not exists (select 1 from public.users where id = p_to and organization_id = v_org and is_active) then
      raise exception 'destino inválido';
    end if;
  end if;

  for v_conv in
    select id, session_id from public.wa_conversations
    where organization_id = v_org and assigned_to = p_from and status = 'aberta'
  loop
    v_pick := null;
    if p_mode = 'user' then
      v_pick := p_to;
    elsif p_mode = 'random' then
      select u.id into v_pick from public.users u
      where u.organization_id = v_org and u.is_active and u.id <> p_from
        and public.wa_user_has_session(u.id, v_conv.session_id)
      order by (u.role = 'admin'), random() limit 1;
    end if;
    -- 'queue' (ou ninguém elegível no aleatório): volta para a fila.
    update public.wa_conversations
       set assigned_to = v_pick, assigned_at = case when v_pick is null then null else now() end,
           assigned_by = null, updated_at = now()
     where id = v_conv.id;
    v_total := v_total + 1;
  end loop;
  return v_total;
end $$;
revoke all on function public.wa_reassign_user(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.wa_reassign_user(uuid, text, uuid) to service_role;
