-- ============================================================
-- Venda nova volta a ir para a Meta; unificação para de mandar R$ 0;
-- editar e mover venda voltam a funcionar
--
-- 1. REGRESSÃO DA 089. Ela reescreveu crm_sales_sync_contact() partindo da
--    versão da 031 ("Mesma trigger da 031") e apagou tudo o que a 042 e a
--    072 tinham posto nela:
--
--      • INSERT enfileirar o Purchase da venda (072). Sem isso NENHUMA venda
--        lançada desde a 089 virou evento: a entrada na etapa de conversão
--        até chama a crm_enqueue_conversion, mas a trava 2 recusa quem já
--        tem venda — e não sobra outro caminho;
--      • DELETE cancelar ('skipped') o evento que ainda não saiu (072);
--      • UPDATE levar o valor corrigido ao evento pendente da venda (042);
--      • o evento da ETAPA (sale_id null) pendente acompanhar o valor da
--        primeira venda (042).
--
--    Visto em 11/09/2026: as vendas de 10/09 não tinham linha em
--    crm_events, e pg_get_functiondef da trigger não citava
--    crm_enqueue_conversion. O corpo abaixo é o da 089 (os dois contatos
--    quando a venda troca de dono) com o bloco de eventos da 072 de volta.
--
--    ANTES DE REDEFINIR UMA FUNÇÃO AQUI, parta da ÚLTIMA versão dela:
--      grep -ln "function public.<nome>(" supabase/migrations/*.sql
--    create or replace troca o corpo inteiro, e nada avisa o que sumiu.
--
-- 2. UNIFICAÇÃO SEM VENDA MANDAVA R$ 0 (077). O passo 7 chamava
--    crm_enqueue_pending_conversions, que para cadastro sem venda cai no
--    caminho da etapa e enfileira um Purchase com o value_cents do contato.
--    Cadastro na etapa de conversão sem venda tem valor 0 — com valor, a
--    040 já teria criado a venda —, então esse Purchase era sempre de R$ 0.
--    Pior: a venda lançada depois ADOTA esse evento já enviado (trava 3), e
--    o valor de verdade nunca sai. Foi o que aconteceu em 10/09: venda
--    excluída, cadastros unificados às 18:28, R$ 0 enviado às 18:30, venda
--    relançada às 18:31. O passo 7 já dizia "uma por venda"; agora faz só
--    isso.
--
-- 3. A 088 NÃO DEIXAVA EDITAR VENDA. crm_sale_update_webhook monta a lista
--    do que mudou com `v_changed || 'value_cents'`. Com o literal sem tipo,
--    o Postgres resolve o || como array com array e tenta ler 'value_cents'
--    como array: "malformed array literal". Como é trigger AFTER UPDATE, o
--    erro desfaz o update inteiro — mudar valor, data ou forma de pagamento
--    de uma venda falha, e mover venda de canal (089) também. O corpo abaixo
--    é o da 088 com `::text` nos cinco literais; nada mais muda.
--
-- 4. O QUE FICOU PARA TRÁS. Toda venda lançada desde 10/09 que ainda não
--    tem evento entra na fila agora, com a data dela. É o mesmo backfill
--    rodado à mão em 11/09 — rodar de novo não duplica nada.
--
-- Para conferir depois de aplicar (tem de dar true):
--   select pg_get_functiondef('public.crm_sales_sync_contact'::regproc)
--          like '%crm_enqueue_conversion%';
--
-- ORDEM DE DEPLOY: só esta migration; nada muda no frontend nem no worker.
-- Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

-- ------------------------------------------------------------
-- 1. SINCRONIA DAS VENDAS — 089 + eventos da 072
-- ------------------------------------------------------------
create or replace function public.crm_sales_sync_contact()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact uuid;
  v_antigo  uuid;
  v_count   int;
  v_stage   uuid;
begin
  -- Em DELETE o registro NEW não existe: nunca o referencie aqui.
  if tg_op = 'DELETE' then
    v_contact := old.contact_id;
  else
    v_contact := new.contact_id;
  end if;

  -- O cadastro que PERDEU a venda, quando ela mudou de dono (089).
  if tg_op = 'UPDATE' and old.contact_id is distinct from new.contact_id then
    v_antigo := old.contact_id;
  end if;

  perform public.crm_recalc_contact_totals(v_contact);
  perform public.crm_recalc_contact_totals(v_antigo);

  -- Primeira venda do cliente: leva o contato para a etapa de conversão.
  -- Só no INSERT que criou a 1ª linha. Recompra, edição, exclusão e
  -- movimento não mexem na etapa — quem já converteu, converteu, e a venda
  -- que chega por movimento é a mesma compra noutro lugar (089).
  if tg_op = 'INSERT' then
    select count(*) into v_count
    from public.crm_sales where contact_id = v_contact;

    if v_count = 1 then
      select s.id into v_stage
      from public.crm_stages s
      where s.organization_id = new.organization_id and s.is_conversion;

      if v_stage is not null then
        update public.crm_contacts set stage_id = v_stage where id = v_contact;
      end if;
    end if;
  end if;

  -- Correção de valor acompanha o evento DAQUELA venda (042/072). Depois
  -- de enviado não há o que fazer — a Conversions API não corrige evento.
  if tg_op = 'UPDATE' then
    update public.crm_events e
    set payload = jsonb_set(e.payload, '{value_cents}', to_jsonb(new.value_cents))
    where e.sale_id = new.id
      and e.event_type = 'conversion'
      and e.status = 'pending';
  end if;

  -- Evento da ETAPA, sem venda vinculada: o valor dele é o da primeira
  -- venda do contato (042). crm_recalc_contact_totals já gravou esse valor
  -- no cadastro — 0 quando não sobrou venda. Os dois contatos quando a
  -- venda troca de dono: o que perdeu pode ter ficado com outra primeira.
  update public.crm_events e
  set payload = jsonb_set(e.payload, '{value_cents}', to_jsonb(c.value_cents))
  from public.crm_contacts c
  where c.id in (v_contact, v_antigo)
    and e.contact_id = c.id
    and e.sale_id is null
    and e.event_type = 'conversion'
    and e.status = 'pending';

  -- Venda excluída antes do envio: o Purchase perde o que representava, e
  -- mandá-lo assim mesmo criaria receita que não existe. 'skipped' porque
  -- 'failed' seria mentira — não falhou nada, foi cancelado (072).
  if tg_op = 'DELETE' then
    update public.crm_events e
    set status = 'skipped',
        error = 'Venda excluída antes de o evento ser enviado'
    where e.sale_id = old.id
      and e.event_type = 'conversion'
      and e.status = 'pending';
  end if;

  -- Venda nova de cliente de anúncio: cada uma tem seu Purchase (072).
  --
  -- Depois da promoção de etapa de propósito. Aquele update já disparou a
  -- trigger de etapa, que viu o contato com venda e declinou (trava 2) —
  -- então o único caminho para a conversão desta venda é este, e ele
  -- conhece o valor certo: o dela. Movimento (UPDATE de contact_id) não
  -- entra aqui: quem refaz a conversão no dono novo é a própria
  -- crm_move_sales_to_channel (089) ou a fusão (077).
  if tg_op = 'INSERT' then
    perform public.crm_enqueue_conversion(
      v_contact,
      case when auth.uid() is null then 'api' else 'ui' end,
      new.id
    );
  end if;

  return null;
end;
$$;

comment on function public.crm_sales_sync_contact() is
  'Mantém os totais dos contatos a partir das vendas (os dois quando a venda '
  'muda de dono), move o contato na 1ª venda, enfileira a conversão de CADA '
  'venda de cliente de anúncio e acerta — ou cancela — o evento que ainda '
  'não saiu da fila.';

-- ------------------------------------------------------------
-- 2. UNIFICAÇÃO — 077 com o passo 7 só por venda
--
-- Corpo idêntico ao da 077 (única versão até aqui) fora o passo 7 e a
-- variável que ele usa.
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
  v_sale      record;
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
  --
  -- SEM VENDA, NADA (090). A crm_enqueue_pending_conversions que estava
  -- aqui cai no caminho da etapa quando não há venda, e manda o value_cents
  -- do cadastro — que na etapa de conversão sem venda é sempre 0 (com
  -- valor, a 040 já teria criado a venda). A venda lançada depois adotava
  -- esse Purchase de R$ 0 já entregue, e o valor dela nunca saía.
  for v_sale in
    select s.id from public.crm_sales s
    where s.contact_id = p_survivor
    order by s.sold_at, s.created_at, s.id
  loop
    if public.crm_enqueue_conversion(p_survivor, 'fusao', v_sale.id) then
      v_queued := v_queued + 1;
    end if;
  end loop;

  survivor_id         := p_survivor;
  survivor_name       := v_surv.name;
  sales_moved         := v_sales;
  events_moved        := v_events;
  events_already_sent := v_sent;
  conversions_queued  := v_queued;
  return next;
end;
$$;


-- ------------------------------------------------------------
-- 3. WEBHOOK DE VENDA ALTERADA — 088 com o tipo nos literais
--
-- Corpo idêntico ao da 088 (única versão até aqui) fora os cinco `::text`.
-- ------------------------------------------------------------
create or replace function public.crm_sale_update_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed text[] := '{}';
  v_moved   boolean := new.contact_id is distinct from old.contact_id;
  v_antes   public.crm_contacts;
  v_depois  public.crm_contacts;
begin
  if new.value_cents is distinct from old.value_cents then
    v_changed := v_changed || 'value_cents'::text;
  end if;
  if new.payment_method is distinct from old.payment_method then
    v_changed := v_changed || 'payment_method'::text;
  end if;
  if new.sold_at is distinct from old.sold_at then
    v_changed := v_changed || 'sold_at'::text;
  end if;

  select * into v_depois from public.crm_contacts where id = new.contact_id;

  if v_moved then
    select * into v_antes from public.crm_contacts where id = old.contact_id;
    -- crm_channel_key (069): compara sem caixa e sem espaço nas pontas, a
    -- mesma chave do índice único. "PH" e "ph " são o mesmo dono.
    if public.crm_channel_key(v_antes.channel)
       is distinct from public.crm_channel_key(v_depois.channel) then
      v_changed := v_changed || 'channel'::text;
    end if;
  else
    v_antes := v_depois;
  end if;

  -- Nada que interesse mudou. Sai calado.
  if array_length(v_changed, 1) is null then
    return null;
  end if;

  -- A venda trocou de cadastro E há motivo para avisar: registra o
  -- movimento, mesmo quando o canal é o mesmo.
  if v_moved then
    v_changed := v_changed || 'contact_id'::text;
  end if;

  perform public.crm_sale_updated_notify(old, new, v_antes, v_depois, v_changed);
  return null;
end;
$$;


-- ------------------------------------------------------------
-- 4. O QUE FICOU PARA TRÁS DESDE A 089
--
-- Toda venda lançada desde 10/09 sem evento na fila. A crm_enqueue_conversion
-- decide o resto: cliente que não veio de anúncio fica de fora, e cada venda
-- ganha no máximo um evento.
--
-- O EVENTO DA ETAPA QUE JÁ SAIU COM R$ 0 (o caso do item 2). Pela trava 3 a
-- venda o adotaria e nada sairia. Ele fica escondido da adoção enquanto a
-- venda entra na fila, e depois é ligado a ela — solto, engoliria a PRÓXIMA
-- compra do cliente do mesmo jeito. A Meta passa a ter dois Purchase para
-- essa venda (R$ 0 + o valor dela): a contagem sobra um, a receita fica
-- certa. Evento da etapa com valor (card arrastado para a conversão) não
-- entra aqui: aquele é a mesma compra, e a adoção está certa.
-- ------------------------------------------------------------
do $$
declare
  r record;
  v_orfao uuid;
  v_entrou boolean;
begin
  for r in
    select s.id, s.contact_id
    from public.crm_sales s
    where s.created_at >= '2026-09-10 00:00:00-03'
      and not exists (
        select 1 from public.crm_events e
        where e.sale_id = s.id
          and e.event_type = 'conversion'
          and e.status::text <> 'skipped'
      )
    order by s.sold_at, s.created_at, s.id
  loop
    v_orfao := null;

    select e.id into v_orfao
    from public.crm_events e
    where e.contact_id = r.contact_id
      and e.event_type = 'conversion'
      and e.sale_id is null
      and e.status::text in ('sent', 'failed')
      and coalesce((e.payload->>'value_cents')::numeric, 0) = 0
    order by e.created_at
    limit 1;

    if v_orfao is not null then
      update public.crm_events set sale_id = gen_random_uuid()
      where id = v_orfao;
    end if;

    v_entrou := public.crm_enqueue_conversion(r.contact_id, 'backfill', r.id);

    if v_orfao is not null then
      update public.crm_events
      set sale_id = case when v_entrou then r.id end
      where id = v_orfao;
    end if;
  end loop;
end $$;
