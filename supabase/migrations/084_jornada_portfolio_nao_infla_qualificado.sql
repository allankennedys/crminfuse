-- ============================================================
-- O degrau do Portfólio para de contar como se fosse etapa cumprida
--
-- A 083 pôs o portfólio na conta de ALTURA do lead: quem tinha a etiqueta
-- passava a contar em todo degrau até ali, inclusive no Qualificado. A
-- intenção era manter a escada caindo sozinha, e o efeito foi mentir:
-- ontem 7 leads receberam o portfólio sem nunca terem entrado na coluna
-- Qualificado, e o Qualificado marcou 8 em vez de 1.
--
-- A REGRA
--
-- Não precisa ter passado pelo Qualificado para aparecer no Portfólio — mas
-- não pode ser contado como se tivesse passado. As duas coisas ao mesmo
-- tempo só cabem se o Portfólio SAIR da corrente:
--
--   corrente do funil : Novo lead → Qualificado → Orçamento → Ganho
--                       (só o CRM, cumulativa, como era antes da 083)
--   Portfólio         : marcador na posição pedida, contado sozinho
--                       (quem tem a etiqueta, e mais ninguém)
--
-- O QUE ISSO MUDA EM CADA NÚMERO
--
--   Degrau de CRM  reached = quantos chegaram àquela altura no CRM. Volta a
--                  ser exatamente o que a 063 calculava: a etiqueta não
--                  mexe mais nisso.
--   Portfólio      reached = quantos têm a etiqueta. Não inclui quem está
--                  mais adiante no funil sem a etiqueta: quem não recebeu o
--                  portfólio não recebeu, esteja onde estiver.
--   dropped        só existe entre dois degraus de CRM VIZINHOS na corrente
--                  — o Portfólio é pulado. No degrau do Portfólio é NULO,
--                  porque subtrair um número de fonte diferente do vizinho
--                  não descreve queda nenhuma.
--
-- A SÉRIE PODE SUBIR NO PORTFÓLIO, E ISSO É O DADO
--
-- Qualificado 1 e Portfólio 7 é o retrato de uma coluna do kanban que o time
-- não está usando enquanto o bot manda portfólio. Achatar isso para caber
-- numa escada descendente era o que a 083 fazia de errado.
--
-- `from_tag` muda de sentido: passa a ser quantos dos etiquetados NÃO
-- chegaram ao degrau anterior da corrente. É o número que responde "quantos
-- receberam o portfólio pulando a qualificação".
-- ============================================================

do $$
begin
  if to_regprocedure('public.crm_report_journey_stage_flow(date, date, text, text, jsonb)') is null then
    raise exception 'Aplique a migration 083 antes desta';
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
  reached            bigint,
  -- Nulo no degrau do Portfólio: ele não está na corrente, então não há
  -- queda dele para o seguinte.
  dropped            bigint,
  drop_rate          numeric,
  avg_hours_to_reach numeric,
  source             text,
  -- Só no degrau do Portfólio: quantos receberam a etiqueta sem terem
  -- chegado ao degrau anterior da corrente (pularam a qualificação).
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
  -- SÓ o CRM. A etiqueta não entra mais aqui: era isto que inflava os
  -- degraus de baixo.
  alcance as (
    select p.id, max(p.degrau) as max_degrau from pisadas p group by p.id
  ),
  medido as (
    select
      d.*,
      case
        when d.fonte = 'etiqueta'
          then (select count(*) from com_etiqueta)::bigint
        else (select count(*) from alcance a where a.max_degrau >= d.degrau)::bigint
      end as alcancados,
      case when d.fonte = 'crm' then (
        select round(avg(extract(epoch from (p.chegou_em - p.created_at)) / 3600.0)::numeric, 1)
        from pisadas p where p.degrau = d.degrau
      ) end as horas,
      case when d.fonte = 'etiqueta' then (
        select count(*)::bigint from com_etiqueta ce
        where coalesce((select max(p.degrau) from pisadas p where p.id = ce.id), 0)
            < (select dt.altura from degrau_tag dt) - 1
      ) end as vindos
    from degraus d
  ),
  -- A corrente pula o degrau da etiqueta: o "seguinte" de um degrau de CRM
  -- é o próximo degrau de CRM, não o marcador que estiver no meio.
  encadeado as (
    select
      m.*,
      case when m.fonte = 'crm'
        then lead(m.alcancados) over (partition by (m.fonte = 'crm') order by m.degrau)
      end as proximo
    from medido m
  )
  select
    e.etapa_id,
    e.nome,
    e.cor,
    e.degrau,
    e.conv,
    e.alcancados,
    case when e.fonte = 'crm'
      then (e.alcancados - coalesce(e.proximo, e.alcancados))::bigint
    end,
    case when e.fonte = 'crm' then round(
      100.0 * (e.alcancados - coalesce(e.proximo, e.alcancados)) / nullif(e.alcancados, 0), 1
    ) end,
    e.horas,
    e.fonte,
    e.vindos
  from encadeado e
  order by e.degrau;
$$;

comment on function public.crm_report_journey_stage_flow(date, date, text, text, jsonb) is
  'Degraus do funil na ordem. A corrente é só do CRM (Novo lead → … → Ganho) '
  'e é cumulativa: cada degrau inclui quem passou dele. O degrau "Portfólio" '
  '(source = etiqueta) NÃO está na corrente: conta apenas quem tem a '
  'etiqueta, não infla os degraus de baixo e não tem queda — receber o '
  'portfólio não é ter passado pela qualificação.';
