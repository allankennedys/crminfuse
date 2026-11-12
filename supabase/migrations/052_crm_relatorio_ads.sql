-- ============================================================
-- Relatório de Meta ADS: o lado CRM do dinheiro
--
-- A aba nova responde quatro perguntas que ninguém conseguia responder sem
-- abrir duas telas e fazer conta à mão:
--
--   ticket médio dos clientes de anúncio · LTV deles · quanto custou ·
--   quanto voltou (ROI)
--
-- O CUSTO NÃO MORA AQUI. Ele vem da Marketing API da Meta, pela Edge
-- Function `meta-ads`, que é quem tem acesso ao token. Este arquivo entrega
-- só a metade que o banco sabe: receita, clientes e vendas dos contatos que
-- vieram de anúncio. A divisão (ROI, CAC, CPL) é feita na tela, com um
-- número de cada lado — de propósito: se um dos dois faltar, o card diz o
-- que falta em vez de mostrar zero.
--
-- QUEM É "CLIENTE DE ANÚNCIO"
--
-- Exatamente a mesma regra que decide o que vai para a Meta (033):
-- ctwa_clid preenchido (clique real, atribuível) OU origem declarando
-- anúncio. Não é uma definição nova — é a que já governa a conversão. Se
-- fossem duas, o relatório mostraria um número e o Gerenciador de Anúncios
-- outro, e a diferença seria impossível de explicar.
--
-- A regra vira função (crm_is_ad_contact) para viver num lugar só.
--
-- DUAS DATAS, COMO NO RESTO DOS RELATÓRIOS
--
--   leads          → por data de criação do contato (coorte)
--   receita/vendas → por data da venda, sold_at (fluxo)
--
-- É a mesma convenção do funil e da aba Vendas (037). O gráfico de custo x
-- receita usa o fluxo, que é o que se compara com o gasto do dia.
--
-- FUSO: as janelas aqui são São Paulo (crm_day_start, 037). A Meta reporta
-- no fuso da CONTA DE ANÚNCIOS. Se as duas não coincidirem, os totais de um
-- dia isolado dançam algumas horas — a tela avisa isso no rodapé.
--
-- CONFIGURAÇÃO NOVA EM crm_settings
--
--   meta_ad_account_id → conta de anúncios (act_123... ou só os dígitos)
--   meta_ads_token     → token com permissão ads_read
--
-- O token é separado do da Conversion API de propósito: o que já está
-- salvo e funcionando pode não ter ads_read, e trocá-lo para ganhar o
-- relatório derrubaria o envio de conversões. Vazio, a Edge Function cai
-- no meta_access_token — quem usa um system user com as duas permissões
-- não precisa preencher nada.
-- ============================================================

-- ------------------------------------------------------------
-- CONFIGURAÇÃO
-- ------------------------------------------------------------

alter table public.crm_settings
  add column if not exists meta_ad_account_id text,
  add column if not exists meta_ads_token     text;

comment on column public.crm_settings.meta_ad_account_id is
  'Conta de anúncios da Meta lida pelo relatório (Marketing API). Aceita '
  'com ou sem o prefixo act_ — a Edge Function normaliza.';

comment on column public.crm_settings.meta_ads_token is
  'Token com permissão ads_read, usado só para LER insights. Nulo faz a '
  'Edge Function cair no meta_access_token (o da Conversion API).';

-- crm_settings_get ganha colunas: o tipo de retorno muda, então é DROP
-- antes de CREATE (replace não altera assinatura de retorno).
drop function if exists public.crm_settings_get();

create function public.crm_settings_get()
returns table (
  meta_pixel_id      text,
  has_token          boolean,
  meta_test_event_code text,
  meta_page_id       text,
  meta_ad_account_id text,
  -- Mesmo tratamento do token da CAPI: a tela sabe que existe, nunca o vê.
  has_ads_token      boolean
)
language sql stable security definer set search_path = public as $$
  select s.meta_pixel_id,
         coalesce(s.meta_access_token, '') <> '',
         s.meta_test_event_code,
         s.meta_page_id,
         s.meta_ad_account_id,
         coalesce(s.meta_ads_token, '') <> ''
  from public.crm_settings s
  where s.organization_id = public.current_org_id();
$$;

-- ------------------------------------------------------------
-- crm_settings_save com os dois campos novos
--
-- A regra de nulo é a MESMA do token da CAPI, e pela lição que a 029
-- deixou por escrito: parâmetro ausente chega nulo, e um UPDATE que grava
-- nulo cego APAGA configuração em silêncio a cada salvamento. Então:
--
--   null = não mexe no que está salvo
--   ''   = apaga
--
-- Aridade diferente é função diferente no Postgres: sem o drop da versão
-- de 3 argumentos ficariam as duas e a chamada por nome viraria ambígua.
-- meta_page_id continua fora daqui (029), intocado.
-- ------------------------------------------------------------
drop function if exists public.crm_settings_save(text, text, text);

create function public.crm_settings_save(
  p_pixel      text,
  p_token      text default null,
  p_test_code  text default null,
  p_ad_account text default null,
  p_ads_token  text default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
begin
  if public.current_user_role() not in ('admin', 'crm_only') then
    raise exception 'Sem permissão para alterar as configurações do CRM';
  end if;

  insert into public.crm_settings (
    organization_id, meta_pixel_id, meta_access_token,
    meta_test_event_code, meta_ad_account_id, meta_ads_token, updated_at
  )
  values (
    v_org, nullif(p_pixel, ''), nullif(p_token, ''),
    nullif(p_test_code, ''), nullif(p_ad_account, ''), nullif(p_ads_token, ''),
    now()
  )
  on conflict (organization_id) do update set
    meta_pixel_id = nullif(excluded.meta_pixel_id, ''),
    -- Em ON CONFLICT a linha existente é referenciada pelo nome da tabela,
    -- sem qualificar o schema.
    meta_access_token = case
      when p_token is null then crm_settings.meta_access_token
      else nullif(p_token, '')
    end,
    meta_test_event_code = nullif(excluded.meta_test_event_code, ''),
    meta_ad_account_id = case
      when p_ad_account is null then crm_settings.meta_ad_account_id
      else nullif(p_ad_account, '')
    end,
    meta_ads_token = case
      when p_ads_token is null then crm_settings.meta_ads_token
      else nullif(p_ads_token, '')
    end,
    -- meta_page_id ausente de propósito: ver 029.
    updated_at = now();
end;
$$;

-- ------------------------------------------------------------
-- "ESTE CONTATO VEIO DE ANÚNCIO?"
--
-- Espelha a decisão de crm_enqueue_conversion (033) numa função só, para o
-- relatório e o envio nunca divergirem. Recebe os dois campos em vez do id
-- para poder ser chamada dentro de um WHERE sem subconsulta por linha.
--
-- stable, não immutable: depende de crm_origem_is_ad, que é stable.
-- ------------------------------------------------------------
create or replace function public.crm_is_ad_contact(p_ctwaclid text, p_origem text)
returns boolean
language sql stable set search_path = public as $$
  select coalesce(p_ctwaclid, '') <> '' or public.crm_origem_is_ad(p_origem);
$$;

comment on function public.crm_is_ad_contact(text, text) is
  'true quando o contato veio de anúncio: com ctwa_clid (clique atribuível) '
  'ou com a origem declarando mídia paga. Mesma regra que decide o envio da '
  'conversão para a Meta (033) — não invente uma segunda definição.';

-- ------------------------------------------------------------
-- TOPO DO RELATÓRIO DE ADS
--
-- Uma chamada devolve as três populações que a tela precisa:
--
--   • coorte  → leads de anúncio criados na janela (com o total de leads
--               ao lado, para dizer que fatia da entrada veio de mídia);
--   • fluxo   → vendas e receita de clientes de anúncio na janela, que é o
--               que se divide pelo gasto do MESMO período;
--   • sempre  → todo o histórico dos clientes de anúncio, de onde sai o
--               LTV de verdade (o da janela é receita por cliente ativo,
--               não valor de cliente — ver 046).
--
-- new_clients é a base do CAC: contato de anúncio cuja PRIMEIRA venda da
-- vida caiu na janela. Não é "clientes com venda no período" (esse é
-- clients, e inclui recompra de quem já era cliente) nem "conversões"
-- (que também conta quem entrou na etapa sem venda registrada).
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
      and public.crm_is_ad_contact(c.ctwaclid, c.origem)
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

comment on function public.crm_report_ads_overview(date, date, text) is
  'Metade CRM do relatório de Meta ADS: leads, vendas, receita, ticket e LTV '
  'dos contatos vindos de anúncio. O custo vem da Marketing API (Edge '
  'Function meta-ads) e as divisões — ROI, CAC, CPL — são feitas na tela.';

-- ------------------------------------------------------------
-- SÉRIE DIÁRIA
--
-- Serve ao gráfico que sobrepõe investimento (Meta) e retorno (CRM). Por
-- isso `revenue_cents` é por data da VENDA: é esse número que se compara
-- com o gasto daquele dia. `leads` continua por data de criação — as duas
-- séries convivem no mesmo gráfico com eixos diferentes, como no funil.
-- ------------------------------------------------------------
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
      and public.crm_is_ad_contact(c.ctwaclid, c.origem)
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

-- ------------------------------------------------------------
-- QUEBRA POR ORIGEM (só as de anúncio)
--
-- A Meta quebra por campanha e anúncio; o CRM não sabe de qual anúncio o
-- lead veio (ctwa_clid não é consultável pela API). O que ele sabe é o
-- rótulo que a operação escreveu na origem — "Instagram Ads", "Anúncio
-- criativos", etc. É a quebra possível do lado da receita, e por isso ela
-- fica ao lado da quebra por campanha, não misturada com ela.
--
-- Agrupa ignorando caixa e acento, como o relatório por origem (025).
-- ------------------------------------------------------------
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
      and public.crm_is_ad_contact(c.ctwaclid, c.origem)
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

comment on function public.crm_report_ads_by_origem(date, date, text) is
  'Receita e leads de anúncio agrupados pelo rótulo da origem. É a quebra '
  'possível do lado do CRM: ctwa_clid não é consultável na API da Meta, '
  'então não há como ligar a venda ao anúncio específico por aqui.';
