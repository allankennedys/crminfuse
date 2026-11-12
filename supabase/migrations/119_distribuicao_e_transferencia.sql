-- ============================================================
-- Atendimento: visibilidade configurável, distribuição automática e
-- transferência
--
-- 1. CONFIGURAÇÃO POR ORGANIZAÇÃO (wa_settings)
--    restrict_to_assigned: ligado (padrão) = quem não tem "ver todas" só
--    enxerga as conversas atribuídas a si; desligado = todo mundo com
--    atendimento enxerga todas (e pode assumir as da fila).
--    assign_mode: como uma conversa SEM atendente ganha um quando o cliente
--    escreve — manual (fica na fila), aleatoria, rodizio (quem recebeu
--    automaticamente há mais tempo) ou fixo (sempre a mesma pessoa).
--    pool: quem entra no sorteio/rodízio (vazio = todos com atendimento).
--
-- 2. REGRAS (wa_routing_rules), avaliadas ANTES do modo, em ordem:
--    numero  — conversa que chega por tal número da empresa → atendente X
--    palavra — mensagem contém alguma das palavras → atendente X
--              (sem diferença de maiúscula ou acento)
--
-- 3. TRANSFERÊNCIA (wa_transfer) e histórico (wa_conversation_events):
--    quem tem "atribuir" move qualquer conversa; o atendente responsável,
--    com "transferir", passa a DELE para outra pessoa ou devolve à fila;
--    com a restrição desligada, qualquer atendente assume uma da fila.
--    Tudo vira linha no histórico, que aparece dentro da conversa.
-- ============================================================

-- ------------------------------------------------------------
-- Permissão nova: atendimento.transferir
-- ------------------------------------------------------------
create or replace function public.role_permissions(p_role public.user_role)
returns text[]
language sql immutable set search_path = public as $$
  select case p_role::text

    when 'admin' then array[
      'painel.dashboard.ver',
      'painel.grupos.ver', 'painel.grupos.editar', 'painel.grupos.excluir',
      'painel.numeros.ver', 'painel.numeros.editar',
      'painel.mensagens.ver', 'painel.mensagens.enviar',
      'painel.agendamentos.ver', 'painel.agendamentos.editar', 'painel.agendamentos.excluir',
      'painel.historico.ver',
      'painel.comprovantes.ver',
      'painel.automacoes.ver', 'painel.automacoes.editar',
      'painel.config.ver',
      'crm.funil.ver',
      'crm.etapas.editar', 'crm.etapas.excluir',
      'crm.contatos.ver', 'crm.contatos.editar', 'crm.contatos.excluir',
      'crm.vendas.ver', 'crm.vendas.editar', 'crm.vendas.excluir',
      'crm.relatorios.ver',
      'crm.automacoes.ver', 'crm.automacoes.editar',
      'crm.chaves.ver', 'crm.chaves.editar',
      'atendimento.ver', 'atendimento.ver_todas',
      'atendimento.atribuir', 'atendimento.configurar',
      'atendimento.transferir'
    ]

    when 'operator' then array[
      'painel.dashboard.ver',
      'painel.grupos.ver', 'painel.grupos.editar', 'painel.grupos.excluir',
      'painel.numeros.ver', 'painel.numeros.editar',
      'painel.mensagens.ver', 'painel.mensagens.enviar',
      'painel.agendamentos.ver', 'painel.agendamentos.editar', 'painel.agendamentos.excluir',
      'painel.historico.ver',
      'painel.comprovantes.ver',
      'painel.automacoes.ver',
      'painel.config.ver',
      'crm.funil.ver',
      'crm.etapas.editar', 'crm.etapas.excluir',
      'crm.contatos.ver', 'crm.contatos.editar', 'crm.contatos.excluir',
      'crm.vendas.ver', 'crm.vendas.editar', 'crm.vendas.excluir',
      'crm.relatorios.ver',
      'crm.automacoes.ver', 'crm.automacoes.editar',
      'crm.chaves.ver',
      'atendimento.ver', 'atendimento.ver_todas', 'atendimento.atribuir',
      'atendimento.transferir'
    ]

    when 'sdr' then array[
      'crm.funil.ver',
      'crm.etapas.editar',
      'crm.contatos.ver', 'crm.contatos.editar',
      'crm.vendas.ver', 'crm.vendas.editar',
      'crm.relatorios.ver',
      'crm.automacoes.ver',
      'atendimento.ver', 'atendimento.transferir'
    ]

    when 'gestor' then array[
      'painel.dashboard.ver',
      'painel.grupos.ver', 'painel.grupos.editar',
      'painel.numeros.ver',
      'painel.mensagens.ver', 'painel.mensagens.enviar',
      'painel.agendamentos.ver', 'painel.agendamentos.editar',
      'painel.historico.ver',
      'painel.comprovantes.ver',
      'painel.automacoes.ver',
      'painel.config.ver',
      'crm.relatorios.ver'
    ]

    when 'atendente' then array[
      'atendimento.ver', 'atendimento.transferir'
    ]

    else array[]::text[]
  end;
$$;


-- ------------------------------------------------------------
-- 1. Configuração
-- ------------------------------------------------------------
create table if not exists public.wa_settings (
  organization_id      uuid primary key references public.organizations(id) on delete cascade,
  restrict_to_assigned boolean not null default true,
  assign_mode          text not null default 'manual'
                       check (assign_mode in ('manual', 'aleatoria', 'rodizio', 'fixo')),
  fixed_user           uuid references public.users(id) on delete set null,
  pool                 uuid[] not null default '{}',
  updated_at           timestamptz not null default now(),
  updated_by           uuid references public.users(id) on delete set null
);

alter table public.wa_settings enable row level security;

drop policy if exists wa_settings_select on public.wa_settings;
create policy wa_settings_select on public.wa_settings
  for select using (organization_id = public.current_org_id());

drop policy if exists wa_settings_write on public.wa_settings;
create policy wa_settings_write on public.wa_settings
  for all using (
    organization_id = public.current_org_id() and public.current_user_can('atendimento.configurar')
  )
  with check (
    organization_id = public.current_org_id() and public.current_user_can('atendimento.configurar')
  );

create table if not exists public.wa_routing_rules (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  position        int not null default 0,
  kind            text not null check (kind in ('numero', 'palavra')),
  session_id      uuid references public.whatsapp_sessions(id) on delete cascade,
  keywords        text[] not null default '{}',
  target_user     uuid not null references public.users(id) on delete cascade,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  check (
    (kind = 'numero' and session_id is not null)
    or (kind = 'palavra' and cardinality(keywords) > 0)
  )
);

create index if not exists idx_wa_rules_org on public.wa_routing_rules(organization_id, position, created_at);

alter table public.wa_routing_rules enable row level security;

drop policy if exists wa_rules_all on public.wa_routing_rules;
create policy wa_rules_all on public.wa_routing_rules
  for all using (
    organization_id = public.current_org_id() and public.current_user_can('atendimento.configurar')
  )
  with check (
    organization_id = public.current_org_id() and public.current_user_can('atendimento.configurar')
  );

-- Número e atendente da regra têm que ser da mesma organização.
create or replace function public.wa_routing_rules_check()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.session_id is not null and not exists (
    select 1 from public.whatsapp_sessions s
    where s.id = new.session_id and s.organization_id = new.organization_id
  ) then
    raise exception 'Número de outra organização';
  end if;
  if not exists (
    select 1 from public.users u
    where u.id = new.target_user and u.organization_id = new.organization_id
  ) then
    raise exception 'Atendente de outra organização';
  end if;
  new.keywords := array(
    select distinct btrim(k) from unnest(new.keywords) k where btrim(k) <> ''
  );
  return new;
end;
$$;

drop trigger if exists trg_wa_routing_rules_check on public.wa_routing_rules;
create trigger trg_wa_routing_rules_check
  before insert or update on public.wa_routing_rules
  for each row execute function public.wa_routing_rules_check();

-- ------------------------------------------------------------
-- 2. Histórico da conversa
-- ------------------------------------------------------------
create table if not exists public.wa_conversation_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.wa_conversations(id) on delete cascade,
  -- atribuida (de ninguém para alguém) · transferida · fila (devolvida) ·
  -- auto (distribuição automática) · resolvida · reaberta
  kind            text not null
                  check (kind in ('atribuida', 'transferida', 'fila', 'auto', 'resolvida', 'reaberta')),
  from_user       uuid references public.users(id) on delete set null,
  to_user         uuid references public.users(id) on delete set null,
  by_user         uuid references public.users(id) on delete set null,
  note            text,
  -- clock_timestamp, não now(): o rodízio ordena por este instante, e várias
  -- atribuições na mesma transação teriam o mesmo now().
  created_at      timestamptz not null default clock_timestamp()
);

create index if not exists idx_wa_events_conv on public.wa_conversation_events(conversation_id, created_at);
-- Rodízio: "quem recebeu automaticamente há mais tempo".
create index if not exists idx_wa_events_auto on public.wa_conversation_events(organization_id, to_user, created_at)
  where kind = 'auto';

alter table public.wa_conversation_events enable row level security;

drop policy if exists wa_events_select on public.wa_conversation_events;
create policy wa_events_select on public.wa_conversation_events
  for select using (
    exists (select 1 from public.wa_conversations c where c.id = conversation_id)
  );

alter publication supabase_realtime add table public.wa_conversation_events;

-- ------------------------------------------------------------
-- 3. Visibilidade: agora depende da configuração
-- ------------------------------------------------------------
create or replace function public.wa_restricted(p_org uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select s.restrict_to_assigned from public.wa_settings s where s.organization_id = p_org), true);
$$;

create or replace function public.wa_can_see(p_org uuid, p_assigned uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select p_org = public.current_org_id()
    and (
      public.current_user_can('atendimento.ver_todas')
      or (
        public.current_user_can('atendimento.ver')
        -- coalesce: conversa sem atendente dá null = auth.uid() → null, e
        -- null num "if not" não barra nada. Aqui é sempre true ou false.
        and (coalesce(p_assigned = auth.uid(), false) or not public.wa_restricted(p_org))
      )
    );
$$;

-- Pode receber conversa: ativo, da organização, com atendimento.
create or replace function public.wa_eligible(p_org uuid, p_user uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.users u
    where u.id = p_user and u.organization_id = p_org and u.is_active
      and public.user_has_perm(u.id, 'atendimento.ver')
  );
$$;

revoke all on function public.wa_eligible(uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. Quem recebe uma conversa sem atendente
-- ------------------------------------------------------------
create or replace function public.wa_pick_attendant(
  p_org uuid, p_session uuid, p_text text,
  out o_user uuid, out o_reason text
)
-- volatile (o padrão): o sorteio usa random().
language plpgsql security definer set search_path = public as $$
declare
  v_set  public.wa_settings;
  v_rule public.wa_routing_rules;
  v_text text := lower(extensions.unaccent(coalesce(p_text, '')));
  v_kw   text;
begin
  -- Regras primeiro, na ordem. Regra cujo atendente não pode receber é pulada.
  for v_rule in
    select * from public.wa_routing_rules r
    where r.organization_id = p_org and r.active
    order by r.position, r.created_at
  loop
    continue when not public.wa_eligible(p_org, v_rule.target_user);

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
    if v_set.fixed_user is not null and public.wa_eligible(p_org, v_set.fixed_user) then
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

revoke all on function public.wa_pick_attendant(uuid, uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 5. Entrada de mensagem: igual à 116 + distribuição automática
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
  v_jid      text := coalesce(p_pn_jid, p_lid_jid);
  v_phone    text := nullif(regexp_replace(split_part(coalesce(p_pn_jid, ''), '@', 1), '\D', '', 'g'), '');
  v_push     text := case when p_from_me then null else nullif(btrim(p_push_name), '') end;
  v_ts       timestamptz := coalesce(p_ts, now());
  v_msg      uuid;
  v_inserted boolean;
  v_preview  text;
  v_pick     record;
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

    -- Cliente escreveu e a conversa está sem atendente: distribui.
    if not p_from_me and v_conv.assigned_to is null then
      select * into v_pick from public.wa_pick_attendant(v_org, p_session, p_body);
      if v_pick.o_user is not null then
        update public.wa_conversations c set
          assigned_to = v_pick.o_user, assigned_at = now(), assigned_by = null
        where c.id = v_conv.id;
        insert into public.wa_conversation_events (organization_id, conversation_id, kind, to_user, note)
        values (v_org, v_conv.id, 'auto', v_pick.o_user, v_pick.o_reason);
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
-- 6. Transferir / atribuir / assumir / devolver à fila
-- ------------------------------------------------------------
create or replace function public.wa_transfer(p_conversation uuid, p_to uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_conv public.wa_conversations;
  v_me   uuid := auth.uid();
  v_ok   boolean;
begin
  select * into v_conv from public.wa_conversations c
  where c.id = p_conversation and c.organization_id = public.current_org_id()
  for update;
  if not found then
    raise exception 'Conversa não encontrada';
  end if;

  v_ok :=
    -- supervisor: qualquer conversa, para qualquer um
    public.current_user_can('atendimento.atribuir')
    -- responsável: passa a dele adiante (ou devolve à fila)
    or (v_conv.assigned_to = v_me and public.current_user_can('atendimento.transferir'))
    -- sem restrição: quem vê a fila pode assumir uma conversa sem dono
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

  update public.wa_conversations c set
    assigned_to = p_to,
    assigned_at = case when p_to is null then null else now() end,
    assigned_by = v_me,
    updated_at  = now()
  where c.id = v_conv.id;

  insert into public.wa_conversation_events
    (organization_id, conversation_id, kind, from_user, to_user, by_user, note)
  values (
    v_conv.organization_id, v_conv.id,
    case when p_to is null then 'fila' when v_conv.assigned_to is null then 'atribuida' else 'transferida' end,
    v_conv.assigned_to, p_to, v_me, nullif(btrim(coalesce(p_note, '')), '')
  );
end;
$$;

-- Compatibilidade com a 116: atribuir é transferir sem nota.
create or replace function public.wa_assign(p_conversation uuid, p_user uuid)
returns void
language sql security definer set search_path = public as $$
  select public.wa_transfer(p_conversation, p_user, null);
$$;

-- Resolver / reabrir, agora com histórico.
create or replace function public.wa_set_status(p_conversation uuid, p_status text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_conv public.wa_conversations;
begin
  if p_status not in ('aberta', 'resolvida') then
    raise exception 'Status inválido';
  end if;

  select * into v_conv from public.wa_conversations c
  where c.id = p_conversation and public.wa_can_see(c.organization_id, c.assigned_to)
  for update;
  if not found then
    raise exception 'Conversa não encontrada';
  end if;
  if v_conv.status = p_status then
    return;
  end if;

  update public.wa_conversations c set status = p_status, updated_at = now() where c.id = v_conv.id;
  insert into public.wa_conversation_events (organization_id, conversation_id, kind, by_user)
  values (v_conv.organization_id, v_conv.id, case p_status when 'resolvida' then 'resolvida' else 'reaberta' end, auth.uid());
end;
$$;

-- Lista de quem pode receber: agora também para quem transfere.
create or replace function public.wa_attendants()
returns table (id uuid, name text, role text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (
    public.current_user_can('atendimento.atribuir')
    or public.current_user_can('atendimento.ver_todas')
    or public.current_user_can('atendimento.transferir')
    or public.current_user_can('atendimento.configurar')
  ) then
    return;
  end if;

  return query
    select u.id, coalesce(nullif(btrim(u.full_name), ''), u.username, u.email), u.role::text
    from public.users u
    where u.organization_id = public.current_org_id()
      and u.is_active
      and public.user_has_perm(u.id, 'atendimento.ver')
    order by 2;
end;
$$;
