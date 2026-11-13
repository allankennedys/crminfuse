-- ============================================================
-- Mensagens automáticas (saudação e fora do horário) e motivo de perda
--
-- MENSAGENS AUTOMÁTICAS. A função wa-webhook, depois de gravar a mensagem do
-- cliente, pede o texto a wa_auto_reply_pick e envia pelo WhatsApp:
--   fora do horário → mensagem de ausência (no máximo 1 a cada 6 h por conversa)
--   senão, primeira mensagem de uma "rodada" → saudação (1 a cada 12 h)
-- A resposta automática é gravada com p_status = 'auto': não zera o contador
-- de não lidas e não conta como primeira resposta humana nos relatórios.
--
-- MOTIVO DE PERDA. Etapa pode ser marcada como "perdido": mover um contato
-- para ela pede um motivo (lista configurável). O gatilho limpa o motivo
-- quando o contato sai da etapa.
-- ============================================================

-- ---------- Mensagens automáticas ----------
alter table public.wa_settings
  add column if not exists auto_greeting_on boolean not null default false,
  add column if not exists auto_greeting_text text,
  add column if not exists auto_away_on boolean not null default false,
  add column if not exists auto_away_text text,
  add column if not exists business_hours jsonb not null
    default '{"days":[1,2,3,4,5],"start":"09:00","end":"18:00"}'::jsonb;

alter table public.wa_conversations
  add column if not exists last_auto_greeting_at timestamptz,
  add column if not exists last_auto_away_at timestamptz;

create or replace function public.wa_auto_reply_pick(p_conversation uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_conv  public.wa_conversations;
  v_set   public.wa_settings;
  v_local timestamp := (now() at time zone 'America/Sao_Paulo');
  v_hours jsonb;
  v_out   boolean;
  v_text  text;
  v_name  text;
  v_n     int;
begin
  select * into v_conv from public.wa_conversations c where c.id = p_conversation;
  if not found then return null; end if;
  select * into v_set from public.wa_settings s where s.organization_id = v_conv.organization_id;
  if not found then return null; end if;

  v_hours := coalesce(v_set.business_hours, '{"days":[1,2,3,4,5],"start":"09:00","end":"18:00"}'::jsonb);
  v_out := not (
    (v_hours->'days') @> to_jsonb(extract(dow from v_local)::int)
    and v_local::time >= (v_hours->>'start')::time
    and v_local::time <  (v_hours->>'end')::time
  );

  if v_set.auto_away_on and nullif(btrim(coalesce(v_set.auto_away_text, '')), '') is not null and v_out then
    update public.wa_conversations c set last_auto_away_at = now()
    where c.id = v_conv.id
      and (c.last_auto_away_at is null or c.last_auto_away_at < now() - interval '6 hours');
    if not found then return null; end if;
    v_text := v_set.auto_away_text;
  elsif v_set.auto_greeting_on and nullif(btrim(coalesce(v_set.auto_greeting_text, '')), '') is not null then
    -- Só abre a rodada: nenhuma outra mensagem do cliente nas últimas 12 h.
    select count(*) into v_n from public.wa_messages m
    where m.conversation_id = v_conv.id and not m.from_me and m.wa_timestamp > now() - interval '12 hours';
    if v_n > 1 then return null; end if;
    update public.wa_conversations c set last_auto_greeting_at = now()
    where c.id = v_conv.id
      and (c.last_auto_greeting_at is null or c.last_auto_greeting_at < now() - interval '12 hours');
    if not found then return null; end if;
    v_text := v_set.auto_greeting_text;
  else
    return null;
  end if;

  select split_part(btrim(coalesce(nullif(btrim(ct.name), ''), nullif(btrim(v_conv.push_name), ''), '')), ' ', 1)
  into v_name
  from (select 1) x left join public.crm_contacts ct on ct.id = v_conv.contact_id;
  v_name := coalesce(v_name, '');

  v_text := case when v_name = '' then replace(replace(v_text, ' {nome}', ''), '{nome}', '')
                 else replace(v_text, '{nome}', v_name) end;
  return nullif(btrim(v_text), '');
end;
$$;
revoke all on function public.wa_auto_reply_pick(uuid) from public, anon, authenticated;

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
    case when p_status = 'auto' then 'sent'
         else coalesce(p_status, case when p_from_me then 'sent' else 'received' end) end,
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
      -- Resposta automática não "lê" a mensagem do cliente.
      unread_count         = case when p_from_me then (case when p_status = 'auto' then c.unread_count else 0 end) else c.unread_count + 1 end,
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
        and t.first_response_at is null and v_ts >= t.opened_at
        -- Resposta automática não conta como primeira resposta humana.
        and p_status is distinct from 'auto';

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

-- ---------- Motivo de perda ----------
alter table public.crm_stages
  add column if not exists is_lost boolean not null default false;
alter table public.crm_stages drop constraint if exists crm_stages_lost_not_conversion;
alter table public.crm_stages add constraint crm_stages_lost_not_conversion
  check (not (is_lost and is_conversion));

alter table public.crm_contacts
  add column if not exists lost_reason text,
  add column if not exists lost_at timestamptz;

create table if not exists public.crm_funil_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  lost_reasons    text[] not null default array['Preço', 'Sem resposta', 'Comprou com concorrente', 'Sem interesse', 'Outro']
);
alter table public.crm_funil_settings enable row level security;
drop policy if exists crm_funil_settings_select on public.crm_funil_settings;
create policy crm_funil_settings_select on public.crm_funil_settings
  for select using (organization_id = public.current_org_id() and public.current_user_can('crm.funil.ver'));
drop policy if exists crm_funil_settings_write on public.crm_funil_settings;
create policy crm_funil_settings_write on public.crm_funil_settings
  for all using (organization_id = public.current_org_id() and public.current_user_can('crm.etapas.editar'))
  with check (organization_id = public.current_org_id() and public.current_user_can('crm.etapas.editar'));

create or replace function public.crm_contact_lost_touch()
returns trigger
language plpgsql as $$
begin
  if new.stage_id is distinct from old.stage_id or tg_op = 'INSERT' then
    if exists (select 1 from public.crm_stages s where s.id = new.stage_id and s.is_lost) then
      new.lost_at := coalesce(new.lost_at, now());
    else
      new.lost_reason := null;
      new.lost_at := null;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists crm_contacts_lost_touch on public.crm_contacts;
create trigger crm_contacts_lost_touch
  before update of stage_id on public.crm_contacts
  for each row execute function public.crm_contact_lost_touch();

-- Motivos de perda no período (relatório).
create or replace function public.crm_lost_reasons(p_from timestamptz, p_to timestamptz)
returns table (reason text, total bigint)
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(btrim(ct.lost_reason), ''), 'Sem motivo') as reason, count(*) as total
  from public.crm_contacts ct
  where ct.organization_id = public.current_org_id()
    and public.current_user_can('crm.contatos.ver')
    and ct.lost_at is not null
    and ct.lost_at >= p_from and ct.lost_at < p_to
  group by 1
  order by 2 desc;
$$;
revoke all on function public.crm_lost_reasons(timestamptz, timestamptz) from public, anon;
grant execute on function public.crm_lost_reasons(timestamptz, timestamptz) to authenticated;
