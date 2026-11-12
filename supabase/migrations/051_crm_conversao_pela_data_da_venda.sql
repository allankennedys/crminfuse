-- ------------------------------------------------------------
-- Conversão vale pela data da VENDA, não pela do cadastro
--
-- Até aqui a janela de fluxo (048/049) usava min(crm_stage_history.created_at):
-- o instante em que o contato ENTROU na etapa de conversão. Isso é a hora em
-- que alguém digitou, não a hora em que o negócio fechou.
--
-- O caso real que motivou a mudança: em 30/07 foram cadastradas vendas que
-- aconteceram em 24 e 25/07. O relatório de Vendas (por sold_at) as pôs nos
-- dias certos; o funil contou as três como conversões do dia 30 — R$ 1.314,01
-- que apareciam num dia e não no outro, na mesma tela.
--
-- Agora a data da conversão é o sold_at da PRIMEIRA venda do contato, com a
-- entrada na etapa como reserva para quem não tem venda registrada (contato
-- movido para a etapa sem valor, por exemplo). Os dois relatórios passam a
-- falar do mesmo dia.
--
-- POR QUE min(sold_at) É A VENDA CERTA
--
-- "Primeira venda" em todo o resto do sistema é a menor por
-- (sold_at, created_at, id) — 031. min(sold_at) é a mesma linha, e é dela que
-- vem o value_cents que este relatório soma. Contas e datas ficam na mesma
-- venda, não em duas diferentes.
--
-- O QUE AINDA NÃO BATE COM A ABA VENDAS, DE PROPÓSITO
--
-- Aqui só entra a PRIMEIRA venda de cada cliente: é ela que representa a
-- conversão (a Meta recebe uma compra por contato, 028). A aba Vendas soma
-- TODAS, inclusive recompra. Com recompra no período, o total de lá é maior —
-- e essa diferença é a resposta certa, não um descolamento.
--
-- Assinatura idêntica à da 049: create or replace substitui no lugar.
-- ------------------------------------------------------------

create or replace function public.crm_report_conversions_in_period(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null
)
returns table(
  conversions             bigint,
  from_older_leads        bigint,
  revenue_cents           bigint,
  revenue_older_cents     bigint
)
language sql stable security definer set search_path = public as $$
  with primeira_conversao as (
    select
      h.contact_id,
      -- Continua sendo o histórico que diz QUEM converteu e uma vez só na
      -- vida; o que muda é só o relógio usado para datar a conversão.
      min(h.created_at)  as registrado_em,
      min(c.created_at)  as lead_criado_em,
      min(c.value_cents) as value_cents
    from public.crm_stage_history h
    join public.crm_stages s on s.id = h.to_stage_id
    join public.crm_contacts c on c.id = h.contact_id
    where s.is_conversion
      and c.organization_id = public.current_org_id()
      and (p_channel is null or c.channel = p_channel)
    group by h.contact_id
  ),
  datada as (
    select
      pc.*,
      coalesce(
        (select min(v.sold_at) from public.crm_sales v where v.contact_id = pc.contact_id),
        pc.registrado_em
      ) as convertido_em
    from primeira_conversao pc
  ),
  na_janela as (
    select * from datada d
    where d.convertido_em >= public.crm_day_start(p_from)
      and d.convertido_em < public.crm_day_start(p_to + 1)
  )
  select
    count(*)::bigint,
    count(*) filter (where n.lead_criado_em < public.crm_day_start(p_from))::bigint,
    coalesce(sum(n.value_cents), 0)::bigint,
    coalesce(sum(n.value_cents)
      filter (where n.lead_criado_em < public.crm_day_start(p_from)), 0)::bigint
  from na_janela n;
$$;

comment on function public.crm_report_conversions_in_period(date, date, text) is
  'Conversões e valor convertido na janela, pela data da VENDA (sold_at da 1ª '
  'venda; a entrada na etapa é a reserva de quem não tem venda). Independe de '
  'quando o lead entrou, e cada cliente conta uma vez. As colunas _older dizem '
  'quanto veio de leads criados antes da janela.';

-- Sem índice novo: idx_crm_sales_contact (031) é (contact_id, sold_at, ...),
-- exatamente o que o subselect min(sold_at) por contato precisa.
