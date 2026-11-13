-- ============================================================
-- Responder uma conversa concluída e sem responsável assume e reabre
--
-- Já valia para conversa na fila (121). Faltava a concluída sem dono: a
-- resposta saía, mas a conversa continuava concluída e sem atendente.
-- Agora responder pelo painel reabre o atendimento e atribui a quem
-- respondeu (histórico: "reaberta" e "atribuída").
-- ============================================================

create or replace function public.wa_ingest_message(
  p_session    uuid,
  p_pn_jid     text,
  p_lid_jid    text,
  p_push_name  text,
  p_wa_id      text,
  p_from_me    boolean,
  p_type       text,
  p_body       text,
  p_media_mime text default null,
  p_media_name text default null,
  p_has_media  boolean default false,
  p_media_path text default null,
  p_ts         timestamptz default null,
  p_status     text default null,
  p_sent_by    uuid default null,
  -- Clique em anúncio (Click-to-WhatsApp) que veio na mensagem: ctwa_clid,
  -- source_id, source_url, source_app, title. null = sem anúncio.
  p_ad         jsonb default null
)
returns table (conversation_id uuid, message_id uuid, inserted boolean, organization_id uuid)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_org      uuid;
  v_conv     public.wa_conversations;
  v_ticket   public.wa_tickets;
  v_jid      text := coalesce(p_pn_jid, p_lid_jid);
  v_phone    text := nullif(regexp_replace(split_part(coalesce(p_pn_jid, ''), '@', 1), '\D', '', 'g'), '');
  v_push     text := case when p_from_me then null else nullif(btrim(p_push_name), '') end;
  v_ts       timestamptz := coalesce(p_ts, now());
  v_msg      uuid;
  v_inserted boolean;
  v_preview  text;
  v_pick     record;
  v_keeper   uuid;
begin
  if v_jid is null or p_wa_id is null then
    raise exception 'Mensagem sem destinatário ou sem id';
  end if;

  select s.organization_id into v_org from public.whatsapp_sessions s where s.id = p_session;
  if v_org is null then
    raise exception 'Número % não existe', p_session;
  end if;

  select * into v_conv
  from public.wa_conversations c
  where c.session_id = p_session
    and (
      (p_pn_jid is not null and c.remote_jid = p_pn_jid)
      or (p_lid_jid is not null and (c.lid_jid = p_lid_jid or c.remote_jid = p_lid_jid))
    )
  order by (c.remote_jid = p_pn_jid) desc nulls last
  limit 1
  for update;

  if not found then
    insert into public.wa_conversations as c
      (organization_id, session_id, remote_jid, lid_jid, phone, push_name)
    values (v_org, p_session, v_jid, p_lid_jid, v_phone, v_push)
    on conflict (session_id, remote_jid) do update set updated_at = now()
    returning * into v_conv;
  else
    update public.wa_conversations c set
      lid_jid = coalesce(c.lid_jid, p_lid_jid),
      phone = coalesce(c.phone, v_phone),
      remote_jid = case
        when p_pn_jid is not null and c.remote_jid like '%@lid'
          and not exists (
            select 1 from public.wa_conversations o
            where o.session_id = p_session and o.remote_jid = p_pn_jid
          )
        then p_pn_jid
        else c.remote_jid
      end,
      push_name = coalesce(v_push, c.push_name),
      updated_at = now()
    where c.id = v_conv.id
    returning * into v_conv;
  end if;

  insert into public.wa_messages as m (
    organization_id, conversation_id, wa_message_id, from_me, sent_by, type, body,
    media_path, media_mime, media_name, media_status, status, wa_timestamp
  ) values (
    v_org, v_conv.id, p_wa_id, p_from_me, p_sent_by, p_type, p_body,
    p_media_path, p_media_mime, p_media_name,
    case when p_media_path is not null then 'ok' when p_has_media then 'pendente' end,
    coalesce(p_status, case when p_from_me then 'sent' else 'received' end),
    v_ts
  )
  on conflict on constraint wa_messages_conversation_id_wa_message_id_key do update set
    sent_by      = coalesce(m.sent_by, excluded.sent_by),
    media_path   = coalesce(m.media_path, excluded.media_path),
    media_status = case when excluded.media_path is not null then 'ok' else m.media_status end
  returning m.id, (m.xmax = 0) into v_msg, v_inserted;

  if v_inserted then
    v_preview := left(coalesce(
      nullif(btrim(p_body), ''),
      case p_type
        when 'image'    then '📷 Foto'
        when 'video'    then '🎥 Vídeo'
        when 'audio'    then '🎤 Áudio'
        when 'document' then '📄 ' || coalesce(p_media_name, 'Documento')
        when 'sticker'  then 'Figurinha'
        else 'Mensagem'
      end
    ), 160);

    update public.wa_conversations c set
      last_message_preview = case when v_ts >= coalesce(c.last_message_at, '-infinity') then v_preview else c.last_message_preview end,
      last_message_from_me = case when v_ts >= coalesce(c.last_message_at, '-infinity') then p_from_me else c.last_message_from_me end,
      last_message_at      = greatest(coalesce(c.last_message_at, '-infinity'), v_ts),
      unread_count         = case when p_from_me then 0 else c.unread_count + 1 end,
      status               = case when p_from_me then c.status else 'aberta' end,
      updated_at           = now()
    where c.id = v_conv.id;

    if not p_from_me then
      -- Cliente escreveu: precisa de um atendimento aberto.
      select * into v_ticket from public.wa_tickets t
      where t.conversation_id = v_conv.id and t.status <> 'concluido'
      for update;

      if not found then
        -- Volta para quem já cuidava dele, se essa pessoa ainda atende.
        v_keeper := case
          when v_conv.assigned_to is not null and public.wa_eligible(v_org, v_conv.assigned_to)
          then v_conv.assigned_to
        end;
        insert into public.wa_tickets
          (organization_id, conversation_id, session_id, status, assigned_to, opened_at, first_assigned_at)
        values (v_org, v_conv.id, p_session,
                case when v_keeper is null then 'fila' else 'em_atendimento' end,
                v_keeper, v_ts, case when v_keeper is not null then clock_timestamp() end)
        returning * into v_ticket;

        -- Responsável que não atende mais: a conversa volta para a fila.
        if v_conv.assigned_to is not null and v_keeper is null then
          update public.wa_conversations c set assigned_to = null, assigned_at = null where c.id = v_conv.id;
          v_conv.assigned_to := null;
        end if;
      end if;

      -- Contato do CRM e origem (anúncio ou frase). Nunca derruba a entrada
      -- da mensagem: falhou, a conversa segue e o contato fica para depois.
      begin
        perform public.wa_apply_origin(v_conv.id, p_body, p_ad);
      exception when others then
        raise warning 'wa_apply_origin: %', sqlerrm;
      end;

      if v_ticket.assigned_to is null then
        select * into v_pick from public.wa_pick_attendant(v_org, p_session, p_body);
        if v_pick.o_user is not null then
          perform public.wa_apply_assignment(v_conv.id, v_pick.o_user, null, 'auto', v_pick.o_reason);
        end if;
      end if;
    else
      -- Resposta nossa: a primeira marca o tempo de primeira resposta.
      update public.wa_tickets t set first_response_at = v_ts
      where t.conversation_id = v_conv.id and t.status <> 'concluido'
        and t.first_response_at is null and v_ts >= t.opened_at;

      -- Respondeu pelo painel uma conversa sem responsável: assume.
      if p_sent_by is not null and v_conv.assigned_to is null and public.wa_eligible(v_org, p_sent_by) then
        if exists (select 1 from public.wa_tickets t where t.conversation_id = v_conv.id and t.status = 'fila') then
          perform public.wa_apply_assignment(v_conv.id, p_sent_by, p_sent_by, 'atribuida', null);
        elsif not exists (select 1 from public.wa_tickets t where t.conversation_id = v_conv.id and t.status <> 'concluido') then
          -- Conversa concluída e sem responsável: responder reabre o
          -- atendimento (volta à fila) e já fica com quem respondeu.
          select * into v_ticket from public.wa_tickets t
          where t.conversation_id = v_conv.id order by t.opened_at desc limit 1 for update;
          if found then
            update public.wa_tickets t set
              status = 'fila', assigned_to = null, closed_at = null, closed_by = null,
              reopened_count = t.reopened_count + 1, last_reopened_at = clock_timestamp()
            where t.id = v_ticket.id;
          else
            insert into public.wa_tickets (organization_id, conversation_id, session_id, status)
            values (v_org, v_conv.id, p_session, 'fila');
          end if;
          update public.wa_conversations c set status = 'aberta', updated_at = now() where c.id = v_conv.id;
          insert into public.wa_conversation_events (organization_id, conversation_id, kind, by_user)
          values (v_org, v_conv.id, 'reaberta', p_sent_by);
          perform public.wa_apply_assignment(v_conv.id, p_sent_by, p_sent_by, 'atribuida', null);
        end if;
      end if;
    end if;
  end if;

  return query select v_conv.id, v_msg, v_inserted, v_org;
end;
$$;

revoke all on function public.wa_ingest_message(
  uuid, text, text, text, text, boolean, text, text, text, text, boolean, text, timestamptz, text, uuid, jsonb
) from public, anon, authenticated;
