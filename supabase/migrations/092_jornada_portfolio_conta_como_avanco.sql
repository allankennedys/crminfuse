-- ============================================================
-- Quem recebeu o portfólio não conta como parado antes dele
--
-- Até a 087, "parou nesta etapa" era: entrou nela e não entrou em nenhuma
-- etapa POSTERIOR DO KANBAN. O portfólio não é coluna do kanban, então o
-- lead que continuava em Novo lead mas já tinha recebido o portfólio (091)
-- aparecia como parado em Novo lead — o pedido de 11/09/2026 foi que ele
-- não aparecesse.
--
-- A REGRA NOVA
--
-- O portfólio conta como avanço na altura dele (logo depois da etapa de
-- triagem). Quem o recebeu:
--   • deixa de ser parado em qualquer etapa ANTES dele (Novo lead,
--     Qualificado);
--   • passa a ser parado NO PORTFÓLIO, se não entrou em nenhuma etapa do CRM
--     depois dele. Sem isso essa gente sumiria da conta de perdas, e o card
--     de maior perda mostraria um funil que não vaza onde vaza.
--
-- O que NÃO muda: quantos chegaram em cada degrau (continua não cumulativo,
-- 087), o degrau do portfólio contado pela lista que o frontend manda
-- (p_portfolio, hoje vinda da tabela da 091), e o último degrau do CRM, onde
-- "não avançou" é conversão.
--
-- Corpo idêntico ao da 087 — a última versão, conferida com
--   grep -ln "function public.crm_report_journey_stage_flow(" ... | sort
-- — fora o CTE `alcance` e o `parados` do degrau do portfólio.
--
-- ORDEM DE DEPLOY: só esta migration; o frontend já desenha o "pararam" do
-- portfólio quando ele vem preenchido. Aplicar pelo SQL Editor. Nunca por
-- db push.
-- ============================================================

create or replace function public.crm_report_journey_stage_flow(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  p_origem text default null,
  p_portfolio jsonb default '[]'::jsonb
)
returns table(
  stage_id           uuid,
  stage_name         text,
  color              text,
  ord                int,
  is_conversion      boolean,
  -- Quantos ENTRARAM nesta etapa. Não inclui quem passou direto para uma
  -- etapa posterior sem tocar nesta.
  reached            bigint,
  -- Quantos entraram aqui e não entraram em nenhuma etapa posterior.
  -- Nulo no degrau do Portfólio (fora da corrente) e no último da corrente.
  dropped            bigint,
  drop_rate          numeric,
  avg_hours_to_reach numeric,
  source             text,
  from_tag           bigint
)
language sql stable security definer set search_path = public, extensions as $$
  with escada_crm as (
    select
      s.id            as etapa_id,
      s.name          as nome,
      s.color         as cor,
      s.is_conversion as conv,
      s.journey_role  as papel,
      row_number() over (order by s.is_conversion, s.position, s.created_at) as pos
    from public.crm_stages s
    where s.organization_id = public.current_org_id()
      and coalesce(s.journey_role, '') not in ('perdido', 'remarketing')
  ),
  ancora as (
    select min(e.pos) as pos from escada_crm e where e.papel = 'triagem'
  ),
  escada as (
    select e.etapa_id, e.nome, e.cor, e.conv, e.pos::numeric as pos, 'crm'::text as fonte
    from escada_crm e
    union all
    select
      null::uuid, 'Portfólio'::text, '#a855f7'::text, false,
      (select a.pos from ancora a) + 0.5, 'etiqueta'::text
    where (select a.pos from ancora a) is not null
  ),
  degraus as (
    select
      d.etapa_id, d.nome, d.cor, d.conv, d.fonte,
      row_number() over (order by d.pos)::int as degrau
    from escada d
  ),
  degrau_tag as (
    select d.degrau as altura from degraus d where d.fonte = 'etiqueta'
  ),
  -- O último degrau da corrente do CRM: lá "não avançou" é conversão, não queda.
  ultimo_crm as (
    select max(d.degrau) as degrau from degraus d where d.fonte = 'crm'
  ),
  coorte as (
    select c.id, c.created_at, c.phone
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and c.created_at >= public.crm_day_start(p_from)
      and c.created_at < public.crm_day_start(p_to + 1)
      and (p_channel is null or c.channel = p_channel)
      and (p_origem is null or lower(extensions.unaccent(c.origem)) = lower(extensions.unaccent(p_origem)))
  ),
  etiquetados as (
    select distinct public.crm_phone_id(t.n) as num_id
    from jsonb_array_elements_text(coalesce(p_portfolio, '[]'::jsonb)) as t(n)
    where public.crm_phone_id(t.n) is not null
  ),
  com_etiqueta as (
    select distinct co.id
    from coorte co
    join etiquetados e on e.num_id = public.crm_phone_id(co.phone)
    where co.phone is not null
  ),
  pisadas as (
    select co.id, co.created_at, d.degrau, min(h.created_at) as chegou_em
    from coorte co
    join public.crm_stage_history h on h.contact_id = co.id
    join degraus d on d.etapa_id = h.to_stage_id
    group by co.id, co.created_at, d.degrau
  ),
  -- Continua existindo, mas agora só para responder "foi além daqui?".
  -- Quem recebeu o portfólio chegou pelo menos à altura dele (092): ele
  -- conta como avanço, e o lead deixa de ser "parado" em Novo lead ou em
  -- Qualificado. Sem âncora de triagem não há degrau do portfólio, a altura
  -- é nula e o max a ignora.
  alcance as (
    select x.id, max(x.degrau) as max_degrau
    from (
      select p.id, p.degrau from pisadas p
      union all
      select ce.id, (select dt.altura from degrau_tag dt) from com_etiqueta ce
    ) x
    group by x.id
  ),
  medido as (
    select
      d.*,
      case
        when d.fonte = 'etiqueta'
          then (select count(*) from com_etiqueta)::bigint
        -- A virada: conta quem ENTROU neste degrau, e mais ninguém.
        else (select count(distinct p.id) from pisadas p where p.degrau = d.degrau)::bigint
      end as alcancados,
      -- Parou aqui: entrou neste degrau e nenhum degrau posterior. Como o
      -- lead entrou neste, seu max_degrau nunca é menor — a igualdade já diz
      -- "este foi o mais longe que ele foi".
      case
        when d.fonte = 'crm' and d.degrau < (select u.degrau from ultimo_crm u) then (
          select count(*)::bigint
          from pisadas p
          join alcance a on a.id = p.id
          where p.degrau = d.degrau and a.max_degrau = d.degrau
        )
        -- O portfólio também tem quem parou nele (092): recebeu e não entrou
        -- em nenhuma etapa do CRM depois dele. É para onde vai quem deixou
        -- de ser "parado em Novo lead" — sem isto essa gente sumiria da conta
        -- de perdas.
        when d.fonte = 'etiqueta' and d.degrau < (select u.degrau from ultimo_crm u) then (
          select count(*)::bigint
          from com_etiqueta ce
          join alcance a on a.id = ce.id
          where a.max_degrau = d.degrau
        )
      end as parados,
      case when d.fonte = 'crm' then (
        select round(avg(extract(epoch from (p.chegou_em - p.created_at)) / 3600.0)::numeric, 1)
        from pisadas p where p.degrau = d.degrau
      ) end as horas,
      -- Etiquetados que não ENTRARAM no degrau anterior da corrente.
      case when d.fonte = 'etiqueta' then (
        select count(*)::bigint from com_etiqueta ce
        where not exists (
          select 1 from pisadas p
          where p.id = ce.id
            and p.degrau = (select dt.altura from degrau_tag dt) - 1
        )
      ) end as vindos
    from degraus d
  )
  select
    m.etapa_id,
    m.nome,
    m.cor,
    m.degrau,
    m.conv,
    m.alcancados,
    m.parados,
    case when m.parados is not null
      then round(100.0 * m.parados / nullif(m.alcancados, 0), 1) end,
    m.horas,
    m.fonte,
    m.vindos
  from medido m
  order by m.degrau;
$$;

