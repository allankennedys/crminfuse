-- ============================================================
-- "Apenas CRM" pode reordenar e excluir etapas
--
-- A 018 liberou a escrita direta nas tabelas (criar/editar/mover etapas e
-- contatos) para crm_only, e o comentário de lá já prometia que ele "pode
-- criar/editar/mover contatos e etapas". Mas reordenar e excluir etapas
-- passam por RPCs security definer (crm_reorder_stages / crm_delete_stage,
-- de 013) que ficaram checando só ('admin','operator'). Resultado: o
-- crm_only levava "Sem permissão", que o PostgREST devolve como HTTP 400 no
-- drag-and-drop das colunas do kanban.
--
-- Recriamos as duas RPCs incluindo 'crm_only' na checagem. Corpo idêntico
-- ao de 013; muda só a lista de papéis. Roda depois de 017 (valor do enum
-- já commitado), então o uso de 'crm_only' aqui é seguro.
-- ============================================================

create or replace function public.crm_reorder_stages(p_ids uuid[])
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
begin
  if public.current_user_role() not in ('admin', 'operator', 'crm_only') then
    raise exception 'Sem permissão para reordenar etapas';
  end if;

  update public.crm_stages s
  set position = idx.ord - 1
  from unnest(p_ids) with ordinality as idx(id, ord)
  where s.id = idx.id and s.organization_id = v_org;
end;
$$;

create or replace function public.crm_delete_stage(
  p_id uuid,
  p_move_to uuid default null,
  p_unassign boolean default false
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
  v_count int;
begin
  if public.current_user_role() not in ('admin', 'operator', 'crm_only') then
    raise exception 'Sem permissão para excluir etapas';
  end if;

  if not exists (select 1 from public.crm_stages where id = p_id and organization_id = v_org) then
    raise exception 'Etapa não encontrada';
  end if;

  select count(*) into v_count from public.crm_contacts
  where stage_id = p_id and organization_id = v_org;

  if v_count > 0 then
    if p_unassign then
      -- Tira do funil: continuam existindo na página de Contatos.
      update public.crm_contacts set stage_id = null
      where stage_id = p_id and organization_id = v_org;
    else
      if p_move_to is null then
        raise exception 'A etapa tem % contato(s). Escolha para onde movê-los antes de excluir.', v_count;
      end if;
      if p_move_to = p_id then
        raise exception 'Escolha uma etapa diferente para receber os contatos.';
      end if;
      if not exists (select 1 from public.crm_stages where id = p_move_to and organization_id = v_org) then
        raise exception 'Etapa de destino não encontrada';
      end if;

      update public.crm_contacts set stage_id = p_move_to
      where stage_id = p_id and organization_id = v_org;
    end if;
  end if;

  delete from public.crm_stages where id = p_id and organization_id = v_org;
end;
$$;
