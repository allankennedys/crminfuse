-- ============================================================
-- Unificar dois cadastros do MESMO cliente, escolhidos a dedo
--
-- O caso que motivou: a venda chega da Kirvano com um número diferente do
-- que o cliente usa no WhatsApp. A automação não encontra o cadastro,
-- cria outro (`upsert` com creatives, crm-api) e a venda nasce nele. Fica
-- assim:
--
--   contato A (real)    → conversa, ctwa_clid/fbc do anúncio, NENHUMA venda
--   contato B (criado)  → a venda e o e-mail do gateway, nenhum clique
--
-- E o pior: a venda de B normalmente não gera evento nenhum, porque
-- crm_enqueue_conversion (072) sai na primeira guarda — B não passa em
-- crm_is_ad_contact. A receita existe no caixa e a Meta nunca soube dela.
--
-- POR QUE FUNDIR, E NÃO SÓ TROCAR O CONTATO DA VENDA
--
-- Repontar a venda deixaria B na base como lead que nunca comprou (inflando
-- "leads criados" e derrubando a conversão do funil) e deixaria o e-mail do
-- gateway apodrecendo nele — justamente o campo que melhora o casamento do
-- lado da Meta quando não há fbc (`em` no user_data, crm-worker). Fundir faz
-- as duas coisas e mais: é o que descreve o que de fato aconteceu, um
-- cliente com dois cadastros.
--
-- POR QUE A FUSÃO QUE JÁ EXISTE NÃO SERVE
--
-- crm_merge_duplicate_contacts (069/073) acha duplicata pelo MESMO número e
-- se recusa a tocar em contato com venda ou com evento. Aqui os números são
-- diferentes por definição, e o descartado é justamente o que tem a venda.
-- Esta é a fusão escolhida a dedo: quem fica e quem sai vêm da tela.
--
-- AS DUAS REGRAS DA META, E POR QUE ELAS SAEM DE GRAÇA
--
--   1. O que já foi enviado NÃO vai de novo. Os eventos do descartado mudam
--      de dono em vez de serem apagados, e `sent` continua `sent`: é a prova
--      do que a Meta recebeu e é a trava 1 da 072 (evento com aquele
--      `sale_id` e status <> 'skipped' impede um segundo Purchase).
--
--      Apagar o contato descartado sem mover os eventos seria o erro caro:
--      crm_events.contact_id é `on delete cascade` (013), então o delete
--      levaria junto a trava anti-duplicata e o próximo enfileiramento
--      mandaria o mesmo Purchase outra vez.
--
--   2. O que ainda não foi vai, se o cliente que ficou tiver com que ir. Não
--      há regra nova: crm_enqueue_pending_conversions (072) já é
--      literalmente "manda o que falta, uma por venda, pulando as que já têm
--      evento". Como o sobrevivente é quem tem o ctwa_clid, a venda órfã
--      passa a qualificar e sai no próximo ciclo do worker.
--
-- ORDEM DAS OPERAÇÕES — nenhuma delas é preferência
--
--   vendas → eventos → delete → campos → etapa → payloads → enfileirar
--
--   • vendas e eventos ANTES do delete: as duas tabelas são cascade.
--   • conversation_id só DEPOIS do delete: índice único por organização
--     (mesma pedra da 045 e da 073).
--   • campos ANTES dos payloads: o payload pendente é regravado a partir do
--     sobrevivente, e ele precisa já estar com o e-mail que subiu do
--     descartado.
--   • enfileirar POR ÚLTIMO: só aí o sobrevivente é o cliente inteiro.
--
-- A DATA DA VENDA NÃO MUDA
--
-- Nem no CRM nem na Meta. A transferência grava só `contact_id`, e `sold_at`
-- não é tocado por ninguém — então a venda continua no dia em que aconteceu
-- para os relatórios e para o desempate que decide qual é a primeira venda do
-- cliente. Do lado da Meta a garantia precisou de código: o event_time saía
-- do instante do enfileiramento, o que poria uma compra de três dias atrás no
-- dia de hoje do Gerenciador. Ver a seção do `sold_at` no payload, no fim.
--
-- O QUE SE PERDE, DE PROPÓSITO
--
-- O histórico de etapas do descartado (crm_stage_history é cascade) e o
-- telefone errado, que fica registrado na descrição em vez de sumir sem
-- deixar rastro. Mesma decisão da 045.
--
-- DEPENDE DE: 031 (vendas), 069/071 (contato único, clique da landing),
-- 072 (evento por venda).
--
-- ORDEM DE DEPLOY: qualquer uma. A única mudança no worker é o `sold_at` do
-- payload, aditivo nas duas direções — worker velho ignora o campo novo,
-- worker novo não o acha em evento antigo e cai no `created_at` de sempre. A
-- tela também não é pré-requisito: sem ela a função existe e não é chamada.
--
-- Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

-- ------------------------------------------------------------
-- A TRAVA QUE PRECISA DE UMA PORTA
--
-- crm_sales_stamp (031) proíbe trocar a venda de contato, e a justificativa
-- dela continua inteira: "a trigger de sincronia só recalcula um contato por
-- linha", então um UPDATE solto deixaria o contato de origem com
-- sales_count de uma venda que não é mais dele — número errado no board, no
-- LTV e na recompra, sem nada sinalizando.
--
-- A fusão é a única operação que pode transferir sem cair nisso: o contato
-- de origem é APAGADO na mesma transação, então não sobra contador errado
-- para ninguém ler. A porta é uma variável de sessão que só esta função
-- levanta, com `set_config(..., is_local => true)`: vale até o fim da
-- transação e some sozinha. Para todo o resto — painel, API, n8n — a trava
-- continua exatamente como era.
-- ------------------------------------------------------------
create or replace function public.crm_sales_stamp()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  -- Trocar o contato de uma venda deixaria os totais do contato antigo
  -- errados. Não existe caso de uso à mão: exclua a venda e lance no contato
  -- certo. A exceção é a fusão de cadastros (077), que apaga o contato de
  -- origem na mesma transação e por isso não deixa contador órfão.
  if tg_op = 'UPDATE'
     and new.contact_id is distinct from old.contact_id
     and coalesce(current_setting('crm.merging_contacts', true), '') <> 'on'
  then
    raise exception 'Uma venda não pode ser transferida de contato';
  end if;

  select organization_id into v_org
  from public.crm_contacts where id = new.contact_id;

  if v_org is null then
    raise exception 'Contato inexistente';
  end if;

  -- A org vem do contato, sempre. Combinado com o with check da policy
  -- (organization_id = current_org_id()), lançar venda no contato de outra
  -- organização é recusado pela RLS.
  new.organization_id := v_org;

  if new.created_by is null then
    new.created_by := auth.uid();
  end if;

  return new;
end;
$$;

comment on function public.crm_sales_stamp() is
  'Carimba org e autor da venda e impede transferi-la de contato — só a '
  'fusão de cadastros (077) atravessa, porque apaga a origem na mesma '
  'transação.';

-- ------------------------------------------------------------
-- A FUSÃO
--
-- Devolve o que foi feito, não um "ok": a tela precisa dizer quantas vendas
-- mudaram de dono e se alguma conversão entrou na fila para a Meta. Sem
-- isso, a operação mais delicada do CRM terminaria num toast genérico.
-- ------------------------------------------------------------
create or replace function public.crm_merge_contacts(
  p_survivor uuid,
  p_loser    uuid
)
returns table(
  survivor_id        uuid,
  survivor_name      text,
  -- Vendas que mudaram de dono.
  sales_moved        int,
  -- Eventos que mudaram de dono, de qualquer status.
  events_moved       int,
  -- Quantos desses já estavam na Meta e portanto NÃO serão reenviados.
  events_already_sent int,
  -- Conversões enfileiradas agora, uma por venda que ainda não tinha.
  conversions_queued int
)
language plpgsql security definer set search_path = public as $$
declare
  v_org       uuid;
  v_surv      public.crm_contacts;
  v_loser     public.crm_contacts;
  v_eventos   uuid[];
  v_leva_web  boolean;
  v_tinha_venda boolean;
  v_stage     uuid;
  v_ad_source text;
  v_sales     int := 0;
  v_events    int := 0;
  v_sent      int := 0;
  v_queued    int := 0;
begin
  -- Operação de painel, sempre. Automação não funde cadastro sozinha: o
  -- julgamento de "estes dois são a mesma pessoa" é humano, e errar junta
  -- dois clientes de verdade num só.
  if auth.uid() is null then
    raise exception 'A unificação de contatos só é feita por um usuário autenticado';
  end if;

  -- Mesma régua da fusão automática (073) e das campanhas ignoradas (059):
  -- apaga cadastro e mexe no que já foi para a Meta.
  if public.current_user_role() <> 'admin' then
    raise exception 'Apenas administradores podem unificar contatos';
  end if;

  if p_survivor is null or p_loser is null then
    raise exception 'Informe os dois contatos';
  end if;

  if p_survivor = p_loser then
    raise exception 'Os dois lados são o mesmo cadastro';
  end if;

  v_org := public.current_org_id();

  -- TRAVA NOS DOIS, EM ORDEM DE id.
  --
  -- Duas pessoas unificando o mesmo par ao mesmo tempo dariam duas
  -- transferências da mesma venda; a segunda espera e encontra o cadastro já
  -- apagado, que é o erro certo de receber. A ordem por id não é estética:
  -- sem ela, alguém unificando A→B enquanto outro unifica B→A trava cada um
  -- na linha que o outro segura, e o Postgres mata uma das transações por
  -- deadlock. Travando sempre na mesma ordem, a segunda apenas espera.
  perform 1
  from public.crm_contacts
  where id in (p_survivor, p_loser) and organization_id = v_org
  order by id
  for update;

  select * into v_surv
  from public.crm_contacts
  where id = p_survivor and organization_id = v_org
  for update;
  if not found then
    raise exception 'O contato que fica não existe nesta organização';
  end if;

  select * into v_loser
  from public.crm_contacts
  where id = p_loser and organization_id = v_org
  for update;
  if not found then
    raise exception 'O contato que sai não existe nesta organização';
  end if;

  -- Guardado antes de qualquer coisa: é ele que decide se a fusão precisa
  -- levar o sobrevivente para a etapa de conversão lá embaixo.
  v_tinha_venda := coalesce(v_surv.sales_count, 0) > 0;

  -- ---------- 1. VENDAS ----------
  -- A porta da trava, aberta pelo tempo desta transação e fechada no fim.
  perform set_config('crm.merging_contacts', 'on', true);

  update public.crm_sales
  set contact_id = p_survivor
  where contact_id = p_loser;
  get diagnostics v_sales = row_count;

  perform set_config('crm.merging_contacts', 'off', true);

  -- ---------- 2. EVENTOS ----------
  -- Os ids são colhidos ANTES do update porque é por eles que o passo 6
  -- reconhece o que veio de fora. Depois de mudar o dono não há mais como
  -- distinguir um evento do descartado de um evento que já era do
  -- sobrevivente — e o payload de cada grupo tem tratamento diferente.
  select coalesce(array_agg(e.id), '{}'::uuid[]),
         count(*) filter (where e.status::text = 'sent')::int
    into v_eventos, v_sent
  from public.crm_events e
  where e.contact_id = p_loser;

  update public.crm_events
  set contact_id = p_survivor
  where id = any(v_eventos);
  get diagnostics v_events = row_count;

  -- ---------- 3. O DESCARTADO SAI ----------
  -- Depois das duas tabelas cascade acima, antes do conversation_id abaixo.
  delete from public.crm_contacts where id = p_loser;

  -- ---------- 4. O QUE SOBE PARA O SOBREVIVENTE ----------
  -- O BLOCO DA LANDING VIAJA INTEIRO OU NÃO VIAJA (mesma regra da 073):
  -- campo a campo, o fbc de uma visita acabaria ao lado do campaign_id de
  -- outra e a venda seria atribuída à campanha errada, com toda a aparência
  -- de estar certa. Só entra quando o sobrevivente não tem clique nenhum.
  v_leva_web := btrim(coalesce(v_surv.fbc, '')) = ''
            and btrim(coalesce(v_loser.fbc, '')) <> '';

  update public.crm_contacts s set
    conversation_id = coalesce(s.conversation_id, v_loser.conversation_id),
    email           = coalesce(nullif(btrim(coalesce(s.email, '')), ''), v_loser.email),
    origem          = coalesce(nullif(btrim(coalesce(s.origem, '')), ''), v_loser.origem),
    ctwaclid        = coalesce(nullif(btrim(coalesce(s.ctwaclid, '')), ''), v_loser.ctwaclid),
    source_id       = coalesce(s.source_id, v_loser.source_id),
    fbc             = case when v_leva_web then v_loser.fbc         else s.fbc end,
    fbp             = case when v_leva_web then v_loser.fbp         else s.fbp end,
    client_ip       = case when v_leva_web then v_loser.client_ip   else s.client_ip end,
    user_agent      = case when v_leva_web then v_loser.user_agent  else s.user_agent end,
    landing_url     = case when v_leva_web then v_loser.landing_url else s.landing_url end,
    campaign_id     = case when v_leva_web then v_loser.campaign_id else s.campaign_id end,
    adset_id        = case when v_leva_web then v_loser.adset_id    else s.adset_id end,
    ad_id           = case when v_leva_web then v_loser.ad_id       else s.ad_id end,
    channel         = coalesce(s.channel, v_loser.channel),
    phone           = coalesce(s.phone, v_loser.phone),
    assigned_to     = coalesce(s.assigned_to, v_loser.assigned_to),
    tags            = (select array(select distinct unnest(s.tags || coalesce(v_loser.tags, '{}')))),
    -- O rastro da fusão fica no cadastro, não só no log de quem rodou. O
    -- telefone do descartado é a informação que mais importa aqui: é o
    -- número que o cliente digitou no gateway, e é por ele que a próxima
    -- venda vai chegar errada de novo.
    description     = coalesce(s.description || E'\n', '')
      || 'Unificado com o cadastro "' || coalesce(v_loser.name, 'sem nome') || '"'
      || coalesce(' (' || nullif(btrim(coalesce(v_loser.phone, '')), '') || ')', '')
      || ' em ' || to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI')
  where s.id = p_survivor;

  -- Relê com tudo o que subiu: é desta linha que saem o payload e a decisão
  -- de anúncio dos passos 6 e 7.
  select * into v_surv from public.crm_contacts where id = p_survivor;

  -- ---------- 5. A ETAPA DE CONVERSÃO ----------
  -- Sem isto o sobrevivente ficaria com venda registrada e sem ter passado
  -- pela conversão — e crm_has_converted (016) olha o HISTÓRICO, não a
  -- venda. O funil mostraria um cliente que comprou sem nunca ter convertido.
  --
  -- É a mesma coisa que crm_sales_sync_contact (072) faz na primeira venda,
  -- e só vale no mesmo caso: o sobrevivente não tinha venda e passou a ter.
  --
  -- Nenhuma das duas triggers de etapa duplica nada aqui, porque as vendas
  -- já foram movidas: crm_sale_from_stage (040) declina em "já tem venda", e
  -- crm_track_stage_change (072) declina na trava 2 pelo mesmo motivo. O que
  -- fica é a linha no histórico, que é justamente o que faltava.
  if not v_tinha_venda and v_sales > 0 then
    select st.id into v_stage
    from public.crm_stages st
    where st.organization_id = v_org and st.is_conversion
    limit 1;

    if v_stage is not null and v_surv.stage_id is distinct from v_stage then
      update public.crm_contacts set stage_id = v_stage where id = p_survivor;
    end if;
  end if;

  -- ---------- 6. O PAYLOAD DO QUE AINDA NÃO SAIU ----------
  -- O payload é uma FOTOGRAFIA do contato no momento em que o evento foi
  -- enfileirado (072). Movido de dono e deixado como estava, o Purchase
  -- sairia com o telefone e o e-mail de quem não é mais o cliente — hasheados,
  -- então do lado da Meta ele simplesmente não casaria com ninguém.
  --
  -- Só os eventos QUE VIERAM DO DESCARTADO. Os que já eram do sobrevivente
  -- ficam intocados: eles já falam dele, e reescrever payload alheio é
  -- efeito colateral que ninguém pediu.
  --
  -- value_cents, sale_id e source não entram na reescrita: os dois primeiros
  -- são da venda (que não mudou) e o terceiro é de onde o evento nasceu.
  if array_length(v_eventos, 1) > 0 then
    if public.crm_is_ad_contact(v_surv.ctwaclid, v_surv.fbc, v_surv.campaign_id, v_surv.origem) then
      v_ad_source := case
        when coalesce(v_surv.ctwaclid, '') <> '' then 'ctwa'
        when coalesce(v_surv.fbc, '') <> ''      then 'site'
        else 'origem'
      end;

      update public.crm_events e
      set payload = e.payload || jsonb_build_object(
        'email',       v_surv.email,
        'phone',       v_surv.phone,
        'name',        v_surv.name,
        'ctwaclid',    v_surv.ctwaclid,
        'fbc',         v_surv.fbc,
        'fbp',         v_surv.fbp,
        'client_ip',   v_surv.client_ip,
        'user_agent',  v_surv.user_agent,
        'landing_url', v_surv.landing_url,
        'origem',      v_surv.origem,
        'ad_source',   v_ad_source
      )
      where e.id = any(v_eventos)
        and e.event_type = 'conversion'
        and e.status = 'pending';

      -- A DATA, para quem foi enfileirado antes desta migration.
      --
      -- Esses eventos não têm `sold_at` no payload e sairiam com o
      -- event_time do dia em que foram enfileirados. Enquanto ficaram
      -- parados isso era teórico; agora que mudaram de dono e podem sair no
      -- próximo ciclo, a data errada viraria uma compra no dia errado do
      -- Gerenciador. Só os que representam uma venda: o evento de etapa
      -- (sale_id null) não tem data de venda para herdar.
      update public.crm_events e
      set payload = e.payload || jsonb_build_object('sold_at', s.sold_at)
      from public.crm_sales s
      where s.id = e.sale_id
        and e.id = any(v_eventos)
        and e.event_type = 'conversion'
        and e.status = 'pending';
    else
      -- O evento foi enfileirado quando o descartado qualificava como
      -- anúncio, e o cliente que ficou não qualifica. Mandar assim mesmo
      -- creditaria à Meta uma venda que o CRM não considera de anúncio.
      -- 'skipped' e não 'failed': não falhou nada, deixou de caber.
      update public.crm_events e
      set status = 'skipped',
          error  = 'Cadastros unificados: o cliente que ficou não veio de anúncio'
      where e.id = any(v_eventos)
        and e.event_type = 'conversion'
        and e.status = 'pending';
    end if;
  end if;

  -- ---------- 7. O QUE FALTA IR PARA A META ----------
  -- Uma por venda, pulando as que já têm evento — as travas da 072 fazem o
  -- resto. É aqui que a venda que nunca foi enviada (porque nasceu no
  -- cadastro sem clique) finalmente entra na fila.
  v_queued := public.crm_enqueue_pending_conversions(p_survivor, 'fusao');

  survivor_id         := p_survivor;
  survivor_name       := v_surv.name;
  sales_moved         := v_sales;
  events_moved        := v_events;
  events_already_sent := v_sent;
  conversions_queued  := v_queued;
  return next;
end;
$$;

comment on function public.crm_merge_contacts(uuid, uuid) is
  'Unifica dois cadastros do mesmo cliente escolhidos na tela: move vendas e '
  'eventos, funde os campos que faltam, apaga o descartado e enfileira para '
  'a Meta só o que ainda não foi enviado. Só admin.';

grant execute on function public.crm_merge_contacts(uuid, uuid) to authenticated;


-- ------------------------------------------------------------
-- A DATA DA VENDA VIAJA COM O EVENTO
--
-- A venda não muda de data em lugar nenhum desta migration: a transferência
-- acima grava só `contact_id`, e nem crm_sales_stamp nem a trigger de
-- sincronia encostam em `sold_at`. Nos relatórios, portanto, a venda continua
-- exatamente no dia em que aconteceu — inclusive para decidir qual é a
-- primeira venda do cliente, que é o desempate (sold_at, created_at, id).
--
-- O PROBLEMA ESTÁ DO OUTRO LADO
--
-- O worker carimba o event_time do Purchase com `crm_events.created_at`, o
-- instante do ENFILEIRAMENTO. Para a venda registrada na hora os dois
-- coincidem e ninguém nunca percebeu. Para a venda que só agora encontrou o
-- cadastro certo, não: uma compra de três dias atrás entraria no Gerenciador
-- com a data de hoje — o mesmo tipo de descolamento que faz o relatório
-- parecer errado quando comparado com a Meta.
--
-- Por isso o payload passa a carregar `sold_at`. Quem decide usar é o worker,
-- e ele só usa dentro da janela de 7 dias da Conversions API: passando disso
-- a data real não é opção, o evento voltaria com erro permanente e a venda
-- não chegaria de jeito nenhum. Aí vale o instante do enfileiramento, que é o
-- comportamento de sempre.
--
-- ADITIVO NAS DUAS DIREÇÕES: worker velho ignora o campo novo; worker novo
-- não acha `sold_at` em evento antigo e cai no `created_at`. Mesma
-- propriedade do `order_id` da 072 — a ordem do deploy não importa.
--
-- Corpo idêntico ao da 072: muda a declaração de uma variável, o select que
-- lê a venda, o payload da adoção (trava 3) e uma linha no payload novo.
-- ------------------------------------------------------------
create or replace function public.crm_enqueue_conversion(
  p_contact uuid, p_source text, p_sale uuid
)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  c public.crm_contacts;
  v_ad_source text;
  v_value bigint;
  v_orfao uuid;
  -- Quando a compra aconteceu. Vai no payload para o worker carimbar o
  -- event_time com o dia do dinheiro, não com o dia do enfileiramento (077).
  v_sold_at timestamptz;
begin
  select * into c from public.crm_contacts where id = p_contact;
  if not found then
    return false;
  end if;

  -- Não veio de anúncio: converteu, entra nos relatórios, não vai à Meta.
  if not public.crm_is_ad_contact(c.ctwaclid, c.fbc, c.campaign_id, c.origem) then
    return false;
  end if;

  -- 'ctwa'   = clique de Click-to-WhatsApp (business_messaging + page_id);
  -- 'site'   = clique no anúncio que caiu na landing (website + fbc);
  -- 'origem' = anúncio declarado no cadastro, sem clique (system_generated).
  if coalesce(c.ctwaclid, '') <> '' then
    v_ad_source := 'ctwa';
  elsif coalesce(c.fbc, '') <> '' then
    v_ad_source := 'site';
  else
    v_ad_source := 'origem';
  end if;

  if p_sale is not null then
    select s.value_cents, s.sold_at into v_value, v_sold_at
    from public.crm_sales s where s.id = p_sale;
    if not found then
      return false;
    end if;

    -- Trava 1: uma conversão por venda. 'skipped' não conta — é evento que
    -- o worker encerrou sem enviar nada (ou venda que foi excluída antes de
    -- sair), então não representa compra registrada na Meta.
    if exists (
      select 1 from public.crm_events
      where sale_id = p_sale
        and event_type = 'conversion'
        and status::text <> 'skipped'
    ) then
      return false;
    end if;

    -- Trava 3: conversão que entrou pela ETAPA antes de existir venda. Não
    -- é uma compra a mais: é esta mesma, registrada depois. O evento é
    -- adotado pela venda em vez de virar um segundo Purchase.
    select id into v_orfao
    from public.crm_events
    where contact_id = p_contact
      and event_type = 'conversion'
      and sale_id is null
      and status::text <> 'skipped'
    order by created_at
    limit 1;

    if v_orfao is not null then
      update public.crm_events e
      set sale_id = p_sale,
          -- Pendente ainda acerta o valor e ganha o order_id. Enviado fica
          -- como está: a Conversions API não corrige evento (042).
          payload = case when e.status = 'pending'
            then e.payload || jsonb_build_object(
              'value_cents', v_value, 'sale_id', p_sale, 'sold_at', v_sold_at)
            else e.payload
          end
      where e.id = v_orfao;
      return false;
    end if;
  else
    -- Trava 2: existindo venda registrada, quem manda são as vendas. A
    -- etapa não enfileira nada — nem na primeira vez, nem na reentrada.
    if exists (select 1 from public.crm_sales where contact_id = p_contact) then
      return false;
    end if;

    -- Sem venda: uma conversão por contato, como era antes da 072.
    if exists (
      select 1 from public.crm_events
      where contact_id = p_contact
        and event_type = 'conversion'
        and status::text <> 'skipped'
    ) then
      return false;
    end if;

    v_value := c.value_cents;
  end if;

  insert into public.crm_events (
    organization_id, contact_id, sale_id, event_type, payload
  )
  values (
    c.organization_id,
    c.id,
    p_sale,
    'conversion',
    jsonb_build_object(
      'value_cents', v_value,
      'email', c.email,
      'phone', c.phone,
      'name', c.name,
      'ctwaclid', c.ctwaclid,
      -- Bloco do funil de site (071).
      'fbc', c.fbc,
      'fbp', c.fbp,
      'client_ip', c.client_ip,
      'user_agent', c.user_agent,
      'landing_url', c.landing_url,
      'origem', c.origem,
      -- Vira order_id no custom_data: segunda chave de deduplicação do lado
      -- da Meta, que passa a importar agora que um cliente manda vários
      -- Purchase.
      'sale_id', p_sale,
      -- Data da VENDA, não do enfileiramento. É ela que o worker usa como
      -- event_time quando cabe na janela de 7 dias da Meta (077).
      'sold_at', v_sold_at,
      -- Lido pelo worker para escolher action_source. Sem ele o evento é
      -- tratado como fila antiga e descartado (skipped).
      'ad_source', v_ad_source,
      'source', p_source
    )
  );

  return true;
end;
$$;

comment on function public.crm_enqueue_conversion(uuid, text, uuid) is
  'Enfileira a conversão de UMA venda (ou da etapa, com p_sale null) se o '
  'contato vier de anúncio e aquela venda ainda não tiver evento. O payload '
  'leva a data da venda para o event_time (077).';

-- ------------------------------------------------------------
-- CORRIGIU A DATA DA VENDA ANTES DE ELA SAIR? O EVENTO ACOMPANHA.
--
-- Mesma ideia do acerto de valor que a 042 fez e a 072 manteve: enquanto o
-- evento está na fila, ele ainda pode ser corrigido; depois de enviado não
-- há o que fazer, porque a Conversions API não corrige evento.
--
-- Trigger nova em vez de mais uma linha dentro de crm_sales_sync_contact:
-- aquela função é o coração das vendas e recriá-la inteira para acrescentar
-- um campo é risco de transcrição sem contrapartida. Esta só acorda quando
-- `sold_at` muda, que é o único caso que lhe interessa.
-- ------------------------------------------------------------
create or replace function public.crm_sales_sync_event_date()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.crm_events e
  set payload = e.payload || jsonb_build_object('sold_at', new.sold_at)
  where e.sale_id = new.id
    and e.event_type = 'conversion'
    and e.status = 'pending';

  return null;
end;
$$;

comment on function public.crm_sales_sync_event_date() is
  'Corrigir a data de uma venda corrige o event_time do Purchase que ainda '
  'não saiu da fila.';

drop trigger if exists crm_sales_event_date on public.crm_sales;
create trigger crm_sales_event_date
  after update of sold_at on public.crm_sales
  for each row
  when (old.sold_at is distinct from new.sold_at)
  execute function public.crm_sales_sync_event_date();
