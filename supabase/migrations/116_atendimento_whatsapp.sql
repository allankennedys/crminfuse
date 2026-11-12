-- ============================================================
-- Atendimento: chat de WhatsApp (conversas individuais) no CRM
--
-- Aplique DEPOIS da 115, em execução separada (o cargo 'atendente' precisa
-- estar commitado).
--
-- COMO FUNCIONA
--
--   Evolution ──webhook──► Edge Function wa-webhook ──► wa_ingest_message()
--                                                        ├─ wa_conversations
--                                                        └─ wa_messages
--   Painel ──► Edge Function wa-chat ──► Evolution (envio) ──► wa_ingest_message()
--
-- Só conversa individual: grupo (@g.us), status e canal (@newsletter) são
-- descartados no webhook e nem chegam aqui.
--
-- QUEM VÊ O QUÊ (a regra mora no banco, a tela só espelha)
--
--   atendimento.ver ......... vê e responde SÓ as conversas atribuídas a ele
--   atendimento.ver_todas ... vê todas, inclusive a fila sem atendente
--   atendimento.atribuir .... atribui e transfere conversas
--   atendimento.configurar .. liga/desliga números no atendimento
--
-- O atendente nunca enxerga conversa de outro: a política de select de
-- wa_conversations recusa, e wa_messages e o storage herdam a mesma regra
-- (consultam wa_conversations, que já passa pela RLS de quem pergunta). O
-- Realtime também respeita a RLS, então nem o evento ao vivo vaza.
--
-- Escrita nunca é direta: não há política de insert/update/delete para o
-- usuário. Atribuir, resolver e marcar como lida são RPCs que conferem a
-- permissão; mensagens só entram pelas Edge Functions (service role).
-- ============================================================

-- ------------------------------------------------------------
-- 1. PERMISSÕES
--
-- Cópia da 066 com as chaves de atendimento acrescentadas. Nada muda para os
-- cargos existentes além delas:
--   admin ..... tudo (por definição)
--   operator .. ver, ver_todas, atribuir — supervisiona o atendimento
--   sdr ....... ver — pode receber conversas atribuídas
--   gestor .... nada de atendimento
--   atendente . ver — e nada mais do CRM
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
      'atendimento.atribuir', 'atendimento.configurar'
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
      'atendimento.ver', 'atendimento.ver_todas', 'atendimento.atribuir'
    ]

    when 'sdr' then array[
      'crm.funil.ver',
      'crm.etapas.editar',
      'crm.contatos.ver', 'crm.contatos.editar',
      'crm.vendas.ver', 'crm.vendas.editar',
      'crm.relatorios.ver',
      'crm.automacoes.ver',
      'atendimento.ver'
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
      'atendimento.ver'
    ]

    else array[]::text[]
  end;
$$;

-- "O usuário X pode Y?" — a mesma regra de current_user_can (055), para um
-- usuário qualquer. Serve para listar quem pode receber uma conversa.
-- Fechada para o cliente: perguntar a permissão de outra pessoa não é da
-- conta de ninguém fora das funções abaixo.
create or replace function public.user_has_perm(p_user uuid, p_perm text)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
      when not u.is_active then false
      when u.role = 'admin' then true
      when u.permissions is not null then p_perm = any(u.permissions)
      else p_perm = any(public.role_permissions(u.role))
    end
    from public.users u
    where u.id = p_user
  ), false);
$$;

revoke all on function public.user_has_perm(uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. NÚMEROS NO ATENDIMENTO
--
-- chat_enabled é público para a organização (a tela mostra). O token do
-- webhook NÃO: fica numa tabela à parte, sem política nenhuma — quem tem o
-- token injeta mensagem falsa na conversa de qualquer atendente.
-- ------------------------------------------------------------
alter table public.whatsapp_sessions
  add column if not exists chat_enabled boolean not null default false;

create table if not exists public.wa_session_secrets (
  session_id       uuid primary key references public.whatsapp_sessions(id) on delete cascade,
  webhook_token    text not null unique,
  -- Webhook que o número tinha antes de entrar no atendimento. A Evolution
  -- guarda UM webhook por instância: ativar substitui o anterior, e é com
  -- isto que desativar devolve o número como estava.
  previous_webhook jsonb,
  enabled_at       timestamptz not null default now()
);

alter table public.wa_session_secrets enable row level security;

-- ------------------------------------------------------------
-- 3. CONVERSAS
--
-- Uma por (número da empresa, cliente). O mesmo cliente falando com dois
-- números são duas conversas — cada número pode ter seu próprio atendente.
--
-- LID: o WhatsApp passou a identificar parte dos chats por um id opaco
-- (...@lid) em vez do telefone. A conversa guarda os dois quando conhece, e
-- wa_ingest_message junta as metades quando o telefone aparece depois.
--
-- session_id vira null se o número for removido do painel: o histórico fica,
-- só não dá mais para responder por ele.
-- ------------------------------------------------------------
create table if not exists public.wa_conversations (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  session_id           uuid references public.whatsapp_sessions(id) on delete set null,
  remote_jid           text not null,
  lid_jid              text,
  phone                text,
  phone_key            text generated always as (public.crm_phone_key(phone)) stored,
  push_name            text,
  contact_id           uuid references public.crm_contacts(id) on delete set null,
  assigned_to          uuid references public.users(id) on delete set null,
  assigned_at          timestamptz,
  assigned_by          uuid references public.users(id) on delete set null,
  status               text not null default 'aberta' check (status in ('aberta', 'resolvida')),
  last_message_at      timestamptz,
  last_message_preview text,
  last_message_from_me boolean,
  unread_count         int not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (session_id, remote_jid)
);

create index if not exists idx_wa_conv_org_recent
  on public.wa_conversations(organization_id, last_message_at desc nulls last);
create index if not exists idx_wa_conv_assigned
  on public.wa_conversations(organization_id, assigned_to, last_message_at desc nulls last);
create index if not exists idx_wa_conv_lid
  on public.wa_conversations(session_id, lid_jid) where lid_jid is not null;

alter table public.wa_conversations enable row level security;

-- ------------------------------------------------------------
-- 4. MENSAGENS
--
-- wa_message_id é o id do WhatsApp (key.id): é ele que torna a gravação
-- idempotente. O envio pelo painel e o eco do webhook chegam com o mesmo id
-- e viram uma linha só.
-- ------------------------------------------------------------
create table if not exists public.wa_messages (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.wa_conversations(id) on delete cascade,
  wa_message_id   text not null,
  from_me         boolean not null,
  -- Quem respondeu pelo painel. null em mensagem do cliente ou enviada
  -- direto do celular.
  sent_by         uuid references public.users(id) on delete set null,
  type            text not null,
  body            text,
  media_path      text,
  media_mime      text,
  media_name      text,
  -- null = sem mídia · pendente = baixando · ok · falhou
  media_status    text,
  -- received (do cliente) · pending · sent · delivered · read · failed
  status          text not null default 'received',
  wa_timestamp    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  unique (conversation_id, wa_message_id)
);

create index if not exists idx_wa_msg_conv_time
  on public.wa_messages(conversation_id, wa_timestamp desc);

alter table public.wa_messages enable row level security;

-- ------------------------------------------------------------
-- 5. A REGRA DE VISIBILIDADE
-- ------------------------------------------------------------
create or replace function public.wa_can_see(p_org uuid, p_assigned uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select p_org = public.current_org_id()
    and (
      public.current_user_can('atendimento.ver_todas')
      or (p_assigned = auth.uid() and public.current_user_can('atendimento.ver'))
    );
$$;

drop policy if exists wa_conv_select on public.wa_conversations;
create policy wa_conv_select on public.wa_conversations
  for select using (public.wa_can_see(organization_id, assigned_to));

-- A subconsulta passa pela RLS de wa_conversations de quem pergunta: a
-- mensagem é visível exatamente quando a conversa é.
drop policy if exists wa_msg_select on public.wa_messages;
create policy wa_msg_select on public.wa_messages
  for select using (
    exists (select 1 from public.wa_conversations c where c.id = conversation_id)
  );

-- ------------------------------------------------------------
-- 6. MÍDIA (bucket privado)
--
-- Caminho: {organization_id}/{conversation_id}/arquivo. Ler e subir anexo
-- exige enxergar a conversa — de novo pela RLS de wa_conversations.
-- Comparação como texto para um caminho malformado não estourar cast.
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('wa-media', 'wa-media', false, 104857600) -- 100 MB
on conflict (id) do nothing;

drop policy if exists wa_media_select on storage.objects;
create policy wa_media_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'wa-media'
    and exists (
      select 1 from public.wa_conversations c
      where c.organization_id::text = (storage.foldername(objects.name))[1]
        and c.id::text = (storage.foldername(objects.name))[2]
    )
  );

drop policy if exists wa_media_insert on storage.objects;
create policy wa_media_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'wa-media'
    and exists (
      select 1 from public.wa_conversations c
      where c.organization_id::text = (storage.foldername(objects.name))[1]
        and c.id::text = (storage.foldername(objects.name))[2]
    )
  );

-- ------------------------------------------------------------
-- 7. ENTRADA DE MENSAGEM (só service role — Edge Functions)
--
-- Acha ou cria a conversa, grava a mensagem sem duplicar e atualiza o
-- resumo da lista. Tudo numa transação, com a conversa travada: duas
-- mensagens simultâneas de um cliente novo não criam duas conversas.
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
begin
  if v_jid is null or p_wa_id is null then
    raise exception 'Mensagem sem destinatário ou sem id';
  end if;

  select s.organization_id into v_org from public.whatsapp_sessions s where s.id = p_session;
  if v_org is null then
    raise exception 'Número % não existe', p_session;
  end if;

  -- Pelo telefone primeiro; pelo LID se o telefone não veio ou não casou.
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
    -- Completa o que faltava: a conversa nascida pelo LID ganha o telefone
    -- (e passa a responder por ele), a nascida pelo telefone ganha o LID.
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

  -- Liga ao contato do CRM pelo telefone (mesma identidade da 069: com/sem
  -- 55, com/sem o 9). Só preenche — nunca troca um vínculo existente.
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
  -- O eco do webhook e a resposta do envio são a mesma mensagem: quem chegar
  -- depois só completa o que o primeiro não sabia (quem enviou, o arquivo).
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
      -- Resposta (pelo painel ou pelo celular) zera; mensagem do cliente
      -- soma e reabre a conversa que estava resolvida.
      unread_count         = case when p_from_me then 0 else c.unread_count + 1 end,
      status               = case when p_from_me then c.status else 'aberta' end,
      updated_at           = now()
    where c.id = v_conv.id;
  end if;

  return query select v_conv.id, v_msg, v_inserted, v_org;
end;
$$;

revoke all on function public.wa_ingest_message(
  uuid, text, text, text, text, boolean, text, text, text, text, boolean, text, timestamptz, text, uuid
) from public, anon, authenticated;

-- Confirmação de entrega/leitura. Só avança: um "entregue" atrasado não
-- desfaz um "lido" que chegou antes.
create or replace function public.wa_status_rank(p_status text)
returns int
language sql immutable as $$
  select case p_status
    when 'pending'   then 0
    when 'failed'    then 1
    when 'sent'      then 2
    when 'delivered' then 3
    when 'read'      then 4
    else -1
  end;
$$;

create or replace function public.wa_update_message_status(p_session uuid, p_wa_id text, p_status text)
returns void
language sql security definer set search_path = public as $$
  update public.wa_messages m set status = p_status
  from public.wa_conversations c
  where m.conversation_id = c.id
    and c.session_id = p_session
    and m.wa_message_id = p_wa_id
    and m.from_me
    and public.wa_status_rank(p_status) > public.wa_status_rank(m.status);
$$;

revoke all on function public.wa_update_message_status(uuid, text, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 8. AÇÕES DA TELA
-- ------------------------------------------------------------

-- Atribuir / transferir / devolver à fila (p_user null).
create or replace function public.wa_assign(p_conversation uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
begin
  if not public.current_user_can('atendimento.atribuir') then
    raise exception 'Sem permissão para atribuir conversas';
  end if;

  if not exists (
    select 1 from public.wa_conversations c
    where c.id = p_conversation and c.organization_id = v_org
  ) then
    raise exception 'Conversa não encontrada';
  end if;

  if p_user is not null and not exists (
    select 1 from public.users u
    where u.id = p_user and u.organization_id = v_org and u.is_active
      and public.user_has_perm(u.id, 'atendimento.ver')
  ) then
    raise exception 'Este usuário não pode receber conversas (falta a permissão de atendimento)';
  end if;

  update public.wa_conversations c set
    assigned_to = p_user,
    assigned_at = case when p_user is null then null else now() end,
    assigned_by = auth.uid(),
    updated_at  = now()
  where c.id = p_conversation;
end;
$$;

-- Resolver / reabrir. Quem enxerga a conversa pode.
create or replace function public.wa_set_status(p_conversation uuid, p_status text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('aberta', 'resolvida') then
    raise exception 'Status inválido';
  end if;

  update public.wa_conversations c set status = p_status, updated_at = now()
  where c.id = p_conversation
    and public.wa_can_see(c.organization_id, c.assigned_to);

  if not found then
    raise exception 'Conversa não encontrada';
  end if;
end;
$$;

-- Zera o contador. O aviso de "lida" para o WhatsApp do cliente é a Edge
-- Function wa-chat que manda.
create or replace function public.wa_mark_read(p_conversation uuid)
returns void
language sql security definer set search_path = public as $$
  update public.wa_conversations c set unread_count = 0
  where c.id = p_conversation
    and c.unread_count > 0
    and public.wa_can_see(c.organization_id, c.assigned_to);
$$;

-- Quem pode receber conversa — para o seletor de atribuição.
create or replace function public.wa_attendants()
returns table (id uuid, name text, role text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.current_user_can('atendimento.atribuir') or public.current_user_can('atendimento.ver_todas')) then
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

-- Os números da organização, com o essencial para a tela de atendimento.
-- whatsapp_sessions exige painel.numeros.ver, que o atendente não tem.
create or replace function public.wa_sessions_list()
returns table (id uuid, instance_name text, phone_number text, status text, chat_enabled boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (
    public.current_user_can('atendimento.ver')
    or public.current_user_can('atendimento.ver_todas')
    or public.current_user_can('atendimento.configurar')
  ) then
    return;
  end if;

  return query
    select s.id, s.instance_name, s.phone_number, s.status::text, s.chat_enabled
    from public.whatsapp_sessions s
    where s.organization_id = public.current_org_id()
    order by s.created_at;
end;
$$;

-- ------------------------------------------------------------
-- 9. REALTIME
-- ------------------------------------------------------------
alter publication supabase_realtime add table public.wa_conversations;
alter publication supabase_realtime add table public.wa_messages;
