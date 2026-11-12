-- ------------------------------------------------------------
-- LTV médio + ticket médio, no período e no histórico
--
-- Ticket médio e LTV respondem perguntas diferentes e só coincidem quando
-- ninguém recompra:
--
--   ticket médio = receita ÷ VENDAS     — quanto vale uma venda
--   LTV médio    = receita ÷ CLIENTES   — quanto vale conquistar um cliente
--
-- O segundo é o que se compara com o custo do anúncio. A 037 só calculava o
-- primeiro, e só do período — o que subestima qualquer cliente que recompre
-- fora da janela escolhida.
--
-- Uma ressalva que o número não carrega sozinho: "LTV histórico" aqui é a
-- receita já realizada por cliente, não uma projeção. Cliente novo ainda vai
-- comprar de novo, então a média puxa para baixo quanto mais leads recentes
-- entrarem. Serve para comparar com CAC, não para prever.
--
-- A conta vive em crm_sales_metrics(p_org, ...), com a organização explícita,
-- para servir aos dois chamadores sem duplicar SQL:
--   - o painel, por crm_report_sales(), que resolve a org pelo JWT;
--   - a crm-api (action "metrics"), que chega com service role e a org já
--     resolvida pela chave.
--
-- Repare que a core NÃO é security definer: a RLS de crm_sales/crm_contacts
-- continua valendo para quem chama com JWT, então passar o p_org de outra
-- organização não devolve nada. É o mesmo desenho de crm_contact_by_phone
-- (044) — a segurança não depende do argumento estar certo.
-- ------------------------------------------------------------

create or replace function public.crm_sales_metrics(
  p_org uuid,
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null
)
returns table(
  -- Período selecionado
  sales                 bigint,
  first_sales           bigint,
  repeat_sales          bigint,
  clients               bigint,
  creatives             bigint,
  revenue_cents         bigint,
  avg_ticket_cents      bigint,
  ltv_cents             bigint,
  -- Histórico completo (ignora p_from/p_to; respeita p_channel)
  total_sales           bigint,
  total_clients         bigint,
  total_revenue_cents   bigint,
  total_avg_ticket_cents bigint,
  total_ltv_cents       bigint
)
language sql stable set search_path = public as $$
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
    where v.organization_id = p_org
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
    -- ÷ vendas
    (select (coalesce(sum(p.value_cents), 0) / nullif(count(*), 0))::bigint from periodo p),
    -- ÷ clientes distintos. No período isto é "receita por cliente ativo na
    -- janela", não o LTV do cliente: quem comprou em janeiro e recomprou em
    -- julho conta como uma venda só se a janela for julho. O LTV de verdade é
    -- o total_ltv_cents abaixo.
    (select (coalesce(sum(p.value_cents), 0)
             / nullif(count(distinct p.contact_id), 0))::bigint from periodo p),
    (select count(*) from todas t)::bigint,
    (select count(distinct t.contact_id) from todas t)::bigint,
    (select coalesce(sum(t.value_cents), 0) from todas t)::bigint,
    (select (coalesce(sum(t.value_cents), 0) / nullif(count(*), 0))::bigint from todas t),
    (select (coalesce(sum(t.value_cents), 0)
             / nullif(count(distinct t.contact_id), 0))::bigint from todas t);
$$;

comment on function public.crm_sales_metrics(uuid, date, date, text) is
  'Totais de vendas da organização: período selecionado e histórico completo, '
  'com ticket médio (÷ vendas) e LTV médio (÷ clientes distintos) em ambas as '
  'janelas. Sem security definer de propósito — a RLS filtra por organização '
  'para quem chega com JWT, então p_org só tem efeito real sob service role.';

-- Fora do alcance de quem chega com JWT: o painel entra pelo wrapper abaixo,
-- que resolve a organização sozinho. Assim ninguém chama a core direto pelo
-- PostgREST passando um p_org qualquer — a RLS já barraria, mas o caminho
-- nem existe.
revoke all on function public.crm_sales_metrics(uuid, date, date, text) from public, anon, authenticated;

-- Explícito de propósito: o revoke acima derruba o EXECUTE herdado de PUBLIC,
-- e a crm-api (action "metrics") chega justamente como service_role. Sem esta
-- linha o endpoint dependeria do default privilege do Supabase continuar
-- existindo — e falharia com "permission denied" sem nenhuma pista do porquê.
grant execute on function public.crm_sales_metrics(uuid, date, date, text) to service_role;

-- ------------------------------------------------------------
-- O relatório do painel passa a ser um repasse da core. Os campos que já
-- existiam mantêm nome e significado — o frontend antigo continua lendo o
-- mesmo JSON — e os novos entram ao lado.
-- ------------------------------------------------------------

drop function if exists public.crm_report_sales(date, date, text);

create or replace function public.crm_report_sales(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null
)
returns table(
  sales                 bigint,
  first_sales           bigint,
  repeat_sales          bigint,
  clients               bigint,
  creatives             bigint,
  revenue_cents         bigint,
  avg_ticket_cents      bigint,
  ltv_cents             bigint,
  total_sales           bigint,
  total_clients         bigint,
  total_revenue_cents   bigint,
  total_avg_ticket_cents bigint,
  total_ltv_cents       bigint
)
language sql stable security definer set search_path = public as $$
  select * from public.crm_sales_metrics(public.current_org_id(), p_from, p_to, p_channel);
$$;

comment on function public.crm_report_sales(date, date, text) is
  'Topo do relatório de vendas do painel. Repassa crm_sales_metrics com a '
  'organização do usuário autenticado.';
