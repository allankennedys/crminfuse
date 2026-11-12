-- ============================================================
-- Atendimentos (tickets), limite de simultâneos, conclusão/reabertura e
-- relatório
--
-- ATENDIMENTO ≠ CONVERSA. A conversa é o histórico inteiro com o cliente;
-- um atendimento é cada vez que ele procura a empresa:
--
--   cliente escreve, sem atendimento aberto → abre um (status 'fila')
--   alguém fica responsável ................ 'em_atendimento'
--   concluir (com motivo e nota) ........... 'concluido'
--   reabrir ................................ volta, e conta a reabertura
--   cliente escreve depois de concluído .... abre um atendimento NOVO
--
-- É daqui que saem o tempo médio de atendimento (aberto → concluído), o de
-- primeira resposta (aberto → primeira mensagem nossa) e a espera na fila
-- (aberto → primeiro responsável).
--
-- LIMITE DE SIMULTÂNEOS: padrão da organização (null = livre) com exceção
-- por atendente (wa_agent_limits: linha com null = livre; sem linha =
-- padrão). Conta atendimentos 'em_atendimento' da pessoa. A distribuição
-- automática pula quem está no limite; quando alguém conclui ou passa
-- adiante, a fila anda (wa_dispatch_queue). Quem tem "atribuir" pode passar
-- do limite atribuindo à mão; atendente transferindo, não.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Configuração
-- ------------------------------------------------------------
alter table public.wa_settings
  add column if not exists max_open_per_agent int
    check (max_open_per_agent is null or max_open_per_agent > 0),
  add column if not exists conclusion_reasons text[] not null
    default array['Dúvida resolvida', 'Venda realizada', 'Sem retorno do cliente', 'Encaminhado para outro setor'];

create table if not exists public.wa_agent_limits (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  -- null = livre para esta pessoa, mesmo com limite padrão
  max_open        int check (max_open is null or max_open > 0),
  primary key (organization_id, user_id)
);

alter table public.wa_agent_limits enable row level security;

drop policy if exists wa_limits_select on public.wa_agent_limits;
create policy wa_limits_select on public.wa_agent_limits
  for select using (organization_id = public.current_org_id());

drop policy if exists wa_limits_write on public.wa_agent_limits;
create policy wa_limits_write on public.wa_agent_limits
  for all using (organization_id = public.current_org_id() and public.current_user_can('atendimento.configurar'))
  with check (organization_id = public.current_org_id() and public.current_user_can('atendimento.configurar'));

-- ------------------------------------------------------------
-- 2. Atendimentos
-- ------------------------------------------------------------
create table if not exists public.wa_tickets (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  conversation_id   uuid not null references public.wa_conversations(id) on delete cascade,
  session_id        uuid references public.whatsapp_sessions(id) on delete set null,
  status            text not null default 'fila' check (status in ('fila', 'em_atendimento', 'concluido')),
  assigned_to       uuid references public.users(id) on delete set null,
  opened_at         timestamptz not null default clock_timestamp(),
  first_assigned_at timestamptz,
  first_response_at timestamptz,
  closed_at         timestamptz,
  closed_by         uuid references public.users(id) on delete set null,
  conclusion        text,
  conclusion_note   text,
  reopened_count    int not null default 0,
  last_reopened_at  timestamptz
);

-- Um atendimento aberto por conversa, no máximo.
create unique index if not exists uq_wa_tickets_open
  on public.wa_tickets(conversation_id) where status <> 'concluido';
create index if not exists idx_wa_tickets_opened on public.wa_tickets(organization_id, opened_at);
create index if not exists idx_wa_tickets_closed on public.wa_tickets(organization_id, closed_at) where closed_at is not null;
create index if not exists idx_wa_tickets_agent on public.wa_tickets(organization_id, assigned_to, status);

alter table public.wa_tickets enable row level security;

drop policy if exists wa_tickets_select on public.wa_tickets;
create policy wa_tickets_select on public.wa_tickets
  for select using (exists (select 1 from public.wa_conversations c where c.id = conversation_id));

-- Conversas abertas de antes desta migration ganham um atendimento.
insert into public.wa_tickets (organization_id, conversation_id, session_id, status, assigned_to, opened_at, first_assigned_at)
select c.organization_id, c.id, c.session_id,
       case when c.assigned_to is null then 'fila' else 'em_atendimento' end,
       c.assigned_to, coalesce(c.last_message_at, c.created_at), c.assigned_at
from public.wa_conversations c
where c.status = 'aberta'
  and not exists (select 1 from public.wa_tickets t where t.conversation_id = c.id and t.status <> 'concluido');

-- ------------------------------------------------------------
-- 3. Capacidade
-- ------------------------------------------------------------
create or replace function public.wa_agent_limit(p_org uuid, p_user uuid)
returns int
language plpgsql stable security definer set search_path = public as $$
declare
  v_row public.wa_agent_limits;
begin
  select * into v_row from public.wa_agent_limits l where l.organization_id = p_org and l.user_id = p_user;
  if found then
    return v_row.max_open; -- null = livre
  end if;
  return (select s.max_open_per_agent from public.wa_settings s where s.organization_id = p_org);
end;
$$;

create or replace function public.wa_agent_has_capacity(p_org uuid, p_user uuid)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_limit int := public.wa_agent_limit(p_org, p_user);
begin
  if v_limit is null then
    return true;
  end if;
  return (
    select count(*) from public.wa_tickets t
    where t.organization_id = p_org and t.assigned_to = p_user and t.status = 'em_atendimento'
  ) < v_limit;
end;
$$;

revoke all on function public.wa_agent_limit(uuid, uuid) from public, anon, authenticated;
revoke all on function public.wa_agent_has_capacity(uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. Quem recebe: igual à 119, respeitando o limite
-- ------------------------------------------------------------
create or replace function public.wa_pick_attendant(
  p_org uuid, p_session uuid, p_text text,
  out o_user uuid, out o_reason text
)
language plpgsql security definer set search_path = public as $$
declare
  v_set  public.wa_settings;
  v_rule public.wa_routing_rules;
  v_text text := lower(extensions.unaccent(coalesce(p_text, '')));
  v_kw   text;
begin
  for v_rule in
    select * from public.wa_routing_rules r
    where r.organization_id = p_org and r.active
    order by r.position, r.created_at
  loop
    -- Atendente inativo ou no limite: a regra não vale agora.
    continue when not public.wa_eligible(p_org, v_rule.target_user)
               or not public.wa_agent_has_capacity(p_org, v_rule.target_user);

    if v_rule.kind = 'numero' and v_rule.session_id = p_session then
      o_user := v_rule.target_user;
      o_reason := 'regra por número';
      return;
    end if;

    if v_rule.kind = 'palavra' and v_text <> '' then
      select k into v_kw from unnest(v_rule.keywords) k
      where position(lower(extensions.unaccent(k)) in v_text) > 0
      limit 1;
      if v_kw is not null then
        o_user := v_rule.target_user;
        o_reason := format('regra pela palavra "%s"', v_kw);
        return;
      end if;
    end if;
  end loop;

  select * into v_set from public.wa_settings s where s.organization_id = p_org;
  if not found or v_set.assign_mode = 'manual' then
    return;
  end if;

  if v_set.assign_mode = 'fixo' then
    if v_set.fixed_user is not null
       and public.wa_eligible(p_org, v_set.fixed_user)
       and public.wa_agent_has_capacity(p_org, v_set.fixed_user) then
      o_user := v_set.fixed_user;
      o_reason := 'distribuição fixa';
    end if;
    return;
  end if;

  select u.id into o_user
  from public.users u
  where u.organization_id = p_org
    and u.is_active
    and public.user_has_perm(u.id, 'atendimento.ver')
    and (cardinality(v_set.pool) = 0 or u.id = any(v_set.pool))
    and public.wa_agent_has_capacity(p_org, u.id)
  order by
    case when v_set.assign_mode = 'rodizio' then (
      select max(e.created_at) from public.wa_conversation_events e
      where e.organization_id = p_org and e.kind = 'auto' and e.to_user = u.id
    ) end asc nulls first,
    random()
  limit 1;

  if o_user is not null then
    o_reason := case v_set.assign_mode when 'rodizio' then 'rodízio' else 'sorteio' end;
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 5. Aplicar uma atribuição (conversa + atendimento aberto + histórico)
-- ------------------------------------------------------------
create or replace function public.wa_apply_assignment(
  p_conversation uuid, p_to uuid, p_by uuid, p_kind text, p_note text default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_conv public.wa_conversations;
begin
  select * into v_conv from public.wa_conversations c where c.id = p_conversation;

  update public.wa_conversations c set
    assigned_to = p_to,
    assigned_at = case when p_to is null then null else now() end,
    assigned_by = p_by,
    updated_at  = now()
  where c.id = p_conversation;

  update public.wa_tickets t set
    assigned_to = p_to,
    status = case when p_to is null then 'fila' else 'em_atendimento' end,
    first_assigned_at = case when p_to is null then t.first_assigned_at else coalesce(t.first_assigned_at, clock_timestamp()) end
  where t.conversation_id = p_conversation and t.status <> 'concluido';

  insert into public.wa_conversation_events (organization_id, conversation_id, kind, from_user, to_user, by_user, note)
  values (v_conv.organization_id, p_conversation, p_kind, v_conv.assigned_to, p_to, p_by,
          nullif(btrim(coalesce(p_note, '')), ''));
end;
$$;

revoke all on function public.wa_apply_assignment(uuid, uuid, uuid, text, text) from public, anon, authenticated;

-- A fila anda: atendimentos sem responsável, do mais antigo, recebem alguém
-- se a distribuição (ou uma regra) tiver quem receba.
create or replace function public.wa_dispatch_queue(p_org uuid)
returns int
language plpgsql security definer set search_path = public as $$
declare
  r      record;
  v_pick record;
  v_text text;
  v_n    int := 0;
begin
  for r in
    select t.id, t.conversation_id, t.opened_at, c.session_id
    from public.wa_tickets t
    join public.wa_conversations c on c.id = t.conversation_id
    where t.organization_id = p_org and t.status = 'fila' and c.assigned_to is null
    order by t.opened_at
    limit 50
    for update of t skip locked
  loop
    select m.body into v_text
    from public.wa_messages m
    where m.conversation_id = r.conversation_id and not m.from_me and m.wa_timestamp >= r.opened_at
    order by m.wa_timestamp
    limit 1;

    select * into v_pick from public.wa_pick_attendant(p_org, r.session_id, v_text);
    if v_pick.o_user is not null then
      perform public.wa_apply_assignment(r.conversation_id, v_pick.o_user, null, 'auto', v_pick.o_reason);
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

revoke all on function public.wa_dispatch_queue(uuid) from public, anon, authenticated;

-- Botão "distribuir a fila agora" / depois de salvar a configuração.
create or replace function public.wa_dispatch_now()
returns int
language plpgsql security definer set search_path = public as $$
begin
  if not public.current_user_can('atendimento.configurar') then
    raise exception 'Sem permissão';
  end if;
  return public.wa_dispatch_queue(public.current_org_id());
end;
$$;

-- ------------------------------------------------------------
-- 6. Entrada de mensagem: 119 + atendimentos
-- ------------------------------------------------------------
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
  p_sent_by    uuid default null
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

  if v_conv.contact_id is null and v_conv.phone is not null then
    update public.wa_conversations c set contact_id = (
      select ct.id from public.crm_contacts ct
      where ct.organization_id = v_org
        and ct.phone is not null
        and public.crm_phone_id(ct.phone) = public.crm_phone_id(v_conv.phone)
      order by ct.updated_at desc
      limit 1
    )
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
  uuid, text, text, text, text, boolean, text, text, text, text, boolean, text, timestamptz, text, uuid
) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 7. Transferir (119) + limite + fila andando
-- ------------------------------------------------------------
create or replace function public.wa_transfer(p_conversation uuid, p_to uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_conv  public.wa_conversations;
  v_me    uuid := auth.uid();
  v_ok    boolean;
  v_super boolean := public.current_user_can('atendimento.atribuir');
  v_name  text;
begin
  select * into v_conv from public.wa_conversations c
  where c.id = p_conversation and c.organization_id = public.current_org_id()
  for update;
  if not found then
    raise exception 'Conversa não encontrada';
  end if;

  v_ok := v_super
    or (v_conv.assigned_to = v_me and public.current_user_can('atendimento.transferir'))
    or (v_conv.assigned_to is null and p_to = v_me
        and public.wa_can_see(v_conv.organization_id, v_conv.assigned_to));
  if not coalesce(v_ok, false) then
    raise exception 'Você não pode transferir esta conversa';
  end if;

  if p_to is not null and not public.wa_eligible(v_conv.organization_id, p_to) then
    raise exception 'Este usuário não pode receber conversas (falta a permissão de atendimento)';
  end if;

  if p_to is not distinct from v_conv.assigned_to then
    return;
  end if;

  -- Limite de simultâneos: só quem tem "atribuir" passa por cima.
  if p_to is not null and not v_super and not public.wa_agent_has_capacity(v_conv.organization_id, p_to) then
    select coalesce(nullif(btrim(u.full_name), ''), u.username, u.email) into v_name from public.users u where u.id = p_to;
    raise exception '% está no limite de atendimentos simultâneos (%)',
      case when p_to = v_me then 'Você' else v_name end,
      public.wa_agent_limit(v_conv.organization_id, p_to);
  end if;

  perform public.wa_apply_assignment(
    v_conv.id, p_to, v_me,
    case when p_to is null then 'fila' when v_conv.assigned_to is null then 'atribuida' else 'transferida' end,
    p_note
  );

  -- Alguém ficou com uma vaga a mais (ou a conversa voltou à fila).
  perform public.wa_dispatch_queue(v_conv.organization_id);
end;
$$;

-- ------------------------------------------------------------
-- 8. Concluir e reabrir
-- ------------------------------------------------------------
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
          nullif(concat_ws(' — ', v_reason, v_note), ''));

  perform public.wa_dispatch_queue(v_conv.organization_id);
end;
$$;

create or replace function public.wa_reopen(p_conversation uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_conv   public.wa_conversations;
  v_ticket public.wa_tickets;
begin
  select * into v_conv from public.wa_conversations c
  where c.id = p_conversation and public.wa_can_see(c.organization_id, c.assigned_to)
  for update;
  if not found then
    raise exception 'Conversa não encontrada';
  end if;

  if v_conv.status = 'aberta'
     and exists (select 1 from public.wa_tickets t where t.conversation_id = v_conv.id and t.status <> 'concluido') then
    return;
  end if;

  select * into v_ticket from public.wa_tickets t
  where t.conversation_id = v_conv.id
  order by t.opened_at desc
  limit 1
  for update;

  if found and v_ticket.status = 'concluido' then
    update public.wa_tickets t set
      status = case when v_conv.assigned_to is null then 'fila' else 'em_atendimento' end,
      assigned_to = v_conv.assigned_to,
      closed_at = null, closed_by = null,
      reopened_count = t.reopened_count + 1,
      last_reopened_at = clock_timestamp()
    where t.id = v_ticket.id;
  elsif not found then
    insert into public.wa_tickets (organization_id, conversation_id, session_id, status, assigned_to, first_assigned_at)
    values (v_conv.organization_id, v_conv.id, v_conv.session_id,
            case when v_conv.assigned_to is null then 'fila' else 'em_atendimento' end,
            v_conv.assigned_to, case when v_conv.assigned_to is not null then clock_timestamp() end);
  end if;

  update public.wa_conversations c set status = 'aberta', updated_at = now() where c.id = v_conv.id;
  insert into public.wa_conversation_events (organization_id, conversation_id, kind, by_user)
  values (v_conv.organization_id, v_conv.id, 'reaberta', auth.uid());
end;
$$;

-- Compatibilidade (116/119): status vira concluir/reabrir.
create or replace function public.wa_set_status(p_conversation uuid, p_status text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_status = 'resolvida' then
    perform public.wa_conclude(p_conversation, null, null);
  elsif p_status = 'aberta' then
    perform public.wa_reopen(p_conversation);
  else
    raise exception 'Status inválido';
  end if;
end;
$$;

-- ------------------------------------------------------------
-- 9. Relatório (só admin)
--
-- Recortes, em dias de São Paulo:
--   atendimentos abertos no período ...... volume, 1ª resposta, espera na fila
--   atendimentos concluídos no período ... concluídos, tempo médio, motivos
-- Por atendente, o atendimento conta para quem está responsável por ele.
-- ------------------------------------------------------------
create or replace function public.wa_report(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
  v_ini timestamptz := (p_from::timestamp at time zone 'America/Sao_Paulo');
  v_fim timestamptz := ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo');
  v     jsonb;
begin
  if not exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'admin' and u.is_active
  ) then
    raise exception 'Relatório disponível só para administradores';
  end if;

  with
  t as (select * from public.wa_tickets where organization_id = v_org),
  ab as (select * from t where opened_at >= v_ini and opened_at < v_fim),
  fe as (select * from t where closed_at >= v_ini and closed_at < v_fim),
  ev as (
    select * from public.wa_conversation_events e
    where e.organization_id = v_org and e.created_at >= v_ini and e.created_at < v_fim
  ),
  ms as (
    select m.from_me, m.sent_by from public.wa_messages m
    where m.organization_id = v_org and m.wa_timestamp >= v_ini and m.wa_timestamp < v_fim and m.type <> 'reaction'
  )
  select jsonb_build_object(
    'resumo', jsonb_build_object(
      'abertos', (select count(*) from ab),
      'concluidos', (select count(*) from fe),
      'reaberturas', (select count(*) from ev where kind = 'reaberta'),
      'transferencias', (select count(*) from ev where kind = 'transferida'),
      'em_atendimento_agora', (select count(*) from t where status = 'em_atendimento'),
      'na_fila_agora', (select count(*) from t where status = 'fila'),
      'tma_min', (select round((avg(extract(epoch from closed_at - opened_at)) / 60)::numeric, 1) from fe),
      'tpr_min', (select round((avg(extract(epoch from first_response_at - opened_at)) / 60)::numeric, 1)
                  from ab where first_response_at is not null),
      'espera_min', (select round((avg(extract(epoch from first_assigned_at - opened_at)) / 60)::numeric, 1)
                     from ab where first_assigned_at is not null),
      'respondidos', (select count(*) from ab where first_response_at is not null),
      'msgs_recebidas', (select count(*) from ms where not from_me),
      'msgs_enviadas', (select count(*) from ms where from_me)
    ),
    'por_atendente', (
      select coalesce(jsonb_agg(x order by x->>'nome'), '[]'::jsonb) from (
        select jsonb_build_object(
          'id', u.id,
          'nome', coalesce(nullif(btrim(u.full_name), ''), u.username, u.email),
          'ativo', u.is_active,
          'limite', public.wa_agent_limit(v_org, u.id),
          'atendimentos', (select count(*) from ab where ab.assigned_to = u.id),
          'concluidos', (select count(*) from fe where fe.assigned_to = u.id),
          'em_atendimento', (select count(*) from t where t.assigned_to = u.id and t.status = 'em_atendimento'),
          'tma_min', (select round((avg(extract(epoch from fe.closed_at - fe.opened_at)) / 60)::numeric, 1)
                      from fe where fe.assigned_to = u.id),
          'tpr_min', (select round((avg(extract(epoch from ab.first_response_at - ab.opened_at)) / 60)::numeric, 1)
                      from ab where ab.assigned_to = u.id and ab.first_response_at is not null),
          'msgs_enviadas', (select count(*) from ms where ms.from_me and ms.sent_by = u.id),
          'transf_recebidas', (select count(*) from ev where ev.kind = 'transferida' and ev.to_user = u.id),
          'transf_feitas', (select count(*) from ev where ev.kind = 'transferida' and ev.from_user = u.id),
          'reaberturas', (select count(distinct ev.id) from ev
                          join t on t.conversation_id = ev.conversation_id and t.assigned_to = u.id
                          where ev.kind = 'reaberta')
        ) as x
        from public.users u
        where u.organization_id = v_org
          and (public.user_has_perm(u.id, 'atendimento.ver') or exists (select 1 from t where t.assigned_to = u.id))
      ) s
    ),
    'por_motivo', (
      select coalesce(jsonb_agg(jsonb_build_object('motivo', motivo, 'total', n) order by n desc), '[]'::jsonb)
      from (select coalesce(conclusion, 'Sem motivo') as motivo, count(*) as n from fe group by 1) z
    ),
    'por_dia', (
      select coalesce(jsonb_agg(jsonb_build_object('dia', d, 'abertos', a, 'concluidos', c) order by d), '[]'::jsonb)
      from (
        select g.d::date as d,
          (select count(*) from ab where (ab.opened_at at time zone 'America/Sao_Paulo')::date = g.d::date) as a,
          (select count(*) from fe where (fe.closed_at at time zone 'America/Sao_Paulo')::date = g.d::date) as c
        from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g(d)
      ) z
    ),
    'por_hora', (
      select coalesce(jsonb_agg(jsonb_build_object('hora', h, 'abertos', n) order by h), '[]'::jsonb)
      from (
        select g.h,
          (select count(*) from ab where extract(hour from ab.opened_at at time zone 'America/Sao_Paulo') = g.h) as n
        from generate_series(0, 23) g(h)
      ) z
    )
  ) into v;

  return v;
end;
$$;
