-- ============================================================
-- O degrau passa a contar quem ENTROU nele, não quem chegou àquela altura
--
-- Desde a 063 a escada era cumulativa: `reached` de um degrau contava todo
-- lead cuja altura máxima fosse igual ou maior. A leitura oficial era "cada
-- degrau inclui quem passou dele", e ela só é verdade num funil em que
-- ninguém pula etapa.
--
-- A OPERAÇÃO PULA ETAPA, E ISSO QUEBRAVA O NÚMERO
--
-- Medido em 07/09/2026, coorte de 7 dias, 236 leads:
--
--   Novo lead          reached 236   entraram de fato 232
--   Qualificado        reached  47   entraram de fato   5
--   Orçamento Enviado  reached  42   entraram de fato  30
--   Convertido         reached  19   entraram de fato  19
--
-- Qualificado marcava 47 porque 42 leads chegaram a Orçamento ou Convertido
-- SEM NUNCA terem entrado na coluna Qualificado — o time move de Novo lead
-- direto para Orçamento. O cumulativo inferia "passou pela qualificação" a
-- partir de "chegou mais longe", e aqui essa inferência é falsa.
--
-- O efeito no relatório era pior que um número inchado: a queda de
-- Qualificado para Orçamento aparecia como 47 → 42, uns 11%, que em português
-- é "a qualificação converte quase tudo". Só 5 pessoas foram qualificadas.
--
-- A REGRA NOVA
--
--   reached  = quantos leads da coorte ENTRARAM naquela etapa no período.
--              Sem inferência: se não há linha em crm_stage_history apontando
--              para a etapa, o lead não passou por ela.
--
-- A SÉRIE DEIXA DE CAIR SOZINHA, E É PARA DEIXAR
--
-- Com os números acima ela vira 232, 5, 30, 19 — sobe do Qualificado para o
-- Orçamento. Não é anomalia de cálculo: é o retrato de uma coluna que o time
-- não usa. Achatar isso para caber numa escada descendente era exatamente o
-- que o cumulativo fazia.
--
-- `dropped` PRECISOU MUDAR DE DEFINIÇÃO JUNTO
--
-- Era `reached − reached_do_próximo`. Sem o cumulativo essa subtração dá
-- negativo (5 − 30 = −25) e não descreve queda nenhuma. A definição nova é
-- por lead, não por subtração:
--
--   dropped = entrou nesta etapa e NÃO entrou em nenhuma etapa posterior
--
-- É o que a tela sempre escreveu ("N pararam aqui") e agora é o que o número
-- de fato mede. Nunca é negativo, e é imune a pulo: quem vai de Qualificado
-- direto para Convertido não conta como parado no Qualificado.
--
-- É a mesma escolha que a régua de remarketing já tinha feito (`RmktStep`
-- conta pelo último disparo de cada lead, não pela diferença entre degraus,
-- justamente porque a régua tem buracos).
--
-- NULO no último degrau da corrente: não há etapa posterior, então "não
-- avançou" não é queda — é a conversão.
--
-- O QUE NÃO MUDA
--
--   Portfólio  continua fora da corrente e continua contando só quem tem a
--              etiqueta (084). Não era cumulativo antes e não é agora.
--   Tempo médio  já era por degrau, calculado sobre quem entrou nele.
--
-- `from_tag` acompanha a virada: passa a ser quantos etiquetados não
-- ENTRARAM no degrau anterior (antes era "não chegaram àquela altura").
--
-- Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

do $$
begin
  if to_regprocedure('public.crm_report_journey_stage_flow(date, date, text, text, jsonb)') is null then
    raise exception 'Aplique as migrations 083 e 084 antes desta';
  end if;
end $$;

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
  alcance as (
    select p.id, max(p.degrau) as max_degrau from pisadas p group by p.id
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
      case when d.fonte = 'crm' and d.degrau < (select u.degrau from ultimo_crm u) then (
        select count(*)::bigint
        from pisadas p
        join alcance a on a.id = p.id
        where p.degrau = d.degrau and a.max_degrau = d.degrau
      ) end as parados,
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

comment on function public.crm_report_journey_stage_flow(date, date, text, text, jsonb) is
  'Degraus do funil na ordem. NÃO é cumulativo (087): reached conta quem '
  'ENTROU naquela etapa, então a série pode subir quando o time pula uma '
  'coluna — e isso é o dado, não erro. dropped = entrou aqui e não entrou em '
  'nenhuma etapa posterior; nulo no Portfólio (fora da corrente) e no último '
  'degrau, onde não avançar é converter.';
