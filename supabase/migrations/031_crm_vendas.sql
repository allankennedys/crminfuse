-- ============================================================
-- Vendas por contato — várias por cliente, uma só conversão
--
-- Até aqui o contato tinha UM value_cents e a conversão era a entrada na
-- etapa marcada como is_conversion. Recompra não era representável: a
-- migration 028 fechou a porta do segundo evento justamente porque o
-- modelo não sabia distinguir "voltou pra etapa" de "comprou de novo".
--
-- Agora cada contato tem N vendas (crm_sales), com quantidade de criativos
-- e valor. A regra do produto:
--
--   • A PRIMEIRA venda do cliente entra no funil de conversão — o contato
--     é movido para a etapa de conversão, o que dispara o histórico e o
--     evento na Meta pelos triggers que já existem (013/020/028).
--   • As DEMAIS vendas só ficam registradas no contato. Nenhum movimento
--     de etapa, nenhum evento na Meta — recompra não é aquisição, e mandar
--     de novo inflaria a atribuição do anúncio.
--
-- ONDE CADA VALOR VIVE
--
--   crm_contacts.value_cents      = valor da PRIMEIRA venda. É o que a Meta
--                                   recebe e o que os relatórios de
--                                   conversão (016/023/025) somam. Sentido
--                                   inalterado: "quanto valeu a conversão".
--   crm_contacts.sales_total_cents = soma de TODAS as vendas do cliente.
--   crm_contacts.sales_count       = quantas vendas o cliente tem.
--
-- Os dois últimos são desnormalizados por trigger para o kanban e a lista
-- de contatos não precisarem de subconsulta por linha. A verdade continua
-- sendo crm_sales; quem soma é sempre a trigger, nunca o app.
--
-- RELATÓRIO DE VENDAS (funções crm_report_sales*)
--
-- Diferente dos relatórios de conversão, que são de COORTE por criação do
-- lead: aqui é FLUXO por data da venda (sold_at). "Vendi R$ X no período",
-- somando 1ª venda e recompra, com a quebra entre as duas para não
-- confundir aquisição com faturamento.
-- ============================================================

-- ------------------------------------------------------------
-- TABELA
-- ------------------------------------------------------------
create table public.crm_sales (
  id uuid primary key default uuid_generate_v4(),
  -- Redundante com o contato de propósito: RLS e os índices de relatório
  -- filtram por org sem precisar de join. Quem preenche é a trigger de
  -- stamp abaixo, copiando do contato — o cliente não escolhe a org.
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade,
  -- Quantidade de criativos vendidos. 0 = não informado (é o caso das
  -- vendas importadas do value_cents antigo, que não tinham essa medida).
  creatives int not null default 0 check (creatives >= 0),
  value_cents bigint not null default 0 check (value_cents >= 0),
  -- Quando a venda aconteceu — editável, para lançar venda de ontem. É
  -- esta data (não created_at) que define o período dos relatórios e a
  -- ordem que decide qual venda é a primeira.
  sold_at timestamptz not null default now(),
  note text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Ordem canônica da "primeira venda": sold_at, com created_at e id como
-- desempate para o resultado ser estável quando duas vendas têm a mesma
-- data. A mesma tupla é usada na trigger e nos relatórios.
create index idx_crm_sales_contact on public.crm_sales(contact_id, sold_at, created_at, id);
create index idx_crm_sales_org on public.crm_sales(organization_id, sold_at desc);

-- ------------------------------------------------------------
-- TOTAIS NO CONTATO
-- ------------------------------------------------------------
alter table public.crm_contacts
  add column if not exists sales_count int not null default 0,
  add column if not exists sales_total_cents bigint not null default 0;

comment on column public.crm_contacts.value_cents is
  'Valor da primeira venda (a que vira conversão). Mantido pela trigger '
  'crm_sales_sync quando o contato tem vendas registradas.';
comment on column public.crm_contacts.sales_total_cents is
  'Soma de todas as vendas do contato, incluindo recompras.';

-- ------------------------------------------------------------
-- IMPORTAÇÃO DO HISTÓRICO
--
-- Contato que JÁ converteu e tem valor virou uma venda: sem isto o
-- relatório de vendas nasceria vazio e a receita histórica só existiria
-- nos relatórios de conversão. Só converteu entra — valor em contato que
-- não converteu é negócio em aberto (expectativa), não venda.
--
-- creatives = 0 porque essa informação não existia. sold_at = data da
-- primeira entrada na etapa de conversão, que é quando a venda de fato
-- aconteceu.
--
-- Roda ANTES de criar as triggers de propósito: a trigger de sincronia
-- moveria esses contatos de volta para a etapa de conversão, desfazendo o
-- arquivamento da migration 030.
-- ------------------------------------------------------------
insert into public.crm_sales (organization_id, contact_id, creatives, value_cents, sold_at, note)
select
  c.organization_id,
  c.id,
  0,
  c.value_cents,
  coalesce(
    (
      select min(h.created_at)
      from public.crm_stage_history h
      join public.crm_stages s on s.id = h.to_stage_id
      where h.contact_id = c.id and s.is_conversion
    ),
    c.updated_at
  ),
  'Importada do valor do contato (antes do registro de vendas)'
from public.crm_contacts c
where c.value_cents > 0
  and public.crm_has_converted(c.id)
  and not exists (select 1 from public.crm_sales v where v.contact_id = c.id);

update public.crm_contacts c set
  sales_count = t.n,
  sales_total_cents = t.total
from (
  select contact_id, count(*)::int as n, sum(value_cents)::bigint as total
  from public.crm_sales
  group by contact_id
) t
where t.contact_id = c.id;

-- ------------------------------------------------------------
-- TRIGGER 1 (BEFORE): carimbo e invariantes
-- ------------------------------------------------------------
create or replace function public.crm_sales_stamp()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  -- Trocar o contato de uma venda deixaria os totais do contato antigo
  -- errados (a trigger de sincronia só recalcula um contato por linha).
  -- Não existe caso de uso: exclua a venda e lance no contato certo.
  if tg_op = 'UPDATE' and new.contact_id is distinct from old.contact_id then
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

create trigger crm_sales_stamp
  before insert or update on public.crm_sales
  for each row execute function public.crm_sales_stamp();

-- ------------------------------------------------------------
-- TRIGGER 2 (AFTER): totais do contato + entrada no funil
--
-- Fonte única da regra "só a primeira venda converte". Ficando no banco,
-- vale para a tela, para o SQL manual e para qualquer automação futura —
-- do mesmo jeito que a mudança de etapa é capturada por trigger (013).
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
  -- Meta (e a 028 garante um evento por contato, nunca dois).
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

  return null;
end;
$$;

create trigger crm_sales_sync
  after insert or update or delete on public.crm_sales
  for each row execute function public.crm_sales_sync_contact();

-- ------------------------------------------------------------
-- RLS — mesmo padrão do resto do CRM (013/018)
--
-- Diferença deliberada: o papel entra também no with check, não só no
-- using. Em INSERT o Postgres só avalia o with check, então sem isto um
-- usuário de leitura conseguiria lançar venda.
-- ------------------------------------------------------------
alter table public.crm_sales enable row level security;

create policy crm_sales_select on public.crm_sales
  for select using (organization_id = public.current_org_id());

create policy crm_sales_write on public.crm_sales
  for all using (
    organization_id = public.current_org_id()
    and public.current_user_role() in ('admin', 'operator', 'crm_only')
  )
  with check (
    organization_id = public.current_org_id()
    and public.current_user_role() in ('admin', 'operator', 'crm_only')
  );

-- ------------------------------------------------------------
-- RELATÓRIO: visão geral de vendas
--
-- Devolve o período selecionado E o total de todo o histórico na mesma
-- linha — o topo do relatório mostra os dois sem uma segunda chamada.
--
-- seq = posição da venda na vida do cliente, calculada sobre TODAS as
-- vendas dele (não só as do período). Assim uma recompra em julho conta
-- como recompra mesmo que a 1ª venda tenha sido em janeiro, fora do filtro.
-- ------------------------------------------------------------
create or replace function public.crm_report_sales(
  days int default 30,
  p_channel text default null
)
returns table(
  sales               bigint,   -- vendas no período
  first_sales         bigint,   -- ... que foram a 1ª do cliente (converteram)
  repeat_sales        bigint,   -- ... que foram recompra
  clients             bigint,   -- clientes distintos que compraram no período
  creatives           bigint,   -- criativos vendidos no período
  revenue_cents       bigint,   -- faturamento do período
  avg_ticket_cents    bigint,   -- ticket médio por venda no período
  total_sales         bigint,   -- histórico completo, sem filtro de período
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
    where todas.sold_at >= now() - make_interval(days => days)
  )
  -- Colunas sempre qualificadas (p./t.): os nomes declarados no returns
  -- table são visíveis aqui e sem o prefixo a referência ficaria ambígua.
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

-- ------------------------------------------------------------
-- RELATÓRIO: vendas por dia
--
-- Série completa (dia sem venda vira zero), datas em America/Sao_Paulo
-- para bater com o "hoje" do usuário — igual à série de leads (016).
-- ------------------------------------------------------------
create or replace function public.crm_report_sales_timeseries(
  days int default 30,
  p_channel text default null
)
returns table(day date, sales bigint, revenue_cents bigint, creatives bigint)
language sql stable security definer set search_path = public as $$
  with dias as (
    select gs::date as day
    from generate_series(
      (now() at time zone 'America/Sao_Paulo')::date - (days - 1),
      (now() at time zone 'America/Sao_Paulo')::date,
      interval '1 day'
    ) gs
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

-- ------------------------------------------------------------
-- RELATÓRIO: vendas por cliente (quem mais comprou no período)
-- ------------------------------------------------------------
create or replace function public.crm_report_sales_by_contact(
  days int default 30,
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
    and v.sold_at >= now() - make_interval(days => days)
    and (p_channel is null or c.channel = p_channel)
  group by c.id, c.name, c.channel
  order by sum(v.value_cents) desc, count(*) desc, c.name
  limit greatest(p_limit, 1);
$$;
