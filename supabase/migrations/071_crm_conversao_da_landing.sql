-- ============================================================
-- Terceiro caminho da conversão: o lead que passou pela landing page
--
-- Até aqui existiam dois caminhos (032/033):
--
--   ctwa   → clique no anúncio abriu o WhatsApp direto. O ctwa_clid atribui
--            a venda ao anúncio; vai como business_messaging + page_id.
--   origem → alguém declarou "Anúncio" no cadastro, sem clique capturado.
--            Vai como system_generated, casado só por telefone/nome.
--
-- Falta o funil que já roda: anúncio → landing page (quiz) → botão do
-- WhatsApp. Esse lead NÃO tem ctwa_clid, porque a conversa não nasceu de um
-- clique de Click-to-WhatsApp — ele nasceu de um clique no SITE. O que
-- atribui a venda ao anúncio aqui é o `fbc`, o cookie que o pixel grava com
-- o fbclid do clique. É o equivalente exato do ctwa_clid deste funil.
--
-- Hoje esse lead cai no caminho 'origem' (quando a origem diz anúncio) ou é
-- descartado (quando não diz). Nos dois casos o fbc, o fbp, o IP e o
-- User-Agent capturados na landing são jogados fora — justamente o material
-- que faria a venda voltar para o anúncio certo no Gerenciador.
--
-- CAMINHO NOVO: 'site'
--
-- O worker manda action_source = 'website' com event_source_url (a URL da
-- landing) e user_data com fbc, fbp, client_ip_address e client_user_agent,
-- além do telefone/nome hasheados de sempre.
--
-- QUEM QUALIFICA COMO ANÚNCIO
--
-- fbc sozinho NÃO qualifica. O fbclid também é anexado em clique orgânico
-- vindo do Instagram/Facebook — mandar essa venda para a Meta infla o total
-- de Purchase do pixel sem mídia nenhuma por trás, que é exatamente o que a
-- 032 existe para impedir. Por isso a regra exige fbc E id de campanha, que
-- só existe quando a URL do anúncio carregou os parâmetros dinâmicos.
--
-- Sem o id de campanha, o lead ainda pode entrar pelo caminho 'origem' —
-- degrada para system_generated em vez de sumir.
--
-- UMA DEFINIÇÃO SÓ
--
-- crm_is_ad_contact (052) é a mesma regra que decide o envio à Meta e a
-- população do relatório de ADS. Ela ganha os campos novos, e por isso as
-- três funções de relatório que a chamam são recriadas aqui — corpo
-- idêntico ao da 052, só a chamada muda. A versão de dois argumentos é
-- derrubada no fim: duas definições da mesma regra divergem em seis meses.
--
-- NÃO É PRECISO backfill: nenhum contato tem fbc antes desta migration.
--
-- ORDEM DE DEPLOY — O WORKER PRIMEIRO, ESTA MIGRATION DEPOIS
--
-- Invertido do usual, de propósito. O worker antigo só conhece 'ctwa' e
-- 'origem': um evento marcado 'site' seria encerrado como 'skipped' e a
-- conversão sumiria sem ninguém ver. O worker novo, no ar antes desta
-- migration, não tem o que quebrar — não existe evento 'site' ainda.
--
-- Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

-- ------------------------------------------------------------
-- O que a landing captura, guardado no contato
--
-- Os cinco primeiros são o que a Conversion API precisa para um evento de
-- site. Os três últimos são para o lado do caixa: com eles a receita fica
-- atribuível por campanha aqui dentro — coisa que o ctwa_clid nunca
-- permitiu, porque ele é opaco na API da Meta.
-- ------------------------------------------------------------
alter table public.crm_contacts
  add column if not exists fbc         text,
  add column if not exists fbp         text,
  add column if not exists client_ip   text,
  add column if not exists user_agent  text,
  add column if not exists landing_url text,
  add column if not exists campaign_id text,
  add column if not exists adset_id    text,
  add column if not exists ad_id       text;

comment on column public.crm_contacts.fbc is
  'Cookie _fbc do pixel (fb.1.<ts>.<fbclid>): o clique de anúncio que levou '
  'o lead à landing. É o que atribui a venda ao anúncio no funil de site, '
  'como o ctwaclid faz no funil de Click-to-WhatsApp. Vai sem hash.';
comment on column public.crm_contacts.fbp is
  'Cookie _fbp do pixel. Ajuda o casamento do usuário, mas NÃO prova '
  'anúncio: é gravado para qualquer visitante, inclusive orgânico.';
comment on column public.crm_contacts.client_ip is
  'IP de quem visitou a landing. Precisa ser o do NAVEGADOR do lead — o IP '
  'do servidor que envia o evento estraga o casamento em vez de ajudar.';
comment on column public.crm_contacts.user_agent is
  'User-Agent do navegador do lead. Exigido pela Meta em evento de site; '
  'sem ele o evento não pode sair como action_source = website.';
comment on column public.crm_contacts.landing_url is
  'URL da landing com os parâmetros do clique. Vira event_source_url, '
  'obrigatório em evento de site.';
comment on column public.crm_contacts.campaign_id is
  'Id da campanha da Meta (utm_campaign/utm_id da URL do anúncio). Junto '
  'com o fbc é o que qualifica o lead como vindo de mídia paga.';
comment on column public.crm_contacts.adset_id is
  'Id do conjunto de anúncios da Meta, quando a URL o carrega.';
comment on column public.crm_contacts.ad_id is
  'Id do anúncio da Meta, quando a URL o carrega.';

-- ------------------------------------------------------------
-- "Este contato veio de anúncio?" — agora com o caminho do site
--
-- Ordem dos argumentos = ordem da força do sinal: clique de CTWA, clique
-- no site, rótulo escrito por gente.
-- ------------------------------------------------------------
create or replace function public.crm_is_ad_contact(
  p_ctwaclid text, p_fbc text, p_campaign_id text, p_origem text
)
returns boolean
language sql stable set search_path = public as $$
  select coalesce(p_ctwaclid, '') <> ''
      or (coalesce(p_fbc, '') <> '' and coalesce(p_campaign_id, '') <> '')
      or public.crm_origem_is_ad(p_origem);
$$;

comment on function public.crm_is_ad_contact(text, text, text, text) is
  'true quando o contato veio de anúncio: clique de Click-to-WhatsApp '
  '(ctwa_clid), clique no site vindo de mídia paga (fbc + id de campanha) '
  'ou origem declarando anúncio. Mesma regra que decide o envio da '
  'conversão para a Meta (033/071) — não invente uma segunda definição.';

-- ------------------------------------------------------------
-- RELATÓRIO DE ADS: mesmas funções da 052, chamando a regra nova
--
-- Nada além da chamada de crm_is_ad_contact mudou. Elas são recriadas
-- porque o corpo de uma função SQL é texto: trocar a assinatura da regra
-- não alcança quem a chama. Sem isto, o lead da landing entraria como
-- conversão na Meta e ficaria de fora do relatório que compara gasto e
-- receita — os dois números que precisam fechar entre si.
-- ------------------------------------------------------------
create or replace function public.crm_report_ads_overview(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to   date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null
)
returns table(
  -- Coorte: entrada na janela
  leads                  bigint,
  leads_ctwa             bigint,
  leads_all              bigint,
  -- Fluxo: o que aconteceu na janela
  conversions            bigint,
  new_clients            bigint,
  clients                bigint,
  sales                  bigint,
  first_sales            bigint,
  repeat_sales           bigint,
  creatives              bigint,
  revenue_cents          bigint,
  avg_ticket_cents       bigint,
  ltv_period_cents       bigint,
  -- Histórico completo dos clientes de anúncio (ignora a janela)
  total_clients          bigint,
  total_sales            bigint,
  total_revenue_cents    bigint,
  total_avg_ticket_cents bigint,
  total_ltv_cents        bigint
)
language sql stable security definer set search_path = public as $$
  with ads as (
    select c.id, c.created_at, c.ctwaclid
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and (p_channel is null or c.channel = p_channel)
      and public.crm_is_ad_contact(c.ctwaclid, c.fbc, c.campaign_id, c.origem)
  ),
  leads_janela as (
    select a.* from ads a
    where a.created_at >= public.crm_day_start(p_from)
      and a.created_at <  public.crm_day_start(p_to + 1)
  ),
  -- Denominador da fatia "quanto da entrada veio de mídia paga".
  entrada_total as (
    select count(*)::bigint as n
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and (p_channel is null or c.channel = p_channel)
      and c.created_at >= public.crm_day_start(p_from)
      and c.created_at <  public.crm_day_start(p_to + 1)
  ),
  -- Primeira conversão da vida de cada contato de anúncio (048): reentrar
  -- na etapa não conta de novo.
  primeira_conversao as (
    select h.contact_id, min(h.created_at) as convertido_em
    from public.crm_stage_history h
    join public.crm_stages s on s.id = h.to_stage_id
    join ads a on a.id = h.contact_id
    where s.is_conversion
    group by h.contact_id
  ),
  -- seq é a ordem da venda na VIDA do cliente, não dentro da janela — é
  -- assim que "1ª venda" continua significando aquisição mesmo quando o
  -- período começa no meio da história dele (mesma tupla de 031/046).
  vendas as (
    select
      v.contact_id, v.sold_at, v.creatives, v.value_cents,
      row_number() over (
        partition by v.contact_id order by v.sold_at, v.created_at, v.id
      ) as seq
    from public.crm_sales v
    join ads a on a.id = v.contact_id
  ),
  periodo as (
    select v.* from vendas v
    where v.sold_at >= public.crm_day_start(p_from)
      and v.sold_at <  public.crm_day_start(p_to + 1)
  )
  select
    (select count(*) from leads_janela)::bigint,
    (select count(*) from leads_janela l where coalesce(l.ctwaclid, '') <> '')::bigint,
    (select n from entrada_total),
    (select count(*) from primeira_conversao pc
      where pc.convertido_em >= public.crm_day_start(p_from)
        and pc.convertido_em <  public.crm_day_start(p_to + 1))::bigint,
    -- new_clients e first_sales dão o mesmo número por construção (seq = 1
    -- é único por contato). São duas colunas de propósito: uma é
    -- denominador de CAC, a outra é a quebra "1ª venda x recompra" do
    -- ticket. Fundi-las obrigaria a tela a saber que são a mesma coisa.
    (select count(*) from periodo p where p.seq = 1)::bigint,
    (select count(distinct p.contact_id) from periodo p)::bigint,
    (select count(*) from periodo p)::bigint,
    (select count(*) from periodo p where p.seq = 1)::bigint,
    (select count(*) from periodo p where p.seq > 1)::bigint,
    (select coalesce(sum(p.creatives), 0) from periodo p)::bigint,
    (select coalesce(sum(p.value_cents), 0) from periodo p)::bigint,
    -- ÷ vendas
    (select (coalesce(sum(p.value_cents), 0) / nullif(count(*), 0))::bigint from periodo p),
    -- ÷ clientes ativos na janela
    (select (coalesce(sum(p.value_cents), 0)
             / nullif(count(distinct p.contact_id), 0))::bigint from periodo p),
    (select count(distinct v.contact_id) from vendas v)::bigint,
    (select count(*) from vendas v)::bigint,
    (select coalesce(sum(v.value_cents), 0) from vendas v)::bigint,
    (select (coalesce(sum(v.value_cents), 0) / nullif(count(*), 0))::bigint from vendas v),
    (select (coalesce(sum(v.value_cents), 0)
             / nullif(count(distinct v.contact_id), 0))::bigint from vendas v);
$$;

create or replace function public.crm_report_ads_timeseries(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to   date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null
)
returns table(day date, leads bigint, conversions bigint, sales bigint, revenue_cents bigint)
language sql stable security definer set search_path = public as $$
  with dias as (
    -- ::timestamp explícito: com datas puras o Postgres escolheria a
    -- sobrecarga timestamptz e o ::date de volta passaria pelo fuso da
    -- sessão (mesma armadilha documentada na 037).
    select gs::date as day
    from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') gs
  ),
  ads as (
    select c.id, c.created_at
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and (p_channel is null or c.channel = p_channel)
      and public.crm_is_ad_contact(c.ctwaclid, c.fbc, c.campaign_id, c.origem)
  ),
  leads_dia as (
    select (a.created_at at time zone 'America/Sao_Paulo')::date as day, count(*) as n
    from ads a
    where a.created_at >= public.crm_day_start(p_from)
      and a.created_at <  public.crm_day_start(p_to + 1)
    group by 1
  ),
  conv_dia as (
    select (pc.convertido_em at time zone 'America/Sao_Paulo')::date as day, count(*) as n
    from (
      select h.contact_id, min(h.created_at) as convertido_em
      from public.crm_stage_history h
      join public.crm_stages s on s.id = h.to_stage_id
      join ads a on a.id = h.contact_id
      where s.is_conversion
      group by h.contact_id
    ) pc
    where pc.convertido_em >= public.crm_day_start(p_from)
      and pc.convertido_em <  public.crm_day_start(p_to + 1)
    group by 1
  ),
  vendas_dia as (
    select (v.sold_at at time zone 'America/Sao_Paulo')::date as day,
           count(*) as n,
           sum(v.value_cents) as cents
    from public.crm_sales v
    join ads a on a.id = v.contact_id
    where v.sold_at >= public.crm_day_start(p_from)
      and v.sold_at <  public.crm_day_start(p_to + 1)
    group by 1
  )
  select
    d.day,
    coalesce(l.n, 0)::bigint,
    coalesce(c.n, 0)::bigint,
    coalesce(v.n, 0)::bigint,
    coalesce(v.cents, 0)::bigint
  from dias d
  left join leads_dia  l on l.day = d.day
  left join conv_dia   c on c.day = d.day
  left join vendas_dia v on v.day = d.day
  order by d.day;
$$;

create or replace function public.crm_report_ads_by_origem(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to   date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null
)
returns table(
  origem           text,
  leads            bigint,
  clients          bigint,
  sales            bigint,
  revenue_cents    bigint,
  avg_ticket_cents bigint
)
language sql stable security definer set search_path = public as $$
  with ads as (
    select c.id, c.origem, c.created_at
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and (p_channel is null or c.channel = p_channel)
      and public.crm_is_ad_contact(c.ctwaclid, c.fbc, c.campaign_id, c.origem)
  ),
  vendas as (
    select v.contact_id, v.value_cents
    from public.crm_sales v
    -- security definer não passa pela RLS: sem o filtro de organização
    -- aqui, esta CTE varreria as vendas de TODAS as orgs. O join com `ads`
    -- logo abaixo já descartaria as de fora, mas depender disso é apostar
    -- que ninguém troque o join por outra coisa um dia.
    where v.organization_id = public.current_org_id()
      and v.sold_at >= public.crm_day_start(p_from)
      and v.sold_at <  public.crm_day_start(p_to + 1)
  )
  select
    -- Rótulo = grafia mais comum do grupo, para a tela mostrar algo
    -- legível e acentuado em vez da forma normalizada.
    coalesce(mode() within group (order by a.origem), 'Sem rótulo') as origem,
    -- distinct porque o left join duplica o contato uma vez por venda: sem
    -- ele, quem comprou três vezes contaria como três leads.
    count(distinct a.id) filter (
      where a.created_at >= public.crm_day_start(p_from)
        and a.created_at <  public.crm_day_start(p_to + 1)
    )::bigint,
    count(distinct v.contact_id)::bigint,
    count(v.contact_id)::bigint,
    coalesce(sum(v.value_cents), 0)::bigint,
    (coalesce(sum(v.value_cents), 0) / nullif(count(v.contact_id), 0))::bigint
  from ads a
  left join vendas v on v.contact_id = a.id
  group by lower(extensions.unaccent(coalesce(a.origem, '')))
  -- Grupo sem lead novo E sem venda na janela é história antiga parada:
  -- ocuparia linha na tabela sem dizer nada do período.
  having count(v.contact_id) > 0
      or count(distinct a.id) filter (
           where a.created_at >= public.crm_day_start(p_from)
             and a.created_at <  public.crm_day_start(p_to + 1)
         ) > 0
  order by 5 desc, 2 desc;
$$;

-- A versão de dois argumentos sai de cena agora que ninguém mais a chama.
-- Deixá-la viva convidaria a próxima função de relatório a usá-la e a
-- contar uma população diferente da que vai para a Meta.
drop function if exists public.crm_is_ad_contact(text, text);

-- ------------------------------------------------------------
-- Enfileiramento da conversão: mesma função da 033, com o caminho 'site'
--
-- A decisão está partida em duas perguntas que não são a mesma:
--
--   1. PODE ir para a Meta?  → crm_is_ad_contact, a regra única.
--   2. Por QUAL caminho?     → o melhor identificador que o contato tiver.
--
-- Separar as duas é o que faz o lead qualificado pela origem, mas que TEM
-- fbc guardado, sair pelo caminho do site em vez de virar um
-- system_generated sem atribuição nenhuma. Quem tem clique usa o clique.
-- ------------------------------------------------------------
create or replace function public.crm_enqueue_conversion(p_contact uuid, p_source text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  c public.crm_contacts;
  v_ad_source text;
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

  -- Uma conversão por contato (028). 'skipped' não conta: é evento que o
  -- worker encerrou sem enviar nada, então não representa compra registrada
  -- na Meta — e é justamente o que fica na fila do contato que só depois foi
  -- reconhecido como vindo de anúncio. Comparação por texto de propósito,
  -- para não depender do valor do enum estar visível nesta transação.
  if exists (
    select 1 from public.crm_events
    where contact_id = p_contact
      and event_type = 'conversion'
      and status::text <> 'skipped'
  ) then
    return false;
  end if;

  insert into public.crm_events (organization_id, contact_id, event_type, payload)
  values (
    c.organization_id,
    c.id,
    'conversion',
    jsonb_build_object(
      'value_cents', c.value_cents,
      'email', c.email,
      'phone', c.phone,
      'name', c.name,
      'ctwaclid', c.ctwaclid,
      -- Bloco do funil de site. Vai sempre que existir: o worker decide o
      -- que usar a partir do ad_source, e um payload completo é o que
      -- permite reprocessar o evento sem consultar o contato de novo.
      'fbc', c.fbc,
      'fbp', c.fbp,
      'client_ip', c.client_ip,
      'user_agent', c.user_agent,
      'landing_url', c.landing_url,
      'origem', c.origem,
      -- Lido pelo worker para escolher action_source. Sem ele o evento é
      -- tratado como fila antiga e descartado (skipped).
      'ad_source', v_ad_source,
      'source', p_source
    )
  );

  return true;
end;
$$;

comment on function public.crm_enqueue_conversion(uuid, text) is
  'Enfileira a conversão do contato na Meta se ele vier de anúncio — por '
  'ctwa_clid (CTWA), por fbc + campanha (landing) ou por origem declarada — '
  'e ainda não tiver evento. Chamada pelos triggers de etapa, origem e fbc.';

-- ------------------------------------------------------------
-- Terceiro gatilho: o dado da landing chegou depois
--
-- O casamento entre a visita à landing e a conversa do WhatsApp acontece
-- fora daqui, e nada garante que ele chegue antes da venda: o contato pode
-- ser criado pelo n8n no primeiro "oi" e só depois receber o fbc.
--
-- Três situações, três desfechos:
--
--   ainda não converteu  → nada a fazer; o trigger de etapa cuida na hora
--                          da venda, já com o fbc gravado;
--   converteu, evento    → o evento PENDENTE é melhorado no lugar: passa a
--   ainda na fila          sair pelo caminho do site, com atribuição. Isto
--                          é o mesmo princípio da 042 — o que ainda não
--                          saiu acompanha a correção;
--   converteu, sem       → enfileira agora (a venda foi antes do match).
--   evento válido
--
-- Evento marcado 'ctwa' não é tocado: clique de Click-to-WhatsApp é sinal
-- mais forte e já está atribuído.
-- ------------------------------------------------------------
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
  perform public.crm_enqueue_conversion(
    new.id,
    case when auth.uid() is null then 'api' else 'ui' end
  );

  return null;
end;
$$;

comment on function public.crm_fbc_conversion_catchup() is
  'Contato que já converteu e só depois recebeu os dados do clique na '
  'landing: melhora o evento ainda na fila ou enfileira a conversão.';

drop trigger if exists crm_contacts_fbc_conversion on public.crm_contacts;
create trigger crm_contacts_fbc_conversion
  after update of fbc, campaign_id on public.crm_contacts
  for each row
  when (old.fbc is distinct from new.fbc
     or old.campaign_id is distinct from new.campaign_id)
  execute function public.crm_fbc_conversion_catchup();
