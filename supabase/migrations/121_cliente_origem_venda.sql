-- ============================================================
-- Cliente no atendimento: contato do CRM automático, origem automática
-- (anúncio e frases) e venda lançada pela conversa
--
-- 1. CONTATO AUTOMÁTICO. Cliente escreveu = existe um contato no CRM, no
--    começo do funil, com o canal = número da empresa por onde chegou. Achar
--    ou criar segue a regra da 069 (lock por número, um contato por número e
--    canal), mas sem exigir "editar contatos": quem chama é a mensagem
--    chegando ou o atendente lançando venda pela conversa que ele enxerga.
--
-- 2. ANÚNCIO. Mensagem que chega de um anúncio Click-to-WhatsApp traz o
--    clique (ctwa_clid). Ele vai para o contato e a origem vira "Anúncio
--    Instagram/Facebook" — com isso a venda lançada depois segue sozinha
--    para a Meta pelo caminho que já existe (020/033/072 + crm-worker).
--
-- 3. FRASES. Para as outras fontes, a organização cadastra frases: "se a
--    mensagem contém X, a origem é Y". Vale enquanto o contato está sem
--    origem.
--
-- 4. CARTÃO DO CLIENTE. wa_client_card / wa_client_update / wa_launch_sale:
--    o atendente lê e edita o contato e lança venda SEM ganhar acesso ao CRM
--    inteiro — a porta é a conversa, conferida por wa_can_see.
-- ============================================================

-- ------------------------------------------------------------
-- Frases de origem
-- ------------------------------------------------------------
create table if not exists public.wa_source_rules (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  position        int not null default 0,
  phrase          text not null check (length(btrim(phrase)) >= 2),
  origem          text not null check (length(btrim(origem)) >= 2),
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

create index if not exists idx_wa_source_rules_org on public.wa_source_rules(organization_id, position, created_at);

alter table public.wa_source_rules enable row level security;

drop policy if exists wa_source_rules_all on public.wa_source_rules;
create policy wa_source_rules_all on public.wa_source_rules
  for all using (organization_id = public.current_org_id() and public.current_user_can('atendimento.configurar'))
  with check (organization_id = public.current_org_id() and public.current_user_can('atendimento.configurar'));

-- ------------------------------------------------------------
-- Anúncio guardado na conversa (para mostrar no cartão)
-- ------------------------------------------------------------
alter table public.wa_conversations
  add column if not exists ad_ctwa_clid  text,
  add column if not exists ad_source_id  text,
  add column if not exists ad_source_url text,
  add column if not exists ad_source_app text,
  add column if not exists ad_title      text,
  add column if not exists ad_at         timestamptz;

-- ------------------------------------------------------------
-- Telefone legível, para o canal do contato
-- ------------------------------------------------------------
create or replace function public.wa_format_phone(p_phone text)
returns text
language sql immutable as $$
  select case
    when d = '' then null
    when d ~ '^55\d{10,11}$' then regexp_replace(d, '^55(\d{2})(\d{4,5})(\d{4})$', '+55 (\1) \2-\3')
    else '+' || d
  end
  from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d) t;
$$;

-- ------------------------------------------------------------
-- Achar ou criar o contato da conversa
-- ------------------------------------------------------------
create or replace function public.wa_ensure_contact(p_conversation uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_conv    public.wa_conversations;
  v_key     text;
  v_channel text;
  v_num     text;
  v_id      uuid;
  v_stage   uuid;
begin
  select * into v_conv from public.wa_conversations c where c.id = p_conversation;
  if not found then
    return null;
  end if;
  if v_conv.contact_id is not null
     and exists (select 1 from public.crm_contacts ct where ct.id = v_conv.contact_id) then
    return v_conv.contact_id;
  end if;

  -- Chave da conversa no contato: é como o contato sem telefone (só LID)
  -- continua sendo reconhecido.
  v_key := 'wa:' || v_conv.id;
  select public.wa_format_phone(s.phone_number) into v_channel
  from public.whatsapp_sessions s where s.id = v_conv.session_id;

  v_num := public.crm_phone_id(coalesce(v_conv.phone, ''));
  if v_num is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_conv.organization_id::text || ':' || v_num, 0));
  else
    perform pg_advisory_xact_lock(hashtextextended(v_conv.organization_id::text || ':conv:' || v_key, 0));
  end if;

  select l.contact_id into v_id
  from public.crm_contact_lookup(v_conv.organization_id, v_conv.phone, v_key, v_channel) l;

  if v_id is null then
    select s.id into v_stage from public.crm_stages s
    where s.organization_id = v_conv.organization_id
    order by s.position
    limit 1;

    begin
      insert into public.crm_contacts (organization_id, name, phone, conversation_id, stage_id, channel)
      values (
        v_conv.organization_id,
        coalesce(nullif(btrim(v_conv.push_name), ''), public.wa_format_phone(v_conv.phone), 'Contato do WhatsApp'),
        v_conv.phone,
        v_key,
        v_stage,
        v_channel
      )
      returning id into v_id;
    exception when unique_violation then
      select l.contact_id into v_id
      from public.crm_contact_lookup(v_conv.organization_id, v_conv.phone, v_key, v_channel) l;
      if v_id is null then raise; end if;
    end;
  end if;

  update public.wa_conversations c set contact_id = v_id where c.id = v_conv.id;
  return v_id;
end;
$$;

revoke all on function public.wa_ensure_contact(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- Origem: anúncio (forte) ou frase (quando ainda não há origem)
-- ------------------------------------------------------------
create or replace function public.wa_apply_origin(p_conversation uuid, p_text text, p_ad jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_conv    public.wa_conversations;
  v_contact public.crm_contacts;
  v_id      uuid;
  v_clid    text := nullif(btrim(coalesce(p_ad->>'ctwa_clid', '')), '');
  v_source  text := nullif(btrim(coalesce(p_ad->>'source_id', '')), '');
  v_app     text := lower(coalesce(p_ad->>'source_app', ''));
  v_label   text;
  v_origem  text;
  v_txt     text;
begin
  select * into v_conv from public.wa_conversations c where c.id = p_conversation;
  v_id := public.wa_ensure_contact(p_conversation);
  if v_id is null then
    return;
  end if;
  select * into v_contact from public.crm_contacts ct where ct.id = v_id;

  if v_clid is not null or v_source is not null then
    update public.wa_conversations c set
      ad_ctwa_clid  = coalesce(c.ad_ctwa_clid, v_clid),
      ad_source_id  = coalesce(c.ad_source_id, v_source),
      ad_source_url = coalesce(c.ad_source_url, nullif(btrim(coalesce(p_ad->>'source_url', '')), '')),
      ad_source_app = coalesce(c.ad_source_app, nullif(v_app, '')),
      ad_title      = coalesce(c.ad_title, nullif(btrim(coalesce(p_ad->>'title', '')), '')),
      ad_at         = coalesce(c.ad_at, now())
    where c.id = v_conv.id;

    v_label := case v_app
      when 'instagram' then 'Anúncio Instagram'
      when 'facebook' then 'Anúncio Facebook'
      else 'Anúncio'
    end;

    -- O clique é prova de anúncio: vale por cima de uma origem que não diz
    -- anúncio (frase, digitada). Clique já gravado não é trocado.
    update public.crm_contacts ct set
      ctwaclid  = coalesce(nullif(btrim(coalesce(ct.ctwaclid, '')), ''), v_clid),
      source_id = coalesce(nullif(btrim(coalesce(ct.source_id, '')), ''), v_source),
      origem    = case when public.crm_origem_is_ad(ct.origem) then ct.origem else v_label end
    where ct.id = v_id;
    return;
  end if;

  if nullif(btrim(coalesce(v_contact.origem, '')), '') is not null or coalesce(p_text, '') = '' then
    return;
  end if;

  v_txt := lower(extensions.unaccent(p_text));
  select r.origem into v_origem
  from public.wa_source_rules r
  where r.organization_id = v_conv.organization_id
    and r.active
    and position(lower(extensions.unaccent(btrim(r.phrase))) in v_txt) > 0
  order by r.position, r.created_at
  limit 1;

  if v_origem is not null then
    update public.crm_contacts ct set origem = btrim(v_origem) where ct.id = v_id;
  end if;
end;
$$;

revoke all on function public.wa_apply_origin(uuid, text, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------
-- Entrada de mensagem: 120 + p_ad + contato/origem
-- ------------------------------------------------------------
drop function if exists public.wa_ingest_message(
  uuid, text, text, text, text, boolean, text, text, text, text, boolean, text, timestamptz, text, uuid
);

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

      -- Respondeu pelo painel uma conversa da fila: assume.
      if p_sent_by is not null and v_conv.assigned_to is null and public.wa_eligible(v_org, p_sent_by)
         and exists (select 1 from public.wa_tickets t where t.conversation_id = v_conv.id and t.status = 'fila') then
        perform public.wa_apply_assignment(v_conv.id, p_sent_by, p_sent_by, 'atribuida', null);
      end if;
    end if;
  end if;

  return query select v_conv.id, v_msg, v_inserted, v_org;
end;
$$;

revoke all on function public.wa_ingest_message(
  uuid, text, text, text, text, boolean, text, text, text, text, boolean, text, timestamptz, text, uuid, jsonb
) from public, anon, authenticated;

-- ------------------------------------------------------------
-- Cartão do cliente
-- ------------------------------------------------------------

-- A conversa como o usuário a enxerga (mesma regra da RLS), travada.
create or replace function public.wa_visible_conversation(p_conversation uuid)
returns public.wa_conversations
language plpgsql security definer set search_path = public as $$
declare
  v_conv public.wa_conversations;
begin
  select * into v_conv from public.wa_conversations c
  where c.id = p_conversation and public.wa_can_see(c.organization_id, c.assigned_to);
  if not found then
    raise exception 'Conversa não encontrada';
  end if;
  return v_conv;
end;
$$;

revoke all on function public.wa_visible_conversation(uuid) from public, anon, authenticated;

create or replace function public.wa_client_card(p_conversation uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_conv public.wa_conversations := public.wa_visible_conversation(p_conversation);
  v_ct   public.crm_contacts;
  v_out  jsonb;
begin
  select * into v_ct from public.crm_contacts ct where ct.id = v_conv.contact_id;

  select jsonb_build_object(
    'contact', case when v_ct.id is null then null else jsonb_build_object(
      'id', v_ct.id,
      'name', v_ct.name,
      'phone', v_ct.phone,
      'email', v_ct.email,
      'origem', v_ct.origem,
      'channel', v_ct.channel,
      'stage', (select s.name from public.crm_stages s where s.id = v_ct.stage_id),
      'sales_count', coalesce(v_ct.sales_count, 0),
      'sales_total_cents', coalesce(v_ct.sales_total_cents, 0),
      'from_ad', nullif(btrim(coalesce(v_ct.ctwaclid, '')), '') is not null or public.crm_origem_is_ad(v_ct.origem),
      'has_click', nullif(btrim(coalesce(v_ct.ctwaclid, '')), '') is not null,
      'created_at', v_ct.created_at
    ) end,
    'ad', case when v_conv.ad_ctwa_clid is null and v_conv.ad_source_id is null then null else jsonb_build_object(
      'app', v_conv.ad_source_app, 'title', v_conv.ad_title, 'url', v_conv.ad_source_url, 'at', v_conv.ad_at
    ) end,
    'sales', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'value_cents', s.value_cents, 'sold_at', s.sold_at, 'payment_method', s.payment_method
      ) order by s.sold_at desc), '[]'::jsonb)
      from (
        select * from public.crm_sales s where s.contact_id = v_ct.id order by s.sold_at desc limit 5
      ) s
    ),
    -- Sugestões para o campo origem: as das frases e as mais usadas.
    'origens', (
      select coalesce(jsonb_agg(o order by o), '[]'::jsonb) from (
        select distinct btrim(r.origem) as o from public.wa_source_rules r
        where r.organization_id = v_conv.organization_id
        union
        select o from (
          select btrim(ct.origem) as o, count(*) as n from public.crm_contacts ct
          where ct.organization_id = v_conv.organization_id and nullif(btrim(coalesce(ct.origem, '')), '') is not null
          group by 1 order by 2 desc limit 15
        ) top
        union select 'Anúncio Instagram' union select 'Anúncio Facebook' union select 'Indicação'
      ) x
    )
  ) into v_out;
  return v_out;
end;
$$;

create or replace function public.wa_client_update(
  p_conversation uuid, p_name text, p_email text, p_origem text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_conv public.wa_conversations := public.wa_visible_conversation(p_conversation);
  v_id   uuid;
begin
  v_id := public.wa_ensure_contact(v_conv.id);
  update public.crm_contacts ct set
    name   = coalesce(nullif(btrim(coalesce(p_name, '')), ''), ct.name),
    email  = nullif(btrim(coalesce(p_email, '')), ''),
    origem = nullif(btrim(coalesce(p_origem, '')), '')
  where ct.id = v_id;
  return public.wa_client_card(v_conv.id);
end;
$$;

create or replace function public.wa_launch_sale(
  p_conversation uuid,
  p_value_cents  bigint,
  p_payment      text default null,
  p_sold_at      timestamptz default null,
  p_note         text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_conv    public.wa_conversations := public.wa_visible_conversation(p_conversation);
  v_id      uuid;
  v_sale    uuid;
  v_payment text := nullif(lower(btrim(coalesce(p_payment, ''))), '');
  v_ct      public.crm_contacts;
begin
  if coalesce(p_value_cents, 0) <= 0 then
    raise exception 'Informe um valor maior que zero';
  end if;
  if v_payment is not null and v_payment not in ('pix', 'credito', 'debito', 'boleto') then
    raise exception 'Forma de pagamento inválida';
  end if;

  v_id := public.wa_ensure_contact(v_conv.id);

  insert into public.crm_sales (contact_id, value_cents, sold_at, note, payment_method, created_by)
  values (v_id, p_value_cents, coalesce(p_sold_at, now()), nullif(btrim(coalesce(p_note, '')), ''), v_payment, auth.uid())
  returning id into v_sale;

  select * into v_ct from public.crm_contacts ct where ct.id = v_id;
  return jsonb_build_object(
    'sale_id', v_sale,
    'from_ad', nullif(btrim(coalesce(v_ct.ctwaclid, '')), '') is not null or public.crm_origem_is_ad(v_ct.origem)
  );
end;
$$;

revoke all on function public.wa_client_card(uuid) from public, anon;
revoke all on function public.wa_client_update(uuid, text, text, text) from public, anon;
revoke all on function public.wa_launch_sale(uuid, bigint, text, timestamptz, text) from public, anon;
grant execute on function public.wa_client_card(uuid) to authenticated;
grant execute on function public.wa_client_update(uuid, text, text, text) to authenticated;
grant execute on function public.wa_launch_sale(uuid, bigint, text, timestamptz, text) to authenticated;
