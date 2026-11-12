-- ============================================================
-- Relatórios por intervalo de datas (hoje, presets e personalizado)
--
-- Até aqui todo relatório recebia `days int` e o banco calculava a janela.
-- Isso só expressa "os últimos N dias terminando hoje" — não dá para pedir
-- "só hoje" (seria days=1, que funciona por acaso) nem "de 3 a 17 de junho".
--
-- Agora a janela é explícita: p_from e p_to, datas de calendário no fuso de
-- São Paulo, INCLUSIVE nas duas pontas. Quem escolhe o período é a tela; o
-- banco só respeita o que recebeu.
--
-- Internamente o filtro é meio-aberto [meia-noite de p_from, meia-noite do
-- dia seguinte a p_to). É o que faz "hoje" pegar o dia inteiro sem depender
-- da hora da consulta, e o que evita o clássico erro de perder as vendas
-- feitas depois das 00:00 do último dia.
--
-- ESTA MIGRATION TAMBÉM CORRIGE OS NÚMEROS QUE NÃO BATIAM
--
-- Sintoma: o card "Convertidos" mostrava 8 e o gráfico somava 12 no mesmo
-- período. Eram três divergências somadas, todas resolvidas aqui:
--
-- 1. CONTAGEM — o gráfico contava LINHAS de crm_stage_history, então o mesmo
--    cliente contava de novo a cada reentrada na etapa de conversão. E isso
--    acontece sozinho: a rotina de arquivamento (030) tira o convertido da
--    etapa depois de 5 dias, e qualquer volta gera linha nova — inclusive a
--    trigger de vendas (031), quando a 1ª venda é registrada depois. Agora
--    cada contato conta uma vez, na PRIMEIRA entrada (o min() abaixo).
--
-- 2. POPULAÇÃO — o card era coorte (leads criados no período) e o gráfico
--    era fluxo (qualquer conversão do dia, inclusive de lead antigo). O
--    gráfico passa a mostrar a mesma coorte do card. Como a conversão de um
--    lead criado dentro da janela é sempre depois da criação, ela nunca cai
--    fora do gráfico: a soma fecha por construção.
--
-- 3. JANELA — o card usava `now() - 30 dias` (instante exato) e o gráfico,
--    30 dias de calendário. Mesmo resolvendo 1 e 2, as bordas continuariam
--    diferentes. Agora há uma definição só, a deste arquivo, usada por
--    TODAS as funções de relatório.
--
-- Quem responde "quanto entrou no período, venha o cliente de quando vier"
-- é o relatório de vendas, que é por data da venda — de propósito.
--
-- crm_period_start(days), da 035, sai de cena junto: com duas definições de
-- janela vivas, um relatório acabaria usando uma e outro a outra, que é
-- justamente a origem do problema. (A 035 foi absorvida por este arquivo e
-- não existe mais; o drop abaixo é no-op se ela nunca chegou a rodar.)
--
-- Assinatura nova = DROP antes do CREATE: mudar o tipo dos parâmetros criaria
-- sobrecarga em vez de substituir, e a chamada por nome ficaria ambígua.
-- ============================================================

-- Meia-noite (em São Paulo) da data dada, como instante real. Comparar
-- created_at/sold_at com isto usa índice; converter fuso linha a linha não.
create or replace function public.crm_day_start(d date)
returns timestamptz
language sql immutable set search_path = public as $$
  select d::timestamp at time zone 'America/Sao_Paulo';
$$;

comment on function public.crm_day_start(date) is
  'Meia-noite em São Paulo da data, como timestamptz. Base da janela de '
  'todos os relatórios do CRM.';

drop function if exists public.crm_period_start(int);

drop function if exists public.crm_report_overview(int, text);
drop function if exists public.crm_report_timeseries(int, text);
drop function if exists public.crm_report_by_origem(int, text);
drop function if exists public.crm_report_by_channel(int, text);
drop function if exists public.crm_report_sales(int, text);
drop function if exists public.crm_report_sales_timeseries(int, text);
drop function if exists public.crm_report_sales_by_contact(int, text, int);
drop function if exists public.crm_report_no_origem_by_stage(int, text);
drop function if exists public.crm_report_no_origem_list(int, text, int);

-- Padrão das novas assinaturas: últimos 30 dias terminando hoje, para uma
-- chamada manual sem argumentos continuar respondendo algo útil.
-- ------------------------------------------------------------
-- FUNIL — coorte: leads criados na janela
-- ------------------------------------------------------------
create or replace function public.crm_report_overview(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null
)
returns table(
  total_leads          bigint,
  converted            bigint,
  conversion_rate      numeric,
  revenue_cents        bigint,
  avg_ticket_cents     bigint,
  avg_hours_to_convert numeric
)
language sql stable security definer set search_path = public as $$
  with base as (
    select
      c.value_cents,
      c.created_at,
      (
        select min(h.created_at)
        from public.crm_stage_history h
        join public.crm_stages s on s.id = h.to_stage_id
        where h.contact_id = c.id and s.is_conversion
      ) as converted_at
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and c.created_at >= public.crm_day_start(p_from)
      and c.created_at < public.crm_day_start(p_to + 1)
      and (p_channel is null or c.channel = p_channel)
  )
  select
    count(*)::bigint,
    count(converted_at)::bigint,
    round(100.0 * count(converted_at) / nullif(count(*), 0), 1),
    coalesce(sum(value_cents) filter (where converted_at is not null), 0)::bigint,
    (coalesce(sum(value_cents) filter (where converted_at is not null), 0)
      / nullif(count(converted_at), 0))::bigint,
    round(
      (avg(extract(epoch from (converted_at - created_at)) / 3600.0)
        filter (where converted_at is not null))::numeric,
      1
    )
  from base;
$$;

create or replace function public.crm_report_timeseries(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null
)
returns table(day date, leads bigint, conversions bigint)
language sql stable security definer set search_path = public as $$
  with dias as (
    -- ::timestamp explícito: com datas puras o Postgres escolheria a
    -- sobrecarga timestamptz e o ::date de volta passaria pelo fuso da
    -- sessão. Aqui a série é só rótulo de dia e não depende de fuso nenhum.
    select gs::date as day
    from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') gs
  ),
  coorte as (
    select c.id, c.created_at
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and c.created_at >= public.crm_day_start(p_from)
      and c.created_at < public.crm_day_start(p_to + 1)
      and (p_channel is null or c.channel = p_channel)
  ),
  leads_dia as (
    select (co.created_at at time zone 'America/Sao_Paulo')::date as day, count(*) as n
    from coorte co
    group by 1
  ),
  -- Uma linha por contato: a PRIMEIRA vez que entrou em etapa de conversão.
  -- É o min() que impede a reentrada de contar como conversão nova.
  conversoes_dia as (
    select
      (pc.convertido_em at time zone 'America/Sao_Paulo')::date as day,
      count(*) as n
    from (
      select h.contact_id, min(h.created_at) as convertido_em
      from public.crm_stage_history h
      join public.crm_stages s on s.id = h.to_stage_id
      join coorte co on co.id = h.contact_id
      where s.is_conversion
      group by h.contact_id
    ) pc
    group by 1
  )
  select
    d.day,
    coalesce(l.n, 0)::bigint,
    coalesce(k.n, 0)::bigint
  from dias d
  left join leads_dia l on l.day = d.day
  left join conversoes_dia k on k.day = d.day
  order by d.day;
$$;

comment on function public.crm_report_timeseries(date, date, text) is
  'Leads criados por dia e, dos mesmos leads, quando converteram. Cada '
  'cliente conta uma vez, na primeira conversão. Somar as séries dá '
  'exatamente os cards Leads e Convertidos da mesma janela.';

create or replace function public.crm_report_by_origem(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null
)
returns table(
  origem          text,
  leads           bigint,
  converted       bigint,
  conversion_rate numeric,
  revenue_cents   bigint
)
language sql stable security definer set search_path = public as $$
  select
    mode() within group (order by c.origem) as origem,
    count(*)::bigint,
    count(*) filter (where conv.converted)::bigint,
    round(100.0 * count(*) filter (where conv.converted) / nullif(count(*), 0), 1),
    coalesce(sum(c.value_cents) filter (where conv.converted), 0)::bigint
  from public.crm_contacts c
  cross join lateral (
    select public.crm_has_converted(c.id) as converted
  ) conv
  where c.organization_id = public.current_org_id()
    and c.created_at >= public.crm_day_start(p_from)
    and c.created_at < public.crm_day_start(p_to + 1)
    and c.origem is not null
    and c.origem <> ''
    and (p_channel is null or c.channel = p_channel)
  group by lower(extensions.unaccent(c.origem))
  order by 2 desc, 1;
$$;

create or replace function public.crm_report_by_channel(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null
)
returns table(
  channel         text,
  leads           bigint,
  converted       bigint,
  conversion_rate numeric,
  revenue_cents   bigint
)
language sql stable security definer set search_path = public as $$
  select
    c.channel,
    count(*)::bigint,
    count(*) filter (where conv.converted)::bigint,
    round(100.0 * count(*) filter (where conv.converted) / nullif(count(*), 0), 1),
    coalesce(sum(c.value_cents) filter (where conv.converted), 0)::bigint
  from public.crm_contacts c
  cross join lateral (
    select public.crm_has_converted(c.id) as converted
  ) conv
  where c.organization_id = public.current_org_id()
    and c.created_at >= public.crm_day_start(p_from)
    and c.created_at < public.crm_day_start(p_to + 1)
    and c.channel is not null
    and c.channel <> ''
    and (p_channel is null or c.channel = p_channel)
  group by c.channel
  order by count(*) desc, c.channel;
$$;

-- ------------------------------------------------------------
-- VENDAS — fluxo por data da venda, independente de quando o lead entrou
-- ------------------------------------------------------------
create or replace function public.crm_report_sales(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null
)
returns table(
  sales               bigint,
  first_sales         bigint,
  repeat_sales        bigint,
  clients             bigint,
  creatives           bigint,
  revenue_cents       bigint,
  avg_ticket_cents    bigint,
  total_sales         bigint,
  total_revenue_cents bigint
)
language sql stable security definer set search_path = public as $$
  with todas as (
    select
      v.contact_id,
      v.sold_at,
      v.creatives,
      v.value_cents,
      row_number() over (
        partition by v.contact_id order by v.sold_at, v.created_at, v.id
      ) as seq
    from public.crm_sales v
    join public.crm_contacts c on c.id = v.contact_id
    where v.organization_id = public.current_org_id()
      and (p_channel is null or c.channel = p_channel)
  ),
  periodo as (
    select * from todas
    where todas.sold_at >= public.crm_day_start(p_from)
      and todas.sold_at < public.crm_day_start(p_to + 1)
  )
  select
    (select count(*) from periodo p)::bigint,
    (select count(*) from periodo p where p.seq = 1)::bigint,
    (select count(*) from periodo p where p.seq > 1)::bigint,
    (select count(distinct p.contact_id) from periodo p)::bigint,
    (select coalesce(sum(p.creatives), 0) from periodo p)::bigint,
    (select coalesce(sum(p.value_cents), 0) from periodo p)::bigint,
    (select (coalesce(sum(p.value_cents), 0) / nullif(count(*), 0))::bigint from periodo p),
    (select count(*) from todas t)::bigint,
    (select coalesce(sum(t.value_cents), 0) from todas t)::bigint;
$$;

create or replace function public.crm_report_sales_timeseries(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null
)
returns table(day date, sales bigint, revenue_cents bigint, creatives bigint)
language sql stable security definer set search_path = public as $$
  with dias as (
    -- ::timestamp explícito: com datas puras o Postgres escolheria a
    -- sobrecarga timestamptz e o ::date de volta passaria pelo fuso da
    -- sessão. Aqui a série é só rótulo de dia e não depende de fuso nenhum.
    select gs::date as day
    from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') gs
  ),
  vendas as (
    select
      (v.sold_at at time zone 'America/Sao_Paulo')::date as day,
      count(*) as sales,
      sum(v.value_cents) as revenue_cents,
      sum(v.creatives) as creatives
    from public.crm_sales v
    join public.crm_contacts c on c.id = v.contact_id
    where v.organization_id = public.current_org_id()
      and v.sold_at >= public.crm_day_start(p_from)
      and v.sold_at < public.crm_day_start(p_to + 1)
      and (p_channel is null or c.channel = p_channel)
    group by 1
  )
  select
    d.day,
    coalesce(v.sales, 0)::bigint,
    coalesce(v.revenue_cents, 0)::bigint,
    coalesce(v.creatives, 0)::bigint
  from dias d
  left join vendas v on v.day = d.day
  order by d.day;
$$;

create or replace function public.crm_report_sales_by_contact(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  p_limit int default 20
)
returns table(
  contact_id    uuid,
  name          text,
  channel       text,
  sales         bigint,
  creatives     bigint,
  revenue_cents bigint,
  first_sale_at timestamptz,
  last_sale_at  timestamptz
)
language sql stable security definer set search_path = public as $$
  select
    c.id,
    c.name,
    c.channel,
    count(*)::bigint,
    coalesce(sum(v.creatives), 0)::bigint,
    coalesce(sum(v.value_cents), 0)::bigint,
    min(v.sold_at),
    max(v.sold_at)
  from public.crm_sales v
  join public.crm_contacts c on c.id = v.contact_id
  where v.organization_id = public.current_org_id()
    and v.sold_at >= public.crm_day_start(p_from)
    and v.sold_at < public.crm_day_start(p_to + 1)
    and (p_channel is null or c.channel = p_channel)
  group by c.id, c.name, c.channel
  order by sum(v.value_cents) desc, count(*) desc, c.name
  limit greatest(p_limit, 1);
$$;

-- ------------------------------------------------------------
-- LEADS SEM ORIGEM — na janela e no acumulado
-- ------------------------------------------------------------
create or replace function public.crm_report_no_origem_by_stage(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null
)
returns table(
  stage_id       uuid,
  stage_name     text,
  stage_color    text,
  leads          bigint,
  leads_all_time bigint,
  value_cents    bigint
)
language sql stable security definer set search_path = public as $$
  select
    s.id,
    s.name,
    s.color,
    count(*) filter (
      where c.created_at >= public.crm_day_start(p_from)
        and c.created_at < public.crm_day_start(p_to + 1)
    )::bigint,
    count(*)::bigint,
    coalesce(sum(c.value_cents) filter (
      where c.created_at >= public.crm_day_start(p_from)
        and c.created_at < public.crm_day_start(p_to + 1)
    ), 0)::bigint
  from public.crm_contacts c
  left join public.crm_stages s on s.id = c.stage_id
  where c.organization_id = public.current_org_id()
    and (c.origem is null or btrim(c.origem) = '')
    and (p_channel is null or c.channel = p_channel)
  group by s.id, s.name, s.color
  order by 4 desc, 5 desc, s.name nulls last;
$$;

create or replace function public.crm_report_no_origem_list(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  p_limit int default 200
)
returns table(
  id          uuid,
  name        text,
  phone       text,
  channel     text,
  stage_id    uuid,
  stage_name  text,
  stage_color text,
  created_at  timestamptz,
  value_cents bigint
)
language sql stable security definer set search_path = public as $$
  select
    c.id,
    c.name,
    c.phone,
    c.channel,
    c.stage_id,
    s.name,
    s.color,
    c.created_at,
    c.value_cents
  from public.crm_contacts c
  left join public.crm_stages s on s.id = c.stage_id
  where c.organization_id = public.current_org_id()
    and (c.origem is null or btrim(c.origem) = '')
    and c.created_at >= public.crm_day_start(p_from)
    and c.created_at < public.crm_day_start(p_to + 1)
    and (p_channel is null or c.channel = p_channel)
  order by c.created_at desc
  limit greatest(p_limit, 1);
$$;
