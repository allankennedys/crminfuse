-- ------------------------------------------------------------
-- Valor convertido no período (fluxo), junto das conversões
--
-- A 048 respondeu "quantas conversões aconteceram nesta janela". Faltava o
-- dinheiro: "Receita convertida" no funil é coorte — soma o valor dos leads
-- CRIADOS na janela que fecharam. Quem entrou em maio e fechou em julho não
-- aparece em julho, então o mês nunca fecha com o caixa.
--
-- Aqui a soma segue a mesma população da 048: contatos cuja PRIMEIRA conversão
-- caiu na janela, venha o lead de quando vier. Como cada contato entra uma vez
-- só, o valor dele também é somado uma vez — reentrar na etapa de conversão
-- não soma de novo.
--
-- O valor é o value_cents do contato, a mesma base da receita de coorte
-- (crm_report_overview), para os dois cards serem comparáveis. Quem quer o
-- valor por data da VENDA continua no relatório de vendas (037).
--
-- Assinatura nova = DROP antes do CREATE: acrescentar colunas ao returns table
-- não é substituição, o Postgres recusaria o replace.
-- ------------------------------------------------------------

drop function if exists public.crm_report_conversions_in_period(date, date, text);

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
      min(h.created_at) as convertido_em,
      min(c.created_at) as lead_criado_em,
      min(c.value_cents) as value_cents
    from public.crm_stage_history h
    join public.crm_stages s on s.id = h.to_stage_id
    join public.crm_contacts c on c.id = h.contact_id
    where s.is_conversion
      and c.organization_id = public.current_org_id()
      and (p_channel is null or c.channel = p_channel)
    group by h.contact_id
  ),
  na_janela as (
    select * from primeira_conversao pc
    where pc.convertido_em >= public.crm_day_start(p_from)
      and pc.convertido_em < public.crm_day_start(p_to + 1)
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
  'Conversões e valor convertido na janela, independentemente de quando o lead '
  'entrou (fluxo). Cada cliente conta uma vez, na primeira conversão da vida '
  'dele. As colunas _older dizem quanto veio de leads criados antes da janela '
  '— é a diferença para os cards de coorte "Convertidos" e "Receita '
  'convertida", que só olham quem foi criado no período.';
