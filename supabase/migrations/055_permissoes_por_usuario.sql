-- ============================================================
-- Permissões por usuário — cargo é preset, personalizada é exceção
--
-- RODE ESTE ARQUIVO INTEIRO DE UMA VEZ. Ele derruba e recria as políticas
-- de RLS de praticamente todas as tabelas; executar pela metade deixa
-- tabela sem política de escrita (ninguém escreve) ou sem política de
-- leitura (ninguém lê).
--
-- Aplique DEPOIS da 054, em execução separada: o rótulo 'sdr' precisa
-- estar commitado antes de ser usado nos presets abaixo.
--
-- COMO A DECISÃO É TOMADA, EM UM LUGAR SÓ
--
--   current_user_can('crm.contatos.editar')
--     ├─ usuário inativo ............................ false
--     ├─ role = admin ............................... true, sempre
--     ├─ users.permissions não é null ............... está na lista?
--     └─ users.permissions é null ................... está no preset do cargo?
--
-- ADMIN NUNCA PERDE ACESSO. Permissão personalizada não se aplica a ele, de
-- propósito: sem essa trava, um admin que desmarcasse a caixa errada ficaria
-- trancado para fora da própria tela de usuários, e a única saída seria SQL
-- direto no banco. A tela desabilita a opção para admins; esta função é a
-- garantia de que a regra vale mesmo que alguém chame a RPC na mão.
--
-- MIGRAÇÃO SEM SUSTO
--
-- A coluna nasce NULL para todo mundo, então todo usuário existente cai no
-- preset do cargo dele. Os presets abaixo foram escritos lendo as políticas
-- atuais uma a uma para reproduzir o que cada cargo faz hoje — com TRÊS
-- exceções deliberadas, todas apertando:
--
--   1. SDR não lê mais as tabelas do painel (grupos, mensagens,
--      agendamentos) pela API. A tela dele já não mostrava nada disso; o que
--      muda é que agora o banco também recusa.
--   2. SDR não edita mais as credenciais da Meta (já feito na 054).
--   3. SDR não EXCLUI mais contato, etapa ou venda — só cria e edita. Hoje
--      as políticas dele são `for all`, o que inclui DELETE. Se a operação
--      depender disso, é uma caixa a marcar no usuário, não um rollback.
--
-- Nada mais muda para admin, operator e viewer.
--
-- POR QUE UMA POLÍTICA POR COMANDO
--
-- `for all` não distingue UPDATE de DELETE, e "editar" e "excluir" viraram
-- permissões separadas. Onde existe a distinção há três políticas de escrita
-- (insert/update/delete); onde não existe, um `for all` gated pela permissão
-- de edição — e aí excluir vai junto, de propósito, porque não há chave
-- separada para oferecer.
--
-- CUSTO NO PLANO
--
-- current_user_can() é stable security definer e faz uma busca por chave
-- primária em public.users. É exatamente o perfil de current_user_role(),
-- que as políticas já chamavam desde a 001 — a conta não muda.
-- ============================================================

-- ------------------------------------------------------------
-- COLUNA
--
-- null = "siga o preset do cargo". Array (mesmo vazio) = lista própria.
-- A distinção null/vazio é o que permite existir um usuário personalizado
-- SEM nenhuma permissão, que é diferente de um usuário no preset.
-- ------------------------------------------------------------
alter table public.users
  add column if not exists permissions text[];

comment on column public.users.permissions is
  'Permissões personalizadas. NULL = usa o preset do cargo (role_permissions). '
  'Array vazio = personalizado sem nenhuma permissão. Ignorada para admin.';

-- ------------------------------------------------------------
-- PRESETS POR CARGO
--
-- Fonte única da verdade: a tela lê daqui (via permissions_preset) para
-- pré-marcar as caixas, em vez de manter uma segunda cópia da lista no
-- bundle que sairia do lugar na primeira mudança.
-- ------------------------------------------------------------
create or replace function public.role_permissions(p_role public.user_role)
returns text[]
language sql immutable set search_path = public as $$
  select case p_role

    -- Tudo. Listado por extenso mesmo sendo redundante com o atalho de
    -- current_user_can: é daqui que a tela desenha as caixas do admin.
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
      'crm.chaves.ver', 'crm.chaves.editar'
    ]

    -- Espelha o operator de hoje: escreve no painel e no CRM, não mexe nas
    -- regras de automação do painel (era admin na 001) nem nas chaves de API
    -- (RPCs de 013, admin).
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
      'crm.chaves.ver'
    ]

    -- Quem prospecta: trabalha o funil inteiro e lê os relatórios. Sem
    -- painel, sem credencial da Meta, sem excluir. Ver as três exceções
    -- deliberadas no cabeçalho.
    when 'sdr' then array[
      'crm.funil.ver',
      'crm.etapas.editar',
      'crm.contatos.ver', 'crm.contatos.editar',
      'crm.vendas.ver', 'crm.vendas.editar',
      'crm.relatorios.ver',
      'crm.automacoes.ver'
    ]

    -- Só leitura, nos dois sistemas — é o que a RLS de hoje já dá a ele,
    -- já que todo select era liberado a qualquer membro da organização.
    when 'viewer' then array[
      'painel.dashboard.ver',
      'painel.grupos.ver',
      'painel.numeros.ver',
      'painel.mensagens.ver',
      'painel.agendamentos.ver',
      'painel.historico.ver',
      'painel.comprovantes.ver',
      'painel.automacoes.ver',
      'painel.config.ver',
      'crm.funil.ver',
      'crm.contatos.ver',
      'crm.vendas.ver',
      'crm.relatorios.ver',
      'crm.automacoes.ver',
      'crm.chaves.ver'
    ]

    else array[]::text[]
  end;
$$;

comment on function public.role_permissions(public.user_role) is
  'Permissões padrão de cada cargo. Fonte única: as políticas de RLS, as '
  'RPCs e a tela de usuários todas derivam daqui.';

-- Wrapper para a tela: PostgREST manda o cargo como texto, e um cast
-- explícito dá erro legível ("invalid input value for enum") em vez de
-- "função não encontrada" quando alguém digita um cargo que não existe.
create or replace function public.permissions_preset(p_role text)
returns text[]
language sql stable security definer set search_path = public as $$
  select public.role_permissions(p_role::public.user_role);
$$;

-- ------------------------------------------------------------
-- A PERGUNTA
-- ------------------------------------------------------------
create or replace function public.current_user_can(p_perm text)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
      -- Desativado não faz nada, independentemente de cargo ou lista.
      when not u.is_active then false
      -- Admin nunca perde acesso: ver o cabeçalho.
      when u.role = 'admin' then true
      when u.permissions is not null then p_perm = any(u.permissions)
      else p_perm = any(public.role_permissions(u.role))
    end
    from public.users u
    where u.id = auth.uid()
  ), false);
$$;

comment on function public.current_user_can(text) is
  'true quando o usuário autenticado tem a permissão. Resolve na ordem: '
  'inativo → não; admin → sempre sim; lista personalizada; preset do cargo.';

-- ------------------------------------------------------------
-- EDIÇÃO DAS PERMISSÕES (só admin)
--
-- p_permissions null devolve o usuário ao preset do cargo — é o caminho de
-- volta quando a personalização deu errado.
-- ------------------------------------------------------------
create or replace function public.user_permissions_save(
  p_user uuid,
  p_permissions text[] default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
  v_role public.user_role;
begin
  if public.current_user_role() <> 'admin' then
    raise exception 'Apenas administradores podem alterar permissões';
  end if;

  select u.role into v_role
  from public.users u
  where u.id = p_user and u.organization_id = v_org;

  if not found then
    raise exception 'Usuário não encontrado nesta organização';
  end if;

  -- Recusa em vez de aceitar e ignorar: gravar uma lista que nunca será
  -- consultada faria a tela mostrar caixas desmarcadas para um admin que,
  -- na prática, continua podendo tudo.
  if v_role = 'admin' then
    raise exception 'Administradores têm acesso total e não aceitam permissões personalizadas';
  end if;

  update public.users
  set permissions = p_permissions
  where id = p_user and organization_id = v_org;
end;
$$;

-- ============================================================
-- POLÍTICAS — PAINEL
-- ============================================================

-- ---------- Números (whatsapp_sessions) ----------
drop policy if exists sessions_select on public.whatsapp_sessions;
drop policy if exists sessions_write  on public.whatsapp_sessions;

create policy sessions_select on public.whatsapp_sessions
  for select using (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.numeros.ver')
  );
-- Sem chave de exclusão separada para números: apagar uma instância é parte
-- de administrá-la, então `for all` responde por tudo.
create policy sessions_write on public.whatsapp_sessions
  for all using (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.numeros.editar')
  )
  with check (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.numeros.editar')
  );

-- ---------- Grupos ----------
drop policy if exists groups_select on public.groups;
drop policy if exists groups_write  on public.groups;

create policy groups_select on public.groups
  for select using (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.grupos.ver')
  );
create policy groups_insert on public.groups
  for insert with check (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.grupos.editar')
  );
create policy groups_update on public.groups
  for update using (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.grupos.editar')
  )
  with check (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.grupos.editar')
  );
create policy groups_delete on public.groups
  for delete using (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.grupos.excluir')
  );

-- ---------- Vínculos e participantes de grupo ----------
-- Não têm organization_id: a organização é conferida pelo grupo dono, como
-- na 001. O que muda é que agora a leitura também exige permissão.
drop policy if exists group_sessions_all on public.group_sessions;
create policy group_sessions_select on public.group_sessions
  for select using (
    exists (select 1 from public.groups g where g.id = group_id and g.organization_id = public.current_org_id())
    and public.current_user_can('painel.grupos.ver')
  );
create policy group_sessions_write on public.group_sessions
  for all using (
    exists (select 1 from public.groups g where g.id = group_id and g.organization_id = public.current_org_id())
    and public.current_user_can('painel.grupos.editar')
  )
  with check (
    exists (select 1 from public.groups g where g.id = group_id and g.organization_id = public.current_org_id())
    and public.current_user_can('painel.grupos.editar')
  );

drop policy if exists participants_all on public.group_participants;
create policy participants_select on public.group_participants
  for select using (
    exists (select 1 from public.groups g where g.id = group_id and g.organization_id = public.current_org_id())
    and public.current_user_can('painel.grupos.ver')
  );
create policy participants_write on public.group_participants
  for all using (
    exists (select 1 from public.groups g where g.id = group_id and g.organization_id = public.current_org_id())
    and public.current_user_can('painel.grupos.editar')
  )
  with check (
    exists (select 1 from public.groups g where g.id = group_id and g.organization_id = public.current_org_id())
    and public.current_user_can('painel.grupos.editar')
  );

-- ---------- Fila de sincronização de participantes (005) ----------
drop policy if exists participant_jobs_select on public.participant_jobs;
drop policy if exists participant_jobs_insert on public.participant_jobs;

create policy participant_jobs_select on public.participant_jobs
  for select using (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.grupos.ver')
  );
create policy participant_jobs_insert on public.participant_jobs
  for insert with check (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.grupos.editar')
  );

-- ---------- Mensagens e fila ----------
drop policy if exists messages_select on public.messages;
drop policy if exists messages_write  on public.messages;

create policy messages_select on public.messages
  for select using (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.mensagens.ver')
  );
create policy messages_write on public.messages
  for all using (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.mensagens.enviar')
  )
  with check (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.mensagens.enviar')
  );

drop policy if exists queue_select on public.message_queue;
drop policy if exists queue_write  on public.message_queue;

create policy queue_select on public.message_queue
  for select using (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.mensagens.ver')
  );
create policy queue_write on public.message_queue
  for all using (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.mensagens.enviar')
  )
  with check (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.mensagens.enviar')
  );

-- ---------- Histórico ----------
-- O insert vem do queueService, logo depois de enfileirar: quem grava log é
-- sempre quem acabou de enviar. Daí a permissão de envio, não a de leitura.
drop policy if exists logs_select on public.message_logs;
drop policy if exists logs_insert on public.message_logs;

create policy logs_select on public.message_logs
  for select using (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.historico.ver')
  );
create policy logs_insert on public.message_logs
  for insert with check (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.mensagens.enviar')
  );

-- ---------- Agendamentos ----------
drop policy if exists schedules_select on public.schedules;
drop policy if exists schedules_write  on public.schedules;

create policy schedules_select on public.schedules
  for select using (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.agendamentos.ver')
  );
create policy schedules_insert on public.schedules
  for insert with check (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.agendamentos.editar')
  );
create policy schedules_update on public.schedules
  for update using (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.agendamentos.editar')
  )
  with check (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.agendamentos.editar')
  );
create policy schedules_delete on public.schedules
  for delete using (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.agendamentos.excluir')
  );

-- ---------- Regras de automação do painel ----------
drop policy if exists automation_select on public.automation_rules;
drop policy if exists automation_write  on public.automation_rules;

create policy automation_select on public.automation_rules
  for select using (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.automacoes.ver')
  );
create policy automation_write on public.automation_rules
  for all using (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.automacoes.editar')
  )
  with check (
    organization_id = public.current_org_id()
    and public.current_user_can('painel.automacoes.editar')
  );

-- ---------- Mídia (storage, 004) ----------
-- Quem sobe arquivo está montando um envio, então a permissão é a de enviar.
-- A leitura continua só por organização: a pasta já isola, e bloquear o
-- select quebraria a pré-visualização de mídia já enviada.
drop policy if exists "media_upload" on storage.objects;
drop policy if exists "media_delete" on storage.objects;

create policy "media_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and public.current_user_can('painel.mensagens.enviar')
  );

create policy "media_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and public.current_user_can('painel.mensagens.enviar')
  );

-- ============================================================
-- POLÍTICAS — CRM
-- ============================================================

-- ---------- Etapas ----------
drop policy if exists crm_stages_select on public.crm_stages;
drop policy if exists crm_stages_write  on public.crm_stages;

create policy crm_stages_select on public.crm_stages
  for select using (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.funil.ver')
  );
create policy crm_stages_insert on public.crm_stages
  for insert with check (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.etapas.editar')
  );
create policy crm_stages_update on public.crm_stages
  for update using (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.etapas.editar')
  )
  with check (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.etapas.editar')
  );
create policy crm_stages_delete on public.crm_stages
  for delete using (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.etapas.excluir')
  );

-- ---------- Contatos ----------
drop policy if exists crm_contacts_select on public.crm_contacts;
drop policy if exists crm_contacts_write  on public.crm_contacts;

create policy crm_contacts_select on public.crm_contacts
  for select using (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.contatos.ver')
  );
create policy crm_contacts_insert on public.crm_contacts
  for insert with check (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.contatos.editar')
  );
create policy crm_contacts_update on public.crm_contacts
  for update using (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.contatos.editar')
  )
  with check (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.contatos.editar')
  );
create policy crm_contacts_delete on public.crm_contacts
  for delete using (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.contatos.excluir')
  );

-- ---------- Vendas ----------
-- O with check no insert é o que impede um usuário de leitura de lançar
-- venda: em INSERT o Postgres só avalia o with check (nota da 031).
drop policy if exists crm_sales_select on public.crm_sales;
drop policy if exists crm_sales_write  on public.crm_sales;

create policy crm_sales_select on public.crm_sales
  for select using (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.vendas.ver')
  );
create policy crm_sales_insert on public.crm_sales
  for insert with check (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.vendas.editar')
  );
create policy crm_sales_update on public.crm_sales
  for update using (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.vendas.editar')
  )
  with check (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.vendas.editar')
  );
create policy crm_sales_delete on public.crm_sales
  for delete using (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.vendas.excluir')
  );

-- ---------- Histórico de etapas e fila de eventos ----------
drop policy if exists crm_history_select on public.crm_stage_history;
create policy crm_history_select on public.crm_stage_history
  for select using (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.funil.ver')
  );

drop policy if exists crm_events_select on public.crm_events;
create policy crm_events_select on public.crm_events
  for select using (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.contatos.ver')
  );

-- ---------- Automações de etapa (050) ----------
drop policy if exists crm_automations_select on public.crm_stage_automations;
drop policy if exists crm_automations_write  on public.crm_stage_automations;

create policy crm_automations_select on public.crm_stage_automations
  for select using (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.automacoes.ver')
  );
create policy crm_automations_write on public.crm_stage_automations
  for all using (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.automacoes.editar')
  )
  with check (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.automacoes.editar')
  );

-- ---------- Chaves de API ----------
drop policy if exists crm_api_keys_select on public.crm_api_keys;
create policy crm_api_keys_select on public.crm_api_keys
  for select using (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.chaves.ver')
  );

-- crm_settings segue sem policy nenhuma, de propósito (013): todo acesso
-- passa pelas RPCs, e o token nunca sai delas.

-- ============================================================
-- GUARDAS DENTRO DAS RPCs
--
-- Não bastava trocar as políticas: estas funções são security definer e
-- passam por cima da RLS, então a checagem tem que ser explícita no corpo.
-- ============================================================

create or replace function public.crm_reorder_stages(p_ids uuid[])
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
begin
  if not public.current_user_can('crm.etapas.editar') then
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
  if not public.current_user_can('crm.etapas.excluir') then
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

-- ---------- Chaves de API ----------
-- Assinaturas e corpos de 013, com a guarda trocada. A chave em texto puro
-- continua existindo uma vez só, no retorno.
create or replace function public.crm_api_key_create(p_name text)
returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org uuid := public.current_org_id();
  v_key text;
begin
  if not public.current_user_can('crm.chaves.editar') then
    raise exception 'Sem permissão para criar chaves de API';
  end if;

  -- gen_random_bytes/digest sem qualificar, como na 013: quem resolve é o
  -- `search_path = public, extensions` do cabeçalho. Qualificar aqui só
  -- criaria a chance de errar o schema em que o pgcrypto foi instalado.
  v_key := 'phc_' || encode(gen_random_bytes(24), 'hex');

  insert into public.crm_api_keys (organization_id, name, key_hash, key_prefix, created_by)
  values (
    v_org,
    coalesce(nullif(p_name, ''), 'Automação'),
    encode(digest(v_key, 'sha256'), 'hex'),
    left(v_key, 12),
    auth.uid()
  );

  return v_key;
end;
$$;

create or replace function public.crm_api_key_revoke(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.current_user_can('crm.chaves.editar') then
    raise exception 'Sem permissão para revogar chaves de API';
  end if;

  update public.crm_api_keys
  set revoked_at = now()
  where id = p_id and organization_id = public.current_org_id();
end;
$$;
