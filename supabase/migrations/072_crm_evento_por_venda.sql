-- ============================================================
-- Toda venda de cliente de anúncio vai para a Meta, não só a primeira
--
-- A 028 fechou o segundo evento por contato e escreveu o caminho de saída
-- na própria justificativa: "o modelo tem um único value_cents por
-- contato, então recompra não é representável hoje; se um dia for, o certo
-- é um evento por venda, não por etapa". A 031 trouxe crm_sales. É esse
-- caminho que esta migration percorre.
--
-- O evento deixa de ser do CONTATO e passa a ser da VENDA. Cada venda de
-- cliente de anúncio gera seu próprio Purchase, com o valor DELA — antes ia
-- sempre o valor da primeira, mesmo quando a segunda era maior.
--
-- AS TRÊS TRAVAS ANTI-DUPLICATA
--
--   1. Uma conversão por venda. É a 028 traduzida para o novo modelo: o
--      event_id é por linha de crm_events, e a Meta dedupe por ele.
--   2. Contato COM venda registrada: a etapa não gera evento nenhum. Sem
--      isto, arrastar o card para fora da conversão e de volta mandaria um
--      segundo Purchase da mesma venda — exatamente o bug que a 028 pagou
--      para descobrir, agora que a trava "uma por contato" não existe mais.
--   3. Contato SEM venda nenhuma: a etapa gera um evento (sale_id null),
--      como sempre. Quando a primeira venda for registrada depois, ela
--      ADOTA esse evento em vez de criar outro — é a mesma conversão vista
--      de outro ângulo, não uma segunda compra.
--
-- O QUE ISSO MUDA NO GERENCIADOR
--
-- A recompra vai com o MESMO fbc/ctwa_clid da aquisição — é o único clique
-- que existe. Dentro da janela de atribuição, a Meta credita a recompra ao
-- mesmo anúncio: o ROAS dele sobe e passa a incluir o LTV, não só a
-- primeira compra. Fora da janela, o Purchase entra no dataset sem
-- atribuição a anúncio nenhum. As duas coisas são consequência direta de
-- mandar toda venda, e são o que foi pedido.
--
-- NÃO HÁ BACKFILL DE RECOMPRA ANTIGA. Enfileirar o histórico mandaria
-- dezenas de Purchase com event_time de hoje e valor de meses atrás, o que
-- suja o dataset sem medir nada. A regra vale da próxima venda em diante.
-- Para reenviar um contato específico de propósito:
--
--   select public.crm_enqueue_pending_conversions(id, 'backfill')
--   from public.crm_contacts where id = '<uuid>';
--
-- ORDEM DE DEPLOY: qualquer uma. A única mudança no worker é o order_id no
-- custom_data, que é aditivo — worker velho ignora o campo novo do payload,
-- worker novo não acha o campo em evento antigo e segue sem ele.
--
-- Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

-- ------------------------------------------------------------
-- De qual venda é este evento
--
-- Sem FK de propósito. crm_events é o registro do que foi (ou seria)
-- enviado à Meta; apagar a venda não pode apagar nem descaracterizar esse
-- registro — o Purchase já entregue continua existindo do lado deles, e
-- fingir o contrário aqui é como o time perde a conta do que foi enviado.
-- O que a exclusão faz é cancelar o que AINDA não saiu, logo abaixo, na
-- trigger de sincronia.
--
-- null = conversão que entrou pela etapa, sem venda registrada.
-- ------------------------------------------------------------
alter table public.crm_events
  add column if not exists sale_id uuid;

comment on column public.crm_events.sale_id is
  'Venda que este evento representa (crm_sales.id). null = conversão que '
  'veio da etapa, sem venda registrada. Sem FK: o evento sobrevive à '
  'exclusão da venda, porque o que foi enviado à Meta não volta atrás.';

create index if not exists idx_crm_events_sale
  on public.crm_events(sale_id)
  where event_type = 'conversion';

-- ------------------------------------------------------------
-- LIGAR O QUE JÁ EXISTE À PRIMEIRA VENDA — obrigatório, não cosmético
--
-- Todo evento de hoje tem sale_id null. Sem este update, a próxima
-- recompra de um cliente antigo encontraria o evento da PRIMEIRA venda
-- solto (sale_id null), o adotaria como se fosse dela, e a recompra nunca
-- seria enviada — silenciosamente, que é o pior jeito de errar.
--
-- Contato sem venda nenhuma continua com sale_id null: ali o evento é
-- mesmo da etapa, e é isso que ele quer dizer.
-- ------------------------------------------------------------
update public.crm_events e
set sale_id = primeira.id
from (
  select distinct on (contact_id) contact_id, id
  from public.crm_sales
  order by contact_id, sold_at, created_at, id
) primeira
where primeira.contact_id = e.contact_id
  and e.event_type = 'conversion'
  and e.sale_id is null;

-- ------------------------------------------------------------
-- Enfileiramento, agora por venda
--
-- p_sale null = conversão da etapa, para contato que não tem venda.
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
    select s.value_cents into v_value
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
            then e.payload || jsonb_build_object('value_cents', v_value, 'sale_id', p_sale)
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
  'contato vier de anúncio e aquela venda ainda não tiver evento.';

-- ------------------------------------------------------------
-- "Manda o que estiver faltando deste contato"
--
-- Usada pelos gatilhos de recuperação (origem e fbc), que rodam quando um
-- contato passa a se qualificar como anúncio DEPOIS de já ter vendido.
-- Antes da 072 bastava enfileirar uma conversão; agora cada venda tem a
-- sua, e o que faltava pode ser mais de uma.
--
-- Devolve quantas foram enfileiradas — útil para chamar na mão e conferir.
-- ------------------------------------------------------------
create or replace function public.crm_enqueue_pending_conversions(
  p_contact uuid, p_source text
)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_n int := 0;
  v_sale record;
begin
  if exists (select 1 from public.crm_sales where contact_id = p_contact) then
    for v_sale in
      select id from public.crm_sales
      where contact_id = p_contact
      order by sold_at, created_at, id
    loop
      if public.crm_enqueue_conversion(p_contact, p_source, v_sale.id) then
        v_n := v_n + 1;
      end if;
    end loop;
  else
    if public.crm_enqueue_conversion(p_contact, p_source, null) then
      v_n := 1;
    end if;
  end if;

  return v_n;
end;
$$;

comment on function public.crm_enqueue_pending_conversions(uuid, text) is
  'Enfileira as conversões que faltam do contato — uma por venda, ou a da '
  'etapa quando ele não tem venda. Ignora as que já têm evento.';

-- ------------------------------------------------------------
-- Os três gatilhos, chamando a assinatura nova
--
-- Corpo idêntico ao de 033/071: só a chamada mudou. Os de recuperação
-- passam a usar crm_enqueue_pending_conversions, porque um contato que só
-- agora foi reconhecido como de anúncio pode ter várias vendas para mandar.
-- ------------------------------------------------------------
create or replace function public.crm_track_stage_change()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_source text;
  v_converts boolean;
  v_was_conversion boolean;
begin
  if tg_op = 'UPDATE' and old.stage_id is not distinct from new.stage_id then
    return null;
  end if;

  if tg_op = 'INSERT' and new.stage_id is null then
    return null;
  end if;

  v_source := case when auth.uid() is null then 'api' else 'ui' end;

  -- Histórico de TODA movimentação, inclusive de quem não veio de anúncio:
  -- é dele que os relatórios de conversão saem (crm_has_converted, 016).
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

  -- Entrada REAL na etapa de conversão (vindo de etapa que não convertia).
  if coalesce(v_converts, false) and not coalesce(v_was_conversion, false) then
    perform public.crm_enqueue_conversion(new.id, v_source, null);
  end if;

  return null;
end;
$$;

create or replace function public.crm_origem_conversion_catchup()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Passou a declarar anúncio agora? Se já declarava antes, o evento (se
  -- devido) já foi enfileirado na ocasião.
  if public.crm_origem_is_ad(old.origem) or not public.crm_origem_is_ad(new.origem) then
    return null;
  end if;

  if not public.crm_has_converted(new.id) then
    return null;
  end if;

  perform public.crm_enqueue_pending_conversions(
    new.id,
    case when auth.uid() is null then 'api' else 'ui' end
  );

  return null;
end;
$$;

create or replace function public.crm_fbc_conversion_catchup()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Sem qualificar como anúncio não há o que enviar nem o que melhorar.
  if not public.crm_is_ad_contact(new.ctwaclid, new.fbc, new.campaign_id, new.origem) then
    return null;
  end if;

  if coalesce(new.fbc, '') = '' then
    return null;
  end if;

  if not public.crm_has_converted(new.id) then
    return null;
  end if;

  update public.crm_events e
  set payload = e.payload || jsonb_build_object(
        'fbc', new.fbc,
        'fbp', new.fbp,
        'client_ip', new.client_ip,
        'user_agent', new.user_agent,
        'landing_url', new.landing_url,
        'ad_source', 'site'
      )
  where e.contact_id = new.id
    and e.event_type = 'conversion'
    and e.status = 'pending'
    and coalesce(e.payload->>'ad_source', '') <> 'ctwa';

  -- No-op quando o UPDATE acima achou alguém: a trava de uma conversão por
  -- contato barra o segundo evento. Vale a chamada pelo caso do contato que
  -- converteu sem evento válido (foi 'skipped' por não ser de anúncio).
  perform public.crm_enqueue_pending_conversions(
    new.id,
    case when auth.uid() is null then 'api' else 'ui' end
  );

  return null;
end;
$$;

-- A assinatura de dois argumentos sai de cena: com ela viva, um gatilho
-- novo chamaria a versão que não sabe de venda e voltaria a mandar uma
-- conversão por contato, sem ninguém perceber a diferença.
drop function if exists public.crm_enqueue_conversion(uuid, text);

-- ------------------------------------------------------------
-- SINCRONIA DAS VENDAS
--
-- Corpo da 042 até a atualização do contato; daí para baixo é o que muda:
-- o acerto de valor passa a ser por venda, a exclusão cancela o que ainda
-- não saiu, e toda venda nova enfileira a sua conversão.
-- ------------------------------------------------------------
create or replace function public.crm_sales_sync_contact()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_contact uuid;
  v_count int;
  v_total bigint;
  v_first bigint;
  v_stage uuid;
begin
  -- Em DELETE o registro NEW não existe: nunca o referencie aqui.
  if tg_op = 'DELETE' then
    v_contact := old.contact_id;
  else
    v_contact := new.contact_id;
  end if;

  select count(*), coalesce(sum(value_cents), 0)
    into v_count, v_total
  from public.crm_sales where contact_id = v_contact;

  -- Valor do contato = valor da primeira venda. Se a primeira for excluída,
  -- a segunda assume o posto e o valor acompanha; sem nenhuma venda, zera.
  select value_cents into v_first
  from public.crm_sales
  where contact_id = v_contact
  order by sold_at, created_at, id
  limit 1;

  -- Primeira venda do cliente: leva o contato para a etapa de conversão. O
  -- trigger crm_contacts_stage_change cuida do histórico e do evento na
  -- Meta (e a 028/033 garantem um evento por contato, nunca dois).
  --
  -- Só no INSERT que criou a 1ª linha. Recompra não mexe na etapa, e
  -- editar/excluir venda também não — quem já converteu, converteu.
  if tg_op = 'INSERT' and v_count = 1 then
    select s.id into v_stage
    from public.crm_stages s
    where s.organization_id = new.organization_id and s.is_conversion;
  end if;

  update public.crm_contacts c set
    sales_count = v_count,
    sales_total_cents = v_total,
    value_cents = coalesce(v_first, 0),
    -- v_stage nulo (recompra, edição, exclusão, ou org sem etapa de
    -- conversão configurada) mantém o contato onde está.
    stage_id = coalesce(v_stage, c.stage_id)
  where c.id = v_contact;

  -- Correção de valor acompanha o evento DAQUELA venda. A 042 fazia isso
  -- para o único evento do contato; agora cada venda tem o seu. Depois de
  -- enviado não há o que fazer — a Conversions API não corrige evento.
  if tg_op = 'UPDATE' then
    update public.crm_events e
    set payload = jsonb_set(e.payload, '{value_cents}', to_jsonb(new.value_cents))
    where e.sale_id = new.id
      and e.event_type = 'conversion'
      and e.status = 'pending';
  end if;

  -- Evento da ETAPA, sem venda vinculada: o valor dele é o da primeira
  -- venda do contato, como sempre foi.
  update public.crm_events e
  set payload = jsonb_set(e.payload, '{value_cents}', to_jsonb(coalesce(v_first, 0)))
  where e.contact_id = v_contact
    and e.sale_id is null
    and e.event_type = 'conversion'
    and e.status = 'pending';

  -- Venda excluída antes do envio: o Purchase perde o que representava, e
  -- mandá-lo assim mesmo criaria receita que não existe. 'skipped' porque
  -- 'failed' seria mentira — não falhou nada, foi cancelado.
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
  -- Vem depois da atualização do contato de propósito. Aquele update já
  -- disparou a trigger de etapa, que viu o contato com venda registrada e
  -- declinou (trava 2) — então o único caminho que resta para a conversão
  -- desta venda é este aqui, e ele conhece o valor certo: o dela.
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
  'Mantém os totais do contato a partir das vendas, move o contato na 1ª '
  'venda, enfileira a conversão de CADA venda de cliente de anúncio e '
  'acerta — ou cancela — o evento que ainda não saiu da fila.';
