-- ============================================================
-- Textos na tela sem travessão (—)
--
-- A conclusão de atendimento juntava motivo e nota com " — " no histórico
-- da conversa; agora é "Motivo: nota". As notas já gravadas são ajustadas.
-- ============================================================

create or replace function public.wa_conclude(p_conversation uuid, p_reason text default null, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_conv   public.wa_conversations;
  v_me     uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into v_conv from public.wa_conversations c
  where c.id = p_conversation and c.organization_id = public.current_org_id()
  for update;
  if not found then
    raise exception 'Conversa não encontrada';
  end if;

  if not coalesce(
    v_conv.assigned_to = v_me
    or public.current_user_can('atendimento.atribuir')
    or (v_conv.assigned_to is null and public.wa_can_see(v_conv.organization_id, v_conv.assigned_to)),
    false
  ) then
    raise exception 'Só o responsável pode concluir este atendimento';
  end if;

  if v_conv.status = 'resolvida' then
    return;
  end if;

  update public.wa_tickets t set
    status = 'concluido', closed_at = clock_timestamp(), closed_by = v_me,
    conclusion = v_reason, conclusion_note = v_note
  where t.conversation_id = v_conv.id and t.status <> 'concluido';

  update public.wa_conversations c set status = 'resolvida', updated_at = now() where c.id = v_conv.id;

  insert into public.wa_conversation_events (organization_id, conversation_id, kind, by_user, note)
  values (v_conv.organization_id, v_conv.id, 'resolvida', v_me,
          nullif(concat_ws(': ', v_reason, v_note), ''));

  perform public.wa_dispatch_queue(v_conv.organization_id);
end;
$$;

update public.wa_conversation_events
set note = replace(note, ' — ', ': ')
where note like '% — %';
