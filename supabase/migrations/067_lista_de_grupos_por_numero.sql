-- ============================================================
-- Lista de grupos por número: a chamada cara sai para o pg_net
--
-- O PROBLEMA
--
-- Importar grupos chamava /group/fetchAllGroups com o usuário esperando na
-- frente da tela. Essa rota pede ao WhatsApp a metadata de TODOS os grupos do
-- número numa tacada; em número com muitos grupos ela passa do tempo da Edge
-- Function e a importação nunca chega a abrir.
--
-- Tentamos /chat/findChats, que lê o banco local da Evolution e responde na
-- hora. Não serviu: devolveu grupos de OUTRAS instâncias. Lista de importação
-- com grupo que não é daquele número é pior que lista lenta, então voltamos
-- ao fetchAllGroups — que é por instância e não tem como vazar.
--
-- POR QUE NÃO RESOLVEU SÓ MOVENDO PARA O WORKER
--
-- Edge Function tem teto de ~150s, e ele vale para o worker também. Mover a
-- chamada para lá tira o usuário da espera, mas se o fetchAllGroups precisar
-- de mais que isso ele falha — e falha sempre, não uma vez: o cache nunca
-- enche.
--
-- O pg_net não tem esse teto. O tempo limite é PARÂMETRO da chamada, e é
-- justamente a extensão que este projeto já usa desde a 005 para acionar o
-- worker pelo cron. Então a chamada cara sai do Edge Function e vai para o
-- banco.
--
-- O DESENHO
--
--   group_discovery   1 linha por número: o pedido e em que pé ele está
--   session_groups    o resultado, os grupos daquele número
--
--   cron (1 min) → process_group_discovery()
--                  fase 1: colhe respostas que o pg_net já trouxe
--                  fase 2: dispara UM pedido pendente
--
-- A tela de importação lê session_groups, que é instantâneo. A chamada cara
-- só acontece quando não há cache ou quando a pessoa pede para atualizar.
--
-- O CONTRATO É A TABELA
--
-- Quem preenche session_groups é intercambiável. Hoje é o pg_net; se um dia
-- for outra coisa, o painel não muda uma linha.
--
-- SE ESTA FUNÇÃO QUEBRAR
--
-- process_group_discovery() roda num job de cron PRÓPRIO, separado do job que
-- aciona o worker. Se ela levantar exceção, o pg_cron registra a falha naquele
-- job e segue; envios, agendamentos e sincronização continuam intocados. O
-- pior caso aqui é a importação parar de listar grupos novos.
--
-- ANTES DE APLICAR
--
-- Os segredos precisam estar no Vault (uma vez, fora desta migration para não
-- deixarem a chave gravada no arquivo):
--
--   select vault.create_secret('https://sua-evolution', 'evolution_api_url');
--   select vault.create_secret('SUA_CHAVE',             'evolution_api_key');
-- ============================================================

-- ------------------------------------------------------------
-- O cache
-- ------------------------------------------------------------

create table public.session_groups (
  session_id uuid not null references public.whatsapp_sessions(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  group_jid text not null,
  subject text not null,
  description text,
  -- Nº de participantes segundo o WhatsApp, só para reconhecer o grupo na
  -- lista. O número que vale é o de group_participants, sincronizado depois
  -- da importação.
  size int,
  synced_at timestamptz not null default now(),
  primary key (session_id, group_jid)
);

create index idx_session_groups_org on public.session_groups(organization_id);

alter table public.session_groups enable row level security;

-- Só leitura para o painel. Quem escreve é a função do cron, que é security
-- definer e não passa por policy.
create policy session_groups_select on public.session_groups
  for select using (organization_id = public.current_org_id());

-- ------------------------------------------------------------
-- O pedido
-- ------------------------------------------------------------

create table public.group_discovery (
  session_id uuid primary key references public.whatsapp_sessions(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  found int not null default 0,
  error text,
  -- Tentativas já feitas. A primeira chamada de um número grande costuma
  -- estourar o tempo mas deixa a metadata no cache da Evolution, então a
  -- segunda tende a voltar rápido — por isso vale insistir antes de desistir.
  attempts int not null default 0,
  -- id devolvido pelo net.http_get; é por ele que a fase 1 acha a resposta
  net_request_id bigint,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

alter table public.group_discovery enable row level security;

-- Leitura para a tela acompanhar o progresso. Escrita é só pela RPC abaixo e
-- pela função do cron: assim ninguém marca um pedido como 'done' por fora.
create policy group_discovery_select on public.group_discovery
  for select using (organization_id = public.current_org_id());

-- ------------------------------------------------------------
-- Desistir ou tentar de novo
-- ------------------------------------------------------------

create or replace function public.discovery_retry_or_fail(p_session uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.group_discovery
     set status         = case when attempts >= 3 then 'failed' else 'pending' end,
         error          = p_error,
         net_request_id = null,
         started_at     = null,
         finished_at    = case when attempts >= 3 then now() else null end
   where session_id = p_session;
end;
$$;

revoke all on function public.discovery_retry_or_fail(uuid, text) from public;

-- ------------------------------------------------------------
-- Pedir uma descoberta (chamada pelo painel)
-- ------------------------------------------------------------

-- Único caminho do painel para criar/renovar um pedido.
--
-- O on conflict tem WHERE de propósito: pedido pending ou running há menos de
-- 10 minutos não é reiniciado. Sem isso, cada clique em "atualizar lista"
-- empurraria requested_at para frente e o banco ficaria refazendo a chamada
-- cara. É esta cláusula que segura o custo.
--
-- Não dá erro quando já existe pedido em andamento: a tela está em polling e
-- vai ver o resultado do pedido que já existe.
create or replace function public.request_group_discovery(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if not public.current_user_can('painel.grupos.editar') then
    raise exception 'Seu perfil não tem a permissão "painel.grupos.editar" para importar grupos';
  end if;

  select organization_id into v_org
    from public.whatsapp_sessions
   where id = p_session_id and organization_id = public.current_org_id();

  if v_org is null then
    raise exception 'Número não encontrado nesta organização';
  end if;

  insert into public.group_discovery (session_id, organization_id, status, requested_at)
  values (p_session_id, v_org, 'pending', now())
  on conflict (session_id) do update
    set status         = 'pending',
        requested_at   = now(),
        started_at     = null,
        finished_at    = null,
        net_request_id = null,
        error          = null,
        found          = 0,
        attempts       = 0
    where public.group_discovery.status not in ('pending', 'running')
       or public.group_discovery.requested_at < now() - interval '10 minutes';
end;
$$;

revoke all on function public.request_group_discovery(uuid) from public;
grant execute on function public.request_group_discovery(uuid) to authenticated;

-- ------------------------------------------------------------
-- O motor (cron)
-- ------------------------------------------------------------

-- Roda a cada minuto. Fase 1 colhe o que o pg_net já trouxe, fase 2 dispara
-- um pedido novo — nessa ordem, para um resultado pronto não esperar mais um
-- minuto atrás de um disparo.
--
-- Cada pedido é tratado dentro do seu próprio bloco de exceção: payload
-- estranho de um número não pode derrubar a colheita dos outros.
create or replace function public.process_group_discovery()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url        text;
  v_key        text;
  v_row        record;
  v_resp       record;
  v_body       jsonb;
  v_count      int;
  v_instance   text;
  v_conectado  text;
begin
  -- ---------- fase 1: colher ----------
  for v_row in
    select * from public.group_discovery
     where status = 'running' and net_request_id is not null
  loop
    begin
      select status_code, content, timed_out, error_msg
        into v_resp
        from net._http_response
       where id = v_row.net_request_id;

      if not found then
        -- Ainda em voo. Passado o teto, a requisição sumiu — o processo de
        -- background do pg_net reinicia sem avisar e não tem retry próprio.
        if v_row.started_at < now() - interval '8 minutes' then
          perform public.discovery_retry_or_fail(
            v_row.session_id,
            'A busca não retornou a tempo. Tentando de novo.'
          );
        end if;
        continue;
      end if;

      if coalesce(v_resp.timed_out, false) then
        perform public.discovery_retry_or_fail(
          v_row.session_id,
          'O WhatsApp não respondeu dentro do tempo limite.'
        );
        continue;
      end if;

      if v_resp.status_code is distinct from 200 then
        perform public.discovery_retry_or_fail(
          v_row.session_id,
          format('A Evolution respondeu %s. %s',
                 coalesce(v_resp.status_code::text, 'erro de conexão'),
                 coalesce(v_resp.error_msg, ''))
        );
        continue;
      end if;

      v_body := v_resp.content::jsonb;

      if jsonb_typeof(v_body) <> 'array' then
        perform public.discovery_retry_or_fail(
          v_row.session_id,
          'A Evolution devolveu um formato inesperado para a lista de grupos.'
        );
        continue;
      end if;

      -- Troca a lista inteira: grupo de que o número saiu tem que sumir
      -- daqui, senão continua aparecendo para importar.
      delete from public.session_groups where session_id = v_row.session_id;

      insert into public.session_groups
        (session_id, organization_id, group_jid, subject, description, size)
      select v_row.session_id,
             v_row.organization_id,
             g->>'id',
             coalesce(nullif(trim(g->>'subject'), ''), 'Grupo sem nome'),
             nullif(trim(coalesce(g->>'desc', '')), ''),
             case when jsonb_typeof(g->'size') = 'number' then (g->>'size')::int end
        from jsonb_array_elements(v_body) g
       where g->>'id' like '%@g.us'
      -- A resposta pode repetir um jid; sem isto o insert inteiro morre na PK.
      on conflict (session_id, group_jid) do update
        set subject     = excluded.subject,
            description = excluded.description,
            size        = excluded.size,
            synced_at   = now();

      get diagnostics v_count = row_count;

      update public.group_discovery
         set status = 'done', found = v_count, error = null,
             net_request_id = null, finished_at = now()
       where session_id = v_row.session_id;

    exception when others then
      perform public.discovery_retry_or_fail(
        v_row.session_id,
        'Falha ao ler a lista de grupos: ' || left(sqlerrm, 200)
      );
    end;
  end loop;

  -- ---------- fase 2: disparar ----------
  select * into v_row
    from public.group_discovery
   where status = 'pending'
   order by requested_at
   limit 1;

  if not found then
    return;
  end if;

  select instance_name, status into v_instance, v_conectado
    from public.whatsapp_sessions
   where id = v_row.session_id;

  if v_instance is null then
    update public.group_discovery
       set status = 'failed', error = 'Número não encontrado', finished_at = now()
     where session_id = v_row.session_id;
    return;
  end if;

  if v_conectado <> 'connected' then
    update public.group_discovery
       set status = 'failed',
           error = 'Número desconectado — conecte antes de listar os grupos',
           finished_at = now()
     where session_id = v_row.session_id;
    return;
  end if;

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'evolution_api_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'evolution_api_key';

  if v_url is null or v_key is null then
    update public.group_discovery
       set status = 'failed',
           error = 'Segredos evolution_api_url/evolution_api_key ausentes no Vault',
           finished_at = now()
     where session_id = v_row.session_id;
    return;
  end if;

  update public.group_discovery
     set status         = 'running',
         attempts       = attempts + 1,
         started_at     = now(),
         error          = null,
         net_request_id = net.http_get(
           url := rtrim(v_url, '/')
                  || '/group/fetchAllGroups/' || v_instance
                  || '?getParticipants=false',
           headers := jsonb_build_object('apikey', v_key),
           -- 5 minutos. É o ponto do desenho todo: aqui o limite é escolha
           -- nossa, não teto de plataforma.
           timeout_milliseconds := 300000
         )
   where session_id = v_row.session_id;
end;
$$;

revoke all on function public.process_group_discovery() from public;

-- ------------------------------------------------------------
-- Cron
-- ------------------------------------------------------------

-- Job próprio, separado do 'ph-groups-worker': falha aqui não encosta em
-- envios nem agendamentos.
select cron.schedule(
  'ph-groups-discovery',
  '* * * * *',
  $$ select public.process_group_discovery(); $$
);
