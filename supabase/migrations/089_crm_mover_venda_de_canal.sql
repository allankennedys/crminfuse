-- ============================================================
-- Mover vendas escolhidas para outro canal
--
-- O caso: cliente que comprou pelos dois WhatsApps, com as duas vendas
-- caídas no mesmo cadastro. Trocar o canal do contato (a tela de hoje) leva
-- TODAS as vendas junto — certo quando de fato todas mudaram de dono, errado
-- quando só uma comprou pelo outro número.
--
-- O CANAL NÃO MORA NA VENDA, E NÃO VAI PASSAR A MORAR
--
-- A regra da 080 é um cadastro por (número, canal), e o dono da venda é o
-- canal do cadastro dela. Então "mover a venda de canal" é mover a venda
-- para o CADASTRO daquele canal — criado na hora pela crm_contact_for_channel
-- se ainda não existir, levando identidade e dados de anúncio junto. O
-- cadastro de origem fica onde está, com as vendas que sobraram.
--
-- Pôr um `channel` em crm_sales seria a outra saída, e é a errada: passariam
-- a existir duas verdades sobre o mesmo fato (o canal da venda e o do
-- cadastro dela), e todo relatório por canal teria de escolher uma. O
-- histórico de leads, conversas e etapas continuaria preso ao cadastro.
--
-- O AVISO AO n8n SAI SOZINHO
--
-- Mover é um update de crm_sales.contact_id, e a trigger da 088 já dispara
-- nele quando o canal do cadastro de destino difere do de origem — com o
-- estado antes e depois. Não há POST nenhum escrito aqui.
--
-- O ANÚNCIO ACOMPANHA AS VENDAS
--
-- Destino criado agora já nasce com ctwa_clid e o bloco do site, porque a
-- crm_contact_for_channel (080) copia na duplicação. O buraco é o destino
-- que JÁ EXISTIA, aberto pela automação numa conversa orgânica: ele está
-- pelado, e a venda que acaba de chegar nele sairia órfã de atribuição —
-- não viraria Purchase atribuído na Meta e não entraria na receita por
-- campanha. O anúncio pagou por essa venda e o relatório nunca saberia. É o
-- mesmo prejuízo que a 081 conserta, aqui no movimento manual.
--
-- O QUE JÁ FOI PARA A META NÃO VOLTA — O QUE NÃO FOI, RECOMEÇA
--
-- O evento de conversão (072) acompanha a venda, trocando de contact_id como
-- na fusão (077). O que acontece com ele depois depende do status:
--
--   • 'sent'  → intocado. O Purchase já está contabilizado lá e a Conversions
--               API não corrige evento enviado (042). Reenviar seria uma
--               segunda compra do mesmo dinheiro.
--   • qualquer outro (pending, failed, skipped, ou evento nenhum)
--             → a conversão AINDA NÃO SAIU, e agora ela pertence a outro
--               cadastro. Se o dono novo tem dados de anúncio, ela é refeita
--               com os dados DELE e volta para a fila.
--
-- POR QUE REFAZER E NÃO SÓ REAPONTAR: o payload do evento é uma fotografia
-- tirada no enfileiramento — ctwa_clid, fbc, telefone, e-mail, nome. Trocar
-- só o contact_id deixaria o worker mandando à Meta a identidade do cadastro
-- ANTIGO com a venda do novo. A atribuição sairia errada com toda a
-- aparência de estar certa.
--
-- O caso que isto principalmente conserta: venda lançada num cadastro sem
-- anúncio (evento 'skipped', ou nenhum), movida para o cadastro do outro
-- canal que TEM o clique. Antes ela ficava skipped para sempre e a Meta
-- nunca sabia da compra que o anúncio pagou.
--
-- ORDEM DE DEPLOY: 088 → esta → frontend. Aplicar pelo SQL Editor. Nunca por
-- db push.
-- ============================================================

-- ------------------------------------------------------------
-- 1. TOTAIS DO CONTATO — a correção que o movimento exige
--
-- A crm_sales_sync_contact (031) recalcula só o contato de NEW. Isso bastava
-- enquanto venda nunca trocava de cadastro fora de uma fusão, onde o de
-- origem é apagado logo em seguida e totais velhos nele não importam.
--
-- Aqui o cadastro de origem SOBREVIVE, com as vendas que ficaram. Sem esta
-- correção ele guardaria para sempre o sales_count e o sales_total_cents de
-- antes do movimento — errado no drawer, no relatório e no corpo dos
-- webhooks, e sem nada na tela denunciando.
--
-- A conta sai para uma função própria porque agora ela roda para dois
-- contatos no mesmo disparo. A promoção de etapa NÃO vem junto: ela é do
-- INSERT da primeira venda e só faz sentido para o contato que a recebeu.
-- ------------------------------------------------------------
create or replace function public.crm_recalc_contact_totals(p_contact uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
  v_total bigint;
  v_first bigint;
begin
  if p_contact is null then
    return;
  end if;

  select count(*), coalesce(sum(value_cents), 0)
    into v_count, v_total
  from public.crm_sales where contact_id = p_contact;

  -- Valor do contato = valor da primeira venda, na ordem canônica. Sem
  -- venda nenhuma, zera.
  select value_cents into v_first
  from public.crm_sales
  where contact_id = p_contact
  order by sold_at, created_at, id
  limit 1;

  update public.crm_contacts c set
    sales_count = v_count,
    sales_total_cents = v_total,
    value_cents = coalesce(v_first, 0)
  where c.id = p_contact;
end;
$$;

comment on function public.crm_recalc_contact_totals(uuid) is
  'Recalcula sales_count, sales_total_cents e value_cents de um contato a '
  'partir das vendas dele. Não mexe em etapa — isso é da trigger.';

revoke all on function public.crm_recalc_contact_totals(uuid) from public;

-- Mesma trigger da 031, agora cuidando dos DOIS contatos quando a venda
-- muda de dono. O comportamento de insert, edição simples e exclusão fica
-- idêntico: nesses casos old.contact_id e new.contact_id são o mesmo (ou um
-- deles não existe), e a segunda chamada não acontece.
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

  -- O cadastro que PERDEU a venda, quando ela mudou de dono.
  if tg_op = 'UPDATE' and old.contact_id is distinct from new.contact_id then
    v_antigo := old.contact_id;
  end if;

  perform public.crm_recalc_contact_totals(v_contact);
  perform public.crm_recalc_contact_totals(v_antigo);

  -- Primeira venda do cliente: leva o contato para a etapa de conversão. O
  -- trigger crm_contacts_stage_change cuida do histórico e do evento na
  -- Meta (e a 028 garante um evento por contato, nunca dois).
  --
  -- Só no INSERT que criou a 1ª linha. Recompra não mexe na etapa, editar e
  -- excluir venda também não — quem já converteu, converteu. E MOVER
  -- tampouco: a venda que chega num cadastro por movimento não é uma compra
  -- nova, é a mesma compra noutro lugar.
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

  return null;
end;
$$;

-- ------------------------------------------------------------
-- 1b. A PORTA NA TRAVA DE TRANSFERÊNCIA
--
-- crm_sales_stamp (031, revista na 077) proíbe trocar a venda de contato, e
-- a justificativa escrita lá é textual: "a trigger de sincronia só recalcula
-- um contato por linha", então um UPDATE solto deixaria o contato de origem
-- com sales_count de uma venda que não é mais dele.
--
-- ESSA JUSTIFICATIVA ACABOU DE CAIR — para este caminho. O bloco 1 acima faz
-- a sincronia recalcular OS DOIS contatos, então a transferência não deixa
-- mais contador órfão. A 077 atravessa por outro motivo (apaga a origem na
-- mesma transação); aqui a origem sobrevive e fica certa.
--
-- Mesmo assim a trava CONTINUA, e a porta é uma segunda variável de sessão,
-- própria, em vez de reaproveitar a da fusão. Duas razões: 'crm.merging_
-- contacts' significa "há um cadastro sendo apagado agora", e emprestá-la
-- mentiria para quem ler o código depois; e a trava segue valendo para todo
-- o resto — painel, crm-api, n8n, SQL solto —, onde um contact_id trocado à
-- mão continua sendo engano, não operação.
--
-- set_config com is_local => true: vale até o fim da transação e some
-- sozinha, como na 077.
-- ------------------------------------------------------------
create or replace function public.crm_sales_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  -- Trocar o contato de uma venda à mão continua sendo engano: exclua a
  -- venda e lance no contato certo. As duas exceções são operações que
  -- sabem o que estão fazendo — a fusão de cadastros (077), que apaga a
  -- origem na mesma transação, e o movimento entre canais (089), que
  -- recalcula os dois lados.
  if tg_op = 'UPDATE'
     and new.contact_id is distinct from old.contact_id
     and coalesce(current_setting('crm.merging_contacts', true), '') <> 'on'
     and coalesce(current_setting('crm.moving_sales', true), '') <> 'on'
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
  'Carimba org e autor da venda e impede transferi-la de contato. Duas '
  'portas: a fusão de cadastros (077), que apaga a origem na mesma '
  'transação, e o movimento entre canais (089), que recalcula os dois lados.';

-- ------------------------------------------------------------
-- 2. O MOVIMENTO
--
-- Recebe as vendas escolhidas e o canal de destino. Todas têm de ser do
-- MESMO cadastro: mover vendas de clientes diferentes numa chamada só
-- pareceria funcionar e escolheria um destino errado para alguém.
--
-- security definer com as duas checagens explícitas, como a 077: definer
-- passa por cima da RLS, então a permissão que a policy exigiria
-- (crm.vendas.editar, 055) é conferida aqui na mão. A criação do cadastro de
-- destino tem a checagem dela dentro da crm_contact_for_channel, que exige
-- crm.contatos.editar — quem só pode mexer em venda não cria cadastro novo,
-- e recebe o erro de lá.
-- ------------------------------------------------------------
create or replace function public.crm_move_sales_to_channel(
  p_sale_ids uuid[],
  p_channel  text
)
returns table(
  moved             int,
  events_moved      int,
  -- Conversões que voltaram para a fila com os dados do dono novo. Não conta
  -- as que já tinham sido enviadas — essas ficam como estão.
  conversions_queued int,
  target_contact_id uuid,
  target_created    boolean,
  target_matched_by text,
  -- true = o destino estava sem dados de anúncio e herdou os da origem.
  ads_inherited     boolean,
  source_contact_id uuid,
  -- Quantas vendas SOBRAM no cadastro de origem. Zero significa que ele
  -- ficou sem venda nenhuma — a tela avisa, porque nesse caso o certo
  -- costuma ser trocar o canal do contato inteiro.
  source_sales_left int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org      uuid;
  v_chan     text := nullif(btrim(coalesce(p_channel, '')), '');
  v_contacts uuid[];
  v_source   public.crm_contacts;
  v_target   uuid;
  v_created  boolean;
  v_matched  text;
  v_qtd      int;
  v_dest     public.crm_contacts;
  v_ads      boolean := false;
  v_sale_id  uuid;
  v_moved    int := 0;
  v_events   int := 0;
  v_queued   int := 0;
  v_left     int := 0;
begin
  -- Operação de painel. Automação não remaneja venda entre canais: decidir
  -- por qual WhatsApp o cliente comprou é julgamento humano.
  if auth.uid() is null then
    raise exception 'Mover venda de canal só é feito por um usuário autenticado';
  end if;

  if not public.current_user_can('crm.vendas.editar') then
    raise exception 'Você não tem permissão para editar vendas';
  end if;

  if p_sale_ids is null or array_length(p_sale_ids, 1) is null then
    raise exception 'Informe as vendas que vão mudar de canal';
  end if;

  if v_chan is null then
    raise exception 'Informe o canal de destino';
  end if;

  v_org := public.current_org_id();

  -- Trava as linhas antes de olhar para elas: duas pessoas movendo a mesma
  -- venda para canais diferentes ao mesmo tempo dariam dois destinos, e o
  -- segundo sobrescreveria o primeiro sem aviso. Aggregate não convive com
  -- FOR UPDATE, por isso a trava vem num passo separado da contagem.
  perform 1
  from public.crm_sales
  where id = any(p_sale_ids) and organization_id = v_org
  for update;

  select array_agg(distinct contact_id), count(*)::int
    into v_contacts, v_qtd
  from public.crm_sales
  where id = any(p_sale_ids) and organization_id = v_org;

  if v_qtd = 0 then
    raise exception 'Nenhuma das vendas informadas foi encontrada';
  end if;

  -- Some uma venda entre o clique e o salvamento (outra aba excluiu) e o
  -- movimento inteiro é recusado, em vez de mover a metade que restou.
  if v_qtd <> array_length(p_sale_ids, 1) then
    raise exception 'Alguma das vendas não existe mais ou é de outra organização';
  end if;

  if array_length(v_contacts, 1) <> 1 then
    raise exception 'As vendas são de cadastros diferentes: mova as de um cliente por vez';
  end if;

  select * into v_source from public.crm_contacts where id = v_contacts[1];

  if v_source.id is null then
    raise exception 'Cadastro de origem não encontrado';
  end if;

  -- crm_channel_key (069): "PH" e "ph " são o mesmo canal. Sem isto, salvar
  -- com o mesmo canal escrito diferente criaria um cadastro irmão inútil.
  if public.crm_channel_key(v_source.channel)
     is not distinct from public.crm_channel_key(v_chan) then
    raise exception 'As vendas já estão em %', coalesce(v_source.channel, 'canal em branco');
  end if;

  -- O cadastro daquele canal: o que já existe, o de canal em branco adotado,
  -- ou um novo duplicado deste — com identidade e dados de anúncio junto
  -- (080). Sem stage_id: quem leva à etapa de conversão é a trigger, e a
  -- venda que chega aqui não é compra nova.
  select f.contact_id, f.created, f.matched_by
    into v_target, v_created, v_matched
  from public.crm_contact_for_channel(
    v_org, v_source.phone, v_chan, v_source.name, null, v_source.origem
  ) f;

  if v_target is null then
    raise exception 'Não foi possível preparar o cadastro de %', v_chan;
  end if;

  if v_target = v_source.id then
    raise exception 'O cadastro de destino é o mesmo de origem';
  end if;

  -- ------------------------------------------------------------
  -- O ANÚNCIO DO CANAL ANTERIOR ACOMPANHA, quando o destino não tem o dele
  --
  -- Antes do movimento de propósito: assim o aviso ao n8n (088) já sai com o
  -- contato de destino atribuído, em vez de descrevê-lo pelado e corrigir
  -- depois.
  --
  -- POR QUE NÃO É crm_inherit_ads (081): aquela só age em cadastro com menos
  -- de 15 minutos de vida. A janela existe para impedir que um upsert
  -- automático dê anúncio a um contato orgânico de meses atrás — o relatório
  -- de ADS conta lead por created_at, e ele apareceria retroativamente numa
  -- janela já fechada e já lida. Este caminho é o oposto: manual, com dono, e
  -- a própria 081 aponta a operação humana (a fusão, 077) como a exceção
  -- legítima. Afrouxar a janela lá para atender aqui reabriria o caso que ela
  -- fecha.
  --
  -- SÓ QUANDO O DESTINO NÃO TEM NADA PRÓPRIO. crm_contact_has_ad_data (081)
  -- mede pelos seis campos que são sinal de anúncio — fbp, client_ip,
  -- user_agent e landing_url ficam de fora porque a landing os captura de
  -- todo visitante, inclusive do orgânico. Cadastro que já chegou com clique
  -- próprio fica intocado: o dele é mais verdadeiro que o herdado.
  --
  -- TUDO OU NADA, como na 073/077/080/081: os dez campos vão juntos, por
  -- cima de um fbp/client_ip que o destino tivesse. fbc de uma visita ao lado
  -- do campaign_id de outra atribui a venda à campanha errada com toda a
  -- aparência de estar certa.
  --
  -- `origem` NÃO viaja, pela razão da 081: ela classifica como ESTA conversa
  -- começou, e quem a escreveu foi a automação deste canal.
  -- ------------------------------------------------------------
  select * into v_dest from public.crm_contacts where id = v_target;

  if public.crm_contact_has_ad_data(v_source)
     and not public.crm_contact_has_ad_data(v_dest) then
    update public.crm_contacts set
      ctwaclid    = v_source.ctwaclid,
      source_id   = v_source.source_id,
      fbc         = v_source.fbc,
      fbp         = v_source.fbp,
      client_ip   = v_source.client_ip,
      user_agent  = v_source.user_agent,
      landing_url = v_source.landing_url,
      campaign_id = v_source.campaign_id,
      adset_id    = v_source.adset_id,
      ad_id       = v_source.ad_id,
      -- Marca a procedência, como a 081 faz: é o que permite a
      -- crm_contact_drop_inherited_ads devolver o cadastro ao estado
      -- pelado se o clique de verdade deste canal chegar depois.
      ads_inherited_from = v_source.id
    where id = v_target;
    v_ads := true;
  end if;

  -- Abre a porta da crm_sales_stamp (bloco 1b) só para este update, e fecha
  -- logo depois: nada mais na transação transfere venda.
  perform set_config('crm.moving_sales', 'on', true);

  -- É ESTE update que avisa o n8n, uma vez por venda, pela trigger da 088.
  update public.crm_sales set contact_id = v_target
  where id = any(p_sale_ids);
  get diagnostics v_moved = row_count;

  perform set_config('crm.moving_sales', 'off', true);

  -- O evento de conversão acompanha a venda, como na fusão (077).
  update public.crm_events set contact_id = v_target
  where sale_id = any(p_sale_ids) and event_type = 'conversion';
  get diagnostics v_events = row_count;

  -- ------------------------------------------------------------
  -- A CONVERSÃO QUE AINDA NÃO SAIU RECOMEÇA NO DONO NOVO
  --
  -- Só faz sentido se o cadastro de destino for de anúncio. Ele pode ser por
  -- dado próprio, pelo que acabou de herdar da origem, ou pela `origem`
  -- declarada — que NÃO viaja na herança (081) e por isso precisa ser
  -- perguntada aqui, e não deduzida de crm_contact_has_ad_data.
  --
  -- SEM ISSO, NÃO SE MEXE EM NADA. Marcar o evento como refeito e depois
  -- descobrir que o destino não pode enviar deixaria a conversão skipped sem
  -- ninguém para reenfileirá-la — perder o que estava na fila é pior do que
  -- deixá-la apontando para o cadastro novo com o payload antigo.
  -- ------------------------------------------------------------
  if public.crm_is_ad_contact(
       v_dest.ctwaclid, v_dest.fbc, v_dest.campaign_id, v_dest.origem
     ) or v_ads then
    -- Trava as linhas antes de mexer: o worker roda de 30 em 30 minutos e
    -- pode estar com uma delas em mãos agora. Aggregate não convive com FOR
    -- UPDATE, por isso a trava vem sozinha.
    perform 1
    from public.crm_events
    where sale_id = any(p_sale_ids)
      and event_type = 'conversion'
      and status::text <> 'sent'
    for update;

    -- 'skipped' é o encerramento sem envio que o projeto já usa (033), e é
    -- justamente o status que a trava 1 da crm_enqueue_conversion (077)
    -- ignora — é ele que libera o reenfileiramento logo abaixo. Nada é
    -- apagado: o rastro do que foi tentado no cadastro antigo continua lá.
    update public.crm_events
       set status = 'skipped',
           error  = 'Venda mudou de canal: conversão refeita no cadastro de destino'
     where sale_id = any(p_sale_ids)
       and event_type = 'conversion'
       and status::text <> 'sent';

    -- Uma por venda, com os dados do dono novo. A própria função recusa a
    -- venda que já tem evento 'sent' (trava 1) — o dinheiro que já chegou à
    -- Meta não é enfileirado de novo.
    foreach v_sale_id in array p_sale_ids loop
      if public.crm_enqueue_conversion(v_target, 'canal', v_sale_id) then
        v_queued := v_queued + 1;
      end if;
    end loop;
  end if;

  select count(*)::int into v_left
  from public.crm_sales where contact_id = v_source.id;

  return query select
    v_moved, v_events, v_queued, v_target, v_created, v_matched, v_ads,
    v_source.id, v_left;
end;
$$;

comment on function public.crm_move_sales_to_channel(uuid[], text) is
  'Move as vendas escolhidas para o cadastro do número naquele canal, '
  'criando-o se preciso (080). O cadastro de origem fica com as que '
  'sobraram. Os dados de anúncio da origem acompanham quando o destino não '
  'tem os dele, e a conversão que ainda não foi enviada é refeita com os '
  'dados do dono novo; a que já saiu fica intocada. O aviso ao n8n sai pela '
  'trigger de venda alterada (088).';

revoke all on function public.crm_move_sales_to_channel(uuid[], text) from public;
grant execute on function public.crm_move_sales_to_channel(uuid[], text) to authenticated;
