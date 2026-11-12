-- ============================================================
-- Relatório de recompra: o cliente volta?
--
-- A aba Vendas já dizia quantas vendas do período foram recompra. Isso
-- responde "quanto entrou", não "a base recompra". São perguntas
-- diferentes, e a segunda é a que decide se vale mais caçar cliente novo ou
-- trazer de volta quem já comprou.
--
-- TRÊS RECORTES, E ELES NÃO SE COMPARAM
--
-- Esta é a armadilha do assunto, e por isso as três populações estão
-- separadas em colunas com nomes diferentes desde o banco:
--
--   1. FLUXO na janela — das vendas do período, quanto foi 1ª venda e
--      quanto foi recompra, em quantidade e em dinheiro. É o único recorte
--      que responde "o mês fechou com quanto de recompra".
--
--   2. COORTE que estreou na janela — dos clientes cuja PRIMEIRA compra da
--      vida caiu no período, quantos já voltaram. Enviesado para baixo por
--      construção: quem estreou ontem ainda não teve tempo de voltar. A
--      tela diz isso em cima do número; sem o aviso, "3% de recompra" num
--      filtro de 7 dias parece catástrofe.
--
--   3. BASE INTEIRA — ignora o período de propósito. Taxa de recompra,
--      compras por cliente, tempo até a 2ª compra e o LTV de quem volta
--      são propriedades do cliente, não da janela. Recortá-los em 7 dias
--      mediria outra coisa (o mesmo raciocínio do LTV em 046).
--
-- MEDIANA, NÃO MÉDIA, NO TEMPO ATÉ A 2ª COMPRA
--
-- Um cliente que voltou dois anos depois puxa a média para um número que
-- não descreve ninguém. A mediana diz "metade volta em até N dias", que é
-- o que serve para decidir quando cobrar quem sumiu — e é exatamente o
-- corte que a fila de reativação usa.
--
-- ORDEM CANÔNICA DA VENDA
--
-- (sold_at, created_at, id), a mesma de 031/046/052. seq = 1 é a primeira
-- venda da VIDA do cliente, não a primeira dentro da janela: é o que faz
-- "1ª venda" continuar significando aquisição quando o período começa no
-- meio da história dele.
-- ============================================================

-- ------------------------------------------------------------
-- TOPO DA ABA
-- ------------------------------------------------------------
create or replace function public.crm_report_repeat_overview(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to   date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null
)
returns table(
  -- 1. Fluxo na janela
  sales                  bigint,
  first_sales            bigint,
  repeat_sales           bigint,
  revenue_cents          bigint,
  first_revenue_cents    bigint,
  repeat_revenue_cents   bigint,
  first_ticket_cents     bigint,
  repeat_ticket_cents    bigint,
  -- 2. Coorte que estreou na janela
  cohort_clients         bigint,
  cohort_repeaters       bigint,
  cohort_repeat_rate     numeric,
  -- 3. Base inteira (ignora a janela)
  total_clients          bigint,
  repeat_clients         bigint,
  once_clients           bigint,
  repeat_rate            numeric,
  avg_orders             numeric,
  median_days_to_second  numeric,
  once_ltv_cents         bigint,
  repeat_ltv_cents       bigint
)
language sql stable security definer set search_path = public as $$
  with vendas as (
    select
      v.contact_id, v.sold_at, v.value_cents,
      row_number() over (
        partition by v.contact_id order by v.sold_at, v.created_at, v.id
      ) as seq
    from public.crm_sales v
    join public.crm_contacts c on c.id = v.contact_id
    -- security definer não passa pela RLS: o filtro de organização é
    -- explícito, não herdado.
    where v.organization_id = public.current_org_id()
      and (p_channel is null or c.channel = p_channel)
  ),
  por_cliente as (
    select
      w.contact_id,
      count(*) as compras,
      sum(w.value_cents) as total_cents,
      -- seq é único por contato, então o min() aqui é só a forma de
      -- extrair a linha certa dentro do group by.
      min(w.sold_at) filter (where w.seq = 1) as primeira_em,
      min(w.sold_at) filter (where w.seq = 2) as segunda_em
    from vendas w
    group by w.contact_id
  ),
  periodo as (
    select w.* from vendas w
    where w.sold_at >= public.crm_day_start(p_from)
      and w.sold_at <  public.crm_day_start(p_to + 1)
  ),
  coorte as (
    select pc.* from por_cliente pc
    where pc.primeira_em >= public.crm_day_start(p_from)
      and pc.primeira_em <  public.crm_day_start(p_to + 1)
  )
  select
    (select count(*) from periodo p)::bigint,
    (select count(*) from periodo p where p.seq = 1)::bigint,
    (select count(*) from periodo p where p.seq > 1)::bigint,
    (select coalesce(sum(p.value_cents), 0) from periodo p)::bigint,
    (select coalesce(sum(p.value_cents) filter (where p.seq = 1), 0) from periodo p)::bigint,
    (select coalesce(sum(p.value_cents) filter (where p.seq > 1), 0) from periodo p)::bigint,
    -- Os dois tickets lado a lado dizem se quem volta gasta mais ou menos
    -- do que na estreia. Sem separá-los, o ticket médio da aba Vendas
    -- esconde justamente essa diferença.
    (select (coalesce(sum(p.value_cents) filter (where p.seq = 1), 0)
             / nullif(count(*) filter (where p.seq = 1), 0))::bigint from periodo p),
    (select (coalesce(sum(p.value_cents) filter (where p.seq > 1), 0)
             / nullif(count(*) filter (where p.seq > 1), 0))::bigint from periodo p),

    (select count(*) from coorte)::bigint,
    -- "Já recomprou" olha a vida inteira do cliente, inclusive depois do
    -- fim da janela: a pergunta é se ele voltou, não se voltou a tempo.
    (select count(*) from coorte c where c.compras > 1)::bigint,
    (select round(100.0 * count(*) filter (where c.compras > 1)
                  / nullif(count(*), 0), 1) from coorte c),

    (select count(*) from por_cliente)::bigint,
    (select count(*) from por_cliente pc where pc.compras > 1)::bigint,
    (select count(*) from por_cliente pc where pc.compras = 1)::bigint,
    (select round(100.0 * count(*) filter (where pc.compras > 1)
                  / nullif(count(*), 0), 1) from por_cliente pc),
    (select round(sum(pc.compras)::numeric / nullif(count(*), 0), 2) from por_cliente pc),
    (select round(
       percentile_cont(0.5) within group (
         order by extract(epoch from (pc.segunda_em - pc.primeira_em)) / 86400.0
       )::numeric, 1)
     from por_cliente pc where pc.segunda_em is not null),
    -- O par que justifica a aba existir: quanto vale um cliente que voltou
    -- contra um que comprou uma vez só.
    (select (coalesce(sum(pc.total_cents), 0) / nullif(count(*), 0))::bigint
     from por_cliente pc where pc.compras = 1),
    (select (coalesce(sum(pc.total_cents), 0) / nullif(count(*), 0))::bigint
     from por_cliente pc where pc.compras > 1);
$$;

comment on function public.crm_report_repeat_overview(date, date, text) is
  'Topo da aba Recompra. Três populações que NÃO se comparam entre si: '
  'fluxo da janela (1ª venda x recompra), coorte que estreou na janela '
  '(enviesada para baixo — quem estreou ontem não teve tempo de voltar) e '
  'a base inteira, que ignora o período de propósito.';

-- ------------------------------------------------------------
-- DISTRIBUIÇÃO POR NÚMERO DE COMPRAS
--
-- Sempre da base inteira: "quantos clientes compraram N vezes" é a forma
-- da carteira, não um evento do período. Recortada numa janela, viraria
-- "quantos compraram N vezes nestes 30 dias", que é outra pergunta e
-- responderia 1 para quase todo mundo.
--
-- 5+ é o último balde porque a cauda é longa e magra: um cliente com 23
-- compras viraria uma linha própria de um cliente só.
-- ------------------------------------------------------------
create or replace function public.crm_report_repeat_distribution(
  p_channel text default null
)
returns table(
  bucket        text,
  ord           int,
  clients       bigint,
  sales         bigint,
  revenue_cents bigint,
  avg_ltv_cents bigint
)
language sql stable security definer set search_path = public as $$
  with vendas as (
    select v.contact_id, v.value_cents
    from public.crm_sales v
    join public.crm_contacts c on c.id = v.contact_id
    where v.organization_id = public.current_org_id()
      and (p_channel is null or c.channel = p_channel)
  ),
  por_cliente as (
    select w.contact_id, count(*) as compras, sum(w.value_cents) as total_cents
    from vendas w
    group by w.contact_id
  ),
  baldes as (
    select
      pc.compras,
      least(pc.compras, 5)::int as ord,
      pc.total_cents
    from por_cliente pc
  )
  select
    case when b.ord >= 5 then '5+' else b.ord::text end,
    b.ord,
    count(*)::bigint,
    sum(b.compras)::bigint,
    coalesce(sum(b.total_cents), 0)::bigint,
    (coalesce(sum(b.total_cents), 0) / nullif(count(*), 0))::bigint
  from baldes b
  group by b.ord
  order by b.ord;
$$;

-- ------------------------------------------------------------
-- SÉRIE DIÁRIA: 1ª VENDA x RECOMPRA
--
-- Por data da venda, como o resto do relatório de vendas (037). As duas
-- séries somadas dão exatamente o faturamento do dia — é a mesma
-- população, só partida em duas.
-- ------------------------------------------------------------
create or replace function public.crm_report_repeat_timeseries(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to   date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null
)
returns table(
  day                  date,
  first_sales          bigint,
  repeat_sales         bigint,
  first_revenue_cents  bigint,
  repeat_revenue_cents bigint
)
language sql stable security definer set search_path = public as $$
  with dias as (
    -- ::timestamp explícito: com datas puras o Postgres escolheria a
    -- sobrecarga timestamptz e o ::date de volta passaria pelo fuso da
    -- sessão (armadilha documentada na 037).
    select gs::date as day
    from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') gs
  ),
  vendas as (
    select
      v.sold_at, v.value_cents,
      row_number() over (
        partition by v.contact_id order by v.sold_at, v.created_at, v.id
      ) as seq
    from public.crm_sales v
    join public.crm_contacts c on c.id = v.contact_id
    where v.organization_id = public.current_org_id()
      and (p_channel is null or c.channel = p_channel)
  ),
  no_dia as (
    select
      (w.sold_at at time zone 'America/Sao_Paulo')::date as day,
      count(*) filter (where w.seq = 1) as n1,
      count(*) filter (where w.seq > 1) as n2,
      coalesce(sum(w.value_cents) filter (where w.seq = 1), 0) as c1,
      coalesce(sum(w.value_cents) filter (where w.seq > 1), 0) as c2
    from vendas w
    where w.sold_at >= public.crm_day_start(p_from)
      and w.sold_at <  public.crm_day_start(p_to + 1)
    group by 1
  )
  select
    d.day,
    coalesce(n.n1, 0)::bigint,
    coalesce(n.n2, 0)::bigint,
    coalesce(n.c1, 0)::bigint,
    coalesce(n.c2, 0)::bigint
  from dias d
  left join no_dia n on n.day = d.day
  order by d.day;
$$;

-- ------------------------------------------------------------
-- QUEM VOLTOU NO PERÍODO
--
-- Entra o cliente que fez ao menos UMA recompra dentro da janela. As
-- colunas total_* são da vida inteira dele, não da janela: é o que
-- transforma a lista em "meus melhores clientes" em vez de um recorte
-- arbitrário de 30 dias.
--
-- avg_days_between é o ritmo do cliente: intervalo médio entre compras
-- consecutivas (span ÷ (compras − 1)). Com uma compra só seria divisão
-- por zero — mas quem tem uma compra só não entra aqui.
-- ------------------------------------------------------------
create or replace function public.crm_report_repeat_top(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to   date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  p_limit int default 15
)
returns table(
  contact_id          uuid,
  name                text,
  channel             text,
  repeat_in_period    bigint,
  total_sales         bigint,
  total_revenue_cents bigint,
  first_sale_at       timestamptz,
  last_sale_at        timestamptz,
  avg_days_between    numeric
)
language sql stable security definer set search_path = public as $$
  with vendas as (
    select
      v.contact_id, v.sold_at, v.value_cents,
      row_number() over (
        partition by v.contact_id order by v.sold_at, v.created_at, v.id
      ) as seq
    from public.crm_sales v
    join public.crm_contacts c on c.id = v.contact_id
    where v.organization_id = public.current_org_id()
      and (p_channel is null or c.channel = p_channel)
  ),
  agregado as (
    select
      w.contact_id,
      count(*) filter (
        where w.seq > 1
          and w.sold_at >= public.crm_day_start(p_from)
          and w.sold_at <  public.crm_day_start(p_to + 1)
      ) as recompras_janela,
      count(*) as compras,
      sum(w.value_cents) as total_cents,
      min(w.sold_at) as primeira_em,
      max(w.sold_at) as ultima_em
    from vendas w
    group by w.contact_id
  )
  select
    a.contact_id,
    c.name,
    c.channel,
    a.recompras_janela::bigint,
    a.compras::bigint,
    a.total_cents::bigint,
    a.primeira_em,
    a.ultima_em,
    round(
      (extract(epoch from (a.ultima_em - a.primeira_em)) / 86400.0
        / nullif(a.compras - 1, 0))::numeric,
      1
    )
  from agregado a
  join public.crm_contacts c on c.id = a.contact_id
  where a.recompras_janela > 0
  order by a.total_cents desc, a.compras desc
  limit greatest(p_limit, 1);
$$;

-- ------------------------------------------------------------
-- FILA DE REATIVAÇÃO: comprou uma vez e não voltou
--
-- Ignora o período de propósito — "não voltou" é um estado da carteira, e
-- um filtro de 7 dias esconderia justamente quem sumiu.
--
-- p_min_days é o corte de paciência: a tela passa a mediana de dias até a
-- 2ª compra, então a lista mostra só quem JÁ passou do tempo em que
-- metade dos clientes costuma voltar. Sem esse corte, a fila começaria com
-- quem comprou ontem — que não sumiu, só ainda não voltou.
--
-- Ordena por valor gasto, não por tempo parado: quem comprou há dois anos
-- está mais parado, mas quem gastou mais é quem vale a ligação. Cliente
-- morto há muito tempo continua na lista, só não no topo dela.
-- ------------------------------------------------------------
create or replace function public.crm_report_repeat_pending(
  p_channel  text default null,
  p_min_days int default 0,
  p_limit    int default 15
)
returns table(
  contact_id   uuid,
  name         text,
  phone        text,
  channel      text,
  origem       text,
  value_cents  bigint,
  sold_at      timestamptz,
  days_since   int,
  total        bigint
)
language sql stable security definer set search_path = public as $$
  with por_cliente as (
    select
      v.contact_id,
      count(*) as compras,
      min(v.sold_at) as unica_em,
      sum(v.value_cents) as total_cents
    from public.crm_sales v
    join public.crm_contacts c on c.id = v.contact_id
    where v.organization_id = public.current_org_id()
      and (p_channel is null or c.channel = p_channel)
    group by v.contact_id
  ),
  parados as (
    select
      pc.contact_id,
      pc.total_cents,
      pc.unica_em,
      floor(extract(epoch from (now() - pc.unica_em)) / 86400.0)::int as dias
    from por_cliente pc
    where pc.compras = 1
  ),
  filtrados as (
    select p.* from parados p
    where p.dias >= greatest(coalesce(p_min_days, 0), 0)
  )
  select
    f.contact_id,
    c.name,
    c.phone,
    c.channel,
    c.origem,
    f.total_cents::bigint,
    f.unica_em,
    f.dias,
    -- Quantos casam com o filtro ignorando o limite: é o que diz à tela se
    -- ainda há fila além do bloco carregado (mesmo padrão de 039).
    count(*) over ()::bigint
  from filtrados f
  join public.crm_contacts c on c.id = f.contact_id
  order by f.total_cents desc, f.dias desc
  limit greatest(p_limit, 1);
$$;

comment on function public.crm_report_repeat_pending(text, int, int) is
  'Clientes com exatamente uma compra que já passaram de p_min_days sem '
  'voltar — fila de reativação. Ignora o período do relatório de propósito: '
  '"não voltou" é estado da carteira, não evento da janela.';
