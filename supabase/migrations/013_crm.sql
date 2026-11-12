-- ============================================================
-- Módulo CRM — contatos, funil kanban, histórico, configurações
--
-- Segue o mesmo padrão multi-tenant do resto do projeto: tudo é
-- isolado por organization_id via RLS, usando current_org_id() e
-- current_user_role(). Nenhuma lógica de auth existente é alterada.
--
-- Pontos de projeto que valem leitura antes de mexer:
--
--  1. O token da Meta NUNCA é exposto ao cliente. A tabela crm_settings
--     tem RLS ligada e NENHUMA policy de select — nem o dono da org lê
--     pelo navegador. O acesso passa por RPCs security definer que
--     devolvem só o pixel e um booleano has_token.
--
--  2. Mudança de etapa é capturada por TRIGGER, não pelo app. Assim
--     arrastar no kanban, chamar o endpoint HTTP ou um update manual no
--     SQL produzem exatamente o mesmo histórico e o mesmo evento de
--     conversão — sem duplicar código nem esquecer um caminho.
--
--  3. Conversão usa outbox (crm_events). O trigger só enfileira; quem
--     entrega para a Meta é a Edge Function crm-worker, no mesmo estilo
--     da fila de mensagens que já existe.
-- ============================================================

-- No Supabase o pgcrypto vive no schema "extensions"; as funções que usam
-- digest()/gen_random_bytes() declaram search_path = public, extensions.
create extension if not exists pgcrypto with schema extensions;

-- ------------------------------------------------------------
-- ETAPAS DO FUNIL
-- ------------------------------------------------------------
create table public.crm_stages (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  color text not null default '#6366f1',
  position int not null default 0,
  -- Etapa que representa "ganhou": entrar nela dispara a Meta CAPI.
  is_conversion boolean not null default false,
  created_at timestamptz not null default now()
);

create index idx_crm_stages_org on public.crm_stages(organization_id, position);

-- Só uma etapa de conversão por organização.
create unique index idx_crm_stages_one_conversion
  on public.crm_stages(organization_id)
  where is_conversion;

-- ------------------------------------------------------------
-- CONTATOS
--
-- stage_id NULO = contato fora do funil. É o caso da base
-- pré-implementação: o contato existe, é pesquisável e editável na página
-- de Contatos, mas não ocupa coluna no kanban. Entrar no funil é atribuir
-- uma etapa; sair é voltar para null.
--
-- on delete restrict: o banco recusa apagar uma etapa que ainda tem
-- contatos. A regra do produto ("mova os contatos antes") é garantida no
-- banco, não só na tela.
-- ------------------------------------------------------------
create table public.crm_contacts (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  stage_id uuid references public.crm_stages(id) on delete restrict,
  name text not null,
  email text,
  phone text,
  -- Identificador da conversa no bot/automação externa. É por ele que o
  -- n8n encontra o contato sem conhecer o uuid interno.
  conversation_id text,
  tags text[] not null default '{}',
  -- Dinheiro em centavos: inteiro, sem erro de ponto flutuante.
  value_cents bigint not null default 0,
  description text,
  -- Ordem manual dentro da coluna do kanban.
  position int not null default 0,
  stage_changed_at timestamptz not null default now(),
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_crm_contacts_org on public.crm_contacts(organization_id);

-- Índice do kanban: só quem está no funil. Com a base pré-implementação
-- fora dele, este índice fica pequeno mesmo com dezenas de milhares de
-- contatos cadastrados.
create index idx_crm_contacts_board on public.crm_contacts(organization_id, stage_id, position, created_at desc)
  where stage_id is not null;

-- Índice da página de Contatos filtrando "fora do funil".
create index idx_crm_contacts_no_stage on public.crm_contacts(organization_id, created_at desc)
  where stage_id is null;
create index idx_crm_contacts_tags on public.crm_contacts using gin(tags);

-- Busca por nome/email/telefone sem varrer a tabela inteira.
create index idx_crm_contacts_search on public.crm_contacts
  using gin(to_tsvector('simple',
    coalesce(name, '') || ' ' || coalesce(email, '') || ' ' || coalesce(phone, '')));

-- conversation_id é a chave de entrada da API externa: precisa ser único
-- por org, senão "atualize o contato X" fica ambíguo.
create unique index idx_crm_contacts_conversation
  on public.crm_contacts(organization_id, conversation_id)
  where conversation_id is not null;

-- ------------------------------------------------------------
-- HISTÓRICO DE MOVIMENTAÇÕES
-- ------------------------------------------------------------
create table public.crm_stage_history (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade,
  from_stage_id uuid references public.crm_stages(id) on delete set null,
  to_stage_id uuid references public.crm_stages(id) on delete set null,
  -- Como a movimentação entrou no sistema.
  source text not null default 'system' check (source in ('ui', 'api', 'system')),
  changed_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index idx_crm_history_contact on public.crm_stage_history(contact_id, created_at desc);
create index idx_crm_history_org on public.crm_stage_history(organization_id, created_at desc);

-- ------------------------------------------------------------
-- CONFIGURAÇÕES (uma por organização)
--
-- meta_access_token é secreto. Ver nota 1 no topo do arquivo.
-- ------------------------------------------------------------
create table public.crm_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  meta_pixel_id text,
  meta_access_token text,
  meta_test_event_code text,
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- CHAVES DE API (automações externas: n8n, etc.)
--
-- Guarda só o hash. A chave em texto puro aparece uma única vez, no
-- momento em que é criada — mesmo princípio de uma senha.
-- ------------------------------------------------------------
create table public.crm_api_keys (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  key_hash text not null unique,
  -- Primeiros caracteres, só para o usuário reconhecer a chave na lista.
  key_prefix text not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index idx_crm_api_keys_org on public.crm_api_keys(organization_id);
create index idx_crm_api_keys_hash on public.crm_api_keys(key_hash) where revoked_at is null;

-- ------------------------------------------------------------
-- OUTBOX DE EVENTOS (Meta CAPI hoje; outros destinos depois)
--
-- event_type é texto livre de propósito: hoje só 'conversion' é gerado,
-- mas a fila e o worker já tratam qualquer tipo sem mudança de schema.
-- ------------------------------------------------------------
create type public.crm_event_status as enum ('pending', 'sent', 'failed');

create table public.crm_events (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid references public.crm_contacts(id) on delete cascade,
  event_type text not null default 'conversion',
  status public.crm_event_status not null default 'pending',
  attempts int not null default 0,
  error text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index idx_crm_events_pending on public.crm_events(status, created_at)
  where status = 'pending';

-- ------------------------------------------------------------
-- TRIGGER: histórico + evento de conversão
--
-- Fonte única da verdade para "o contato mudou de etapa". Ver nota 2.
-- ------------------------------------------------------------
-- Parte BEFORE: só carimba quando a etapa mudou. Precisa ser BEFORE para
-- poder alterar NEW antes da gravação.
create or replace function public.crm_touch_stage_changed()
returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.stage_id is not distinct from new.stage_id then
    return new;
  end if;
  new.stage_changed_at := now();
  return new;
end;
$$;

create trigger crm_contacts_stage_touch
  before insert or update of stage_id on public.crm_contacts
  for each row execute function public.crm_touch_stage_changed();

-- Parte AFTER: histórico e evento de conversão.
--
-- Tem de ser AFTER, não BEFORE: crm_stage_history tem FK para o contato,
-- e num BEFORE INSERT a linha do contato ainda não existe — o insert do
-- histórico violaria a chave estrangeira e derrubaria todo cadastro.
create or replace function public.crm_track_stage_change()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_source text;
  v_converts boolean;
  v_was_conversion boolean;
begin
  -- Nada mudou de etapa: não gera histórico nem evento. É isto que evita
  -- eventos duplicados quando o contato é salvo de novo na mesma etapa.
  if tg_op = 'UPDATE' and old.stage_id is not distinct from new.stage_id then
    return null;
  end if;

  -- Contato criado JÁ fora do funil (importação da base pré-implementação):
  -- não é movimentação, não gera histórico. Sem isto, importar 20 mil
  -- contatos criaria 20 mil linhas de histórico sem significado nenhum.
  if tg_op = 'INSERT' and new.stage_id is null then
    return null;
  end if;

  -- Tem usuário autenticado = veio da tela; sem usuário = service role,
  -- ou seja, a Edge Function chamada por uma automação externa.
  v_source := case when auth.uid() is null then 'api' else 'ui' end;

  insert into public.crm_stage_history (
    organization_id, contact_id, from_stage_id, to_stage_id, source, changed_by
  ) values (
    new.organization_id,
    new.id,
    case when tg_op = 'UPDATE' then old.stage_id else null end,
    new.stage_id,
    v_source,
    auth.uid()
  );

  select is_conversion into v_converts
  from public.crm_stages where id = new.stage_id;

  if tg_op = 'UPDATE' then
    select is_conversion into v_was_conversion
    from public.crm_stages where id = old.stage_id;
  else
    v_was_conversion := false;
  end if;

  -- Enfileira só na entrada REAL na etapa de conversão: vindo de uma etapa
  -- que não convertia. Reentrar na mesma etapa não gera evento novo.
  if coalesce(v_converts, false) and not coalesce(v_was_conversion, false) then
    insert into public.crm_events (organization_id, contact_id, event_type, payload)
    values (
      new.organization_id,
      new.id,
      'conversion',
      jsonb_build_object(
        'value_cents', new.value_cents,
        'email', new.email,
        'phone', new.phone,
        'name', new.name,
        'source', v_source
      )
    );
  end if;

  return null;
end;
$$;

create trigger crm_contacts_stage_change
  after insert or update of stage_id on public.crm_contacts
  for each row execute function public.crm_track_stage_change();

-- updated_at automático
create or replace function public.crm_touch_updated_at()
returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger crm_contacts_touch
  before update on public.crm_contacts
  for each row execute function public.crm_touch_updated_at();

-- ------------------------------------------------------------
-- RLS — mesmo padrão das demais tabelas do projeto
-- ------------------------------------------------------------
alter table public.crm_stages enable row level security;
alter table public.crm_contacts enable row level security;
alter table public.crm_stage_history enable row level security;
alter table public.crm_settings enable row level security;
alter table public.crm_api_keys enable row level security;
alter table public.crm_events enable row level security;

create policy crm_stages_select on public.crm_stages
  for select using (organization_id = public.current_org_id());
create policy crm_stages_write on public.crm_stages
  for all using (organization_id = public.current_org_id() and public.current_user_role() in ('admin','operator'))
  with check (organization_id = public.current_org_id());

create policy crm_contacts_select on public.crm_contacts
  for select using (organization_id = public.current_org_id());
create policy crm_contacts_write on public.crm_contacts
  for all using (organization_id = public.current_org_id() and public.current_user_role() in ('admin','operator'))
  with check (organization_id = public.current_org_id());

create policy crm_history_select on public.crm_stage_history
  for select using (organization_id = public.current_org_id());

create policy crm_events_select on public.crm_events
  for select using (organization_id = public.current_org_id());

-- crm_api_keys: lista sim, mas o hash nunca serve para reconstruir a chave.
create policy crm_api_keys_select on public.crm_api_keys
  for select using (organization_id = public.current_org_id());

-- crm_settings: RLS ligada e NENHUMA policy — deliberado. Todo acesso passa
-- pelas RPCs abaixo, que jamais devolvem o token.

-- ------------------------------------------------------------
-- RPCs de configuração
-- ------------------------------------------------------------

-- Devolve o pixel e se existe token — nunca o token em si.
create or replace function public.crm_settings_get()
returns table (meta_pixel_id text, has_token boolean, meta_test_event_code text)
language sql stable security definer set search_path = public as $$
  select s.meta_pixel_id,
         coalesce(s.meta_access_token, '') <> '',
         s.meta_test_event_code
  from public.crm_settings s
  where s.organization_id = public.current_org_id();
$$;

-- Salva a configuração. p_token nulo mantém o token atual (a tela mostra
-- o campo vazio por segurança; vazio não pode significar "apague").
-- Para remover, envie a string '' explicitamente.
create or replace function public.crm_settings_save(
  p_pixel text,
  p_token text default null,
  p_test_code text default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
begin
  if public.current_user_role() <> 'admin' then
    raise exception 'Apenas administradores podem alterar as configurações do CRM';
  end if;

  insert into public.crm_settings (organization_id, meta_pixel_id, meta_access_token, meta_test_event_code, updated_at)
  values (v_org, nullif(p_pixel, ''), nullif(p_token, ''), nullif(p_test_code, ''), now())
  on conflict (organization_id) do update set
    meta_pixel_id = nullif(excluded.meta_pixel_id, ''),
    -- Em ON CONFLICT a linha existente é referenciada pelo nome da tabela,
    -- sem qualificar o schema.
    meta_access_token = case
      when p_token is null then crm_settings.meta_access_token
      else nullif(p_token, '')
    end,
    meta_test_event_code = nullif(excluded.meta_test_event_code, ''),
    updated_at = now();
end;
$$;

-- ------------------------------------------------------------
-- RPCs de chave de API
-- ------------------------------------------------------------

-- Gera a chave, guarda só o sha256 e devolve o texto puro UMA vez.
create or replace function public.crm_api_key_create(p_name text)
returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org uuid := public.current_org_id();
  v_key text;
begin
  if public.current_user_role() <> 'admin' then
    raise exception 'Apenas administradores podem criar chaves de API';
  end if;

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
  if public.current_user_role() <> 'admin' then
    raise exception 'Apenas administradores podem revogar chaves de API';
  end if;

  update public.crm_api_keys
  set revoked_at = now()
  where id = p_id and organization_id = public.current_org_id();
end;
$$;

-- ------------------------------------------------------------
-- RPCs de etapas
-- ------------------------------------------------------------

-- Reordena as etapas em uma transação só (drag and drop das colunas).
create or replace function public.crm_reorder_stages(p_ids uuid[])
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
begin
  if public.current_user_role() not in ('admin', 'operator') then
    raise exception 'Sem permissão para reordenar etapas';
  end if;

  update public.crm_stages s
  set position = idx.ord - 1
  from unnest(p_ids) with ordinality as idx(id, ord)
  where s.id = idx.id and s.organization_id = v_org;
end;
$$;

-- Exclui uma etapa. Se ela tiver contatos, p_move_to é obrigatório e os
-- contatos vão para lá antes — a regra "não perca contatos" fica no banco.
-- p_unassign = true tira os contatos do funil (stage_id null) em vez de
-- movê-los para outra etapa. Útil quando a etapa excluída acumulou base
-- antiga que não deve entupir outra coluna.
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
  if public.current_user_role() not in ('admin', 'operator') then
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

-- Cria o funil padrão na primeira visita, se a org ainda não tem etapas.
-- Feito por RPC (e não no handle_new_user) justamente para não encostar
-- na lógica de signup que já existe.
create or replace function public.crm_bootstrap()
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
begin
  if v_org is null then return; end if;
  if exists (select 1 from public.crm_stages where organization_id = v_org) then return; end if;

  insert into public.crm_stages (organization_id, name, color, position, is_conversion) values
    (v_org, 'Novo lead',   '#64748b', 0, false),
    (v_org, 'Contato',     '#3b82f6', 1, false),
    (v_org, 'Negociação',  '#f59e0b', 2, false),
    (v_org, 'Ganho',       '#22c55e', 3, true),
    (v_org, 'Perdido',     '#ef4444', 4, false);
end;
$$;

-- ------------------------------------------------------------
-- RPCs do kanban (paginação por coluna)
--
-- O funil não carrega todos os contatos: traz os N primeiros de cada
-- etapa e, à parte, a contagem e a soma reais de cada coluna. Assim o
-- cabeçalho mostra "1.240 contatos · R$ 380.000" mesmo tendo baixado só
-- 20 cards, e o "carregar mais" busca o resto sob demanda.
-- ------------------------------------------------------------

-- Os N primeiros contatos de cada etapa, em uma consulta só.
create or replace function public.crm_board(p_per_stage int default 20)
returns setof public.crm_contacts
language sql stable security definer set search_path = public as $$
  -- Ranqueia a LINHA INTEIRA como composto (`c`) e expande com (r.c).*
  -- só no fim. Fazer `select *, row_number()` na subconsulta acrescentaria
  -- a coluna rn ao resultado, e aí a função não bate mais com o tipo
  -- crm_contacts que ela declara devolver.
  select (r.c).*
  from (
    select c,
           row_number() over (
             partition by c.stage_id
             order by c.position, c.created_at desc
           ) as rn
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and c.stage_id is not null
  ) r
  where r.rn <= greatest(p_per_stage, 1);
$$;

-- Contagem e valor total por etapa — agregado no banco, não na rede.
create or replace function public.crm_stage_stats()
returns table (stage_id uuid, contact_count bigint, total_value_cents bigint)
language sql stable security definer set search_path = public as $$
  select c.stage_id, count(*), coalesce(sum(c.value_cents), 0)
  from public.crm_contacts c
  where c.organization_id = public.current_org_id()
    and c.stage_id is not null
  group by c.stage_id;
$$;

-- ------------------------------------------------------------
-- RPC do worker: resolve a chave de API → organização
--
-- Sem filtro de org (a org é justamente o que estamos descobrindo) e
-- revogada para clientes: uso exclusivo do service role, igual às RPCs
-- do worker de mensagens.
-- ------------------------------------------------------------
create or replace function public.crm_resolve_api_key(p_key text)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org uuid;
  v_id uuid;
begin
  select id, organization_id into v_id, v_org
  from public.crm_api_keys
  where key_hash = encode(digest(p_key, 'sha256'), 'hex')
    and revoked_at is null;

  if v_id is null then return null; end if;

  update public.crm_api_keys set last_used_at = now() where id = v_id;
  return v_org;
end;
$$;

revoke all on function public.crm_resolve_api_key(text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- REALTIME — kanban e tabela atualizam sozinhos entre abas/usuários
-- ------------------------------------------------------------
alter publication supabase_realtime add table public.crm_contacts;
alter publication supabase_realtime add table public.crm_stages;

-- ------------------------------------------------------------
-- CRON: entrega dos eventos de conversão, a cada 10 minutos
--
-- Não é 1 minuto de propósito. A CAPI da Meta usa o event_time que o
-- outbox grava no instante real da movimentação, então atrasar a ENTREGA
-- não desloca o evento no tempo nem distorce a atribuição — a Meta aceita
-- eventos com até 7 dias. Em troca, o CRM consome 4,3 mil invocações/mês
-- em vez de 43 mil, deixando a cota do plano Free para o envio de
-- mensagens, que é sensível a latência de verdade.
-- ------------------------------------------------------------
select cron.schedule(
  'ph-groups-crm-worker',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://__SUPABASE_REF__.supabase.co/functions/v1/crm-worker',
    headers := '{"Content-Type": "application/json", "x-worker-secret": "5085fa755ec4d33c3aade64fc9379bd9789b6af90174603e"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
