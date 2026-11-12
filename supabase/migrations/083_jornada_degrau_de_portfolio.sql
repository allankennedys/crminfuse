-- ============================================================
-- O degrau do Portfólio, que existe só no relatório
--
-- O funil da aba Jornada é montado a partir das colunas do kanban (060/063).
-- O pedido aqui é outro: mostrar "recebeu o portfólio" como degrau, DEPOIS
-- da qualificação, sem que isso vire coluna no kanban e sem mover contato
-- nenhum de etapa. Card no lugar, `stage_id` intocado.
--
-- DE ONDE VEM O SINAL
--
-- Não do CRM: aqui não existe campo nenhum que diga "portfólio enviado".
-- Quem sabe disso é a etiqueta da conversa, que vive no Supabase do bot
-- (`etapas_phcreative`). Dois bancos não fazem JOIN, então o caminho é o
-- mesmo que a fila de recuperação já usa: o frontend lê e classifica as
-- etiquetas lá, e manda para cá a lista de NÚMEROS que chegaram ao
-- portfólio. Este arquivo casa esses números com os contatos por telefone.
--
-- POR QUE NÃO PRECISA SER QUALIFICADO PARA APARECER NO DEGRAU
--
-- A escada nunca mediu "passou por todas as etapas": ela mede ATÉ ONDE o
-- lead chegou (`max_ord >= ord`, o mesmo cálculo da 063). Então o degrau do
-- portfólio entra na conta de altura junto com o histórico do CRM:
--
--   altura do lead = maior entre (último degrau que ele pisou no CRM)
--                                (a altura do Portfólio, se tem a etiqueta)
--
-- Quem recebeu o portfólio sem nunca ter sido qualificado passa a contar em
-- Qualificado também — não porque foi qualificado, mas porque chegou pelo
-- menos àquela altura. É a mesma leitura que o card já anuncia ("cada degrau
-- inclui quem passou dele"). E, como a altura é UM número por lead, a série
-- continua caindo sozinha: não há como o Portfólio ficar maior que o degrau
-- de baixo nem gerar queda negativa.
--
-- ONDE O DEGRAU ENTRA, E POR QUE NÃO PELO NOME
--
-- Depois da etapa marcada com `journey_role = 'triagem'` — que a tela chama
-- de "Triagem (qualificação pela IA)". Procurar uma coluna chamada
-- "Qualificado" quebraria calado no dia em que alguém renomeasse ou tirasse
-- o acento, que é a razão de o papel existir. Sem nenhuma etapa com esse
-- papel não há "depois do qualificado": o degrau simplesmente não aparece, e
-- o relatório já avisa em cima que falta configurar o papel.
--
-- O QUE ESTE DEGRAU NÃO TEM
--
-- Tempo médio até chegar. A tabela de etiquetas guarda um `updated_at` da
-- linha inteira, não um carimbo por etiqueta — não dá para saber QUANDO o
-- portfólio foi enviado. Fica nulo, e a tela mostra vazio em vez de um
-- número inventado.
--
-- COMPATIBILIDADE
--
-- `p_portfolio` tem default, então o frontend antigo (que chama com quatro
-- argumentos) continua funcionando depois desta migration: sem números, o
-- degrau aparece espelhando o de cima, e `from_tag` responde zero.
-- ============================================================

do $$
begin
  if to_regprocedure('public.crm_phone_id(text)') is null then
    raise exception 'Aplique a migration 069 antes desta: crm_phone_id() não existe';
  end if;
  if to_regprocedure('public.crm_day_start(date)') is null then
    raise exception 'Aplique a migration 037 antes desta: crm_day_start() não existe';
  end if;
end $$;

-- O retorno ganha duas colunas (source, from_tag), e mudar o retorno exige
-- derrubar a função antes: create or replace não redefine a assinatura.
drop function if exists public.crm_report_journey_stage_flow(date, date, text, text);
drop function if exists public.crm_report_journey_stage_flow(date, date, text);

create or replace function public.crm_report_journey_stage_flow(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  -- Origem do lead, comparada sem caixa e sem acento como no resto
  -- do sistema (025/038): "Anúncio" e "anuncio" são a mesma coisa.
  p_origem text default null,
  -- Números de WhatsApp que chegaram ao portfólio segundo a etiqueta da
  -- conversa. Array JSON de string: ["5533998887766", ...]. Vazio = o lado
  -- das etiquetas não respondeu (ou ninguém tem a etiqueta no período).
  p_portfolio jsonb default '[]'::jsonb
)
returns table(
  stage_id           uuid,
  stage_name         text,
  color              text,
  ord                int,
  is_conversion      boolean,
  reached            bigint,
  dropped            bigint,
  drop_rate          numeric,
  avg_hours_to_reach numeric,
  -- 'crm' = coluna do kanban; 'etiqueta' = degrau sintético do portfólio.
  source             text,
  -- Só no degrau da etiqueta: quantos chegaram nesta altura APENAS por ela,
  -- sem terem avançado no CRM. É o que separa "o degrau está medindo algo"
  -- de "o degrau está só espelhando o de cima".
  from_tag           bigint
)
language sql stable security definer set search_path = public, extensions as $$
  -- Nomes internos em português de propósito: os nomes de saída da função
  -- (ord, color, source…) ficam visíveis aqui dentro, e uma coluna chamada
  -- igual viraria ambiguidade em tempo de execução.
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
  -- O meio-degrau (pos + 0.5) é o que enfia o portfólio entre duas colunas
  -- sem renumerar nada; a numeração inteira sai do row_number logo abaixo.
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
  -- A identidade do número calculada UMA vez, fora do join: dentro dele
  -- seria refeita a cada comparação (mesma lição da 075).
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
  -- Os degraus que o lead pisou de verdade no CRM. O join por etapa_id nunca
  -- casa com o degrau sintético (etapa_id nulo), que é o que queremos.
  pisadas as (
    select co.id, co.created_at, d.degrau, min(h.created_at) as chegou_em
    from coorte co
    join public.crm_stage_history h on h.contact_id = co.id
    join degraus d on d.etapa_id = h.to_stage_id
    group by co.id, co.created_at, d.degrau
  ),
  -- As duas fontes de altura, empilhadas antes do max.
  alturas as (
    select p.id, p.degrau from pisadas p
    union all
    select ce.id, dt.altura from com_etiqueta ce cross join degrau_tag dt
  ),
  alcance as (
    select a.id, max(a.degrau) as max_degrau from alturas a group by a.id
  ),
  -- Quantos só existem neste degrau por causa da etiqueta: no CRM eles não
  -- passaram desta altura. Sem degrau sintético a comparação é com NULL e o
  -- count sai zero, que é a resposta certa.
  so_pela_etiqueta as (
    select count(*)::bigint as n
    from com_etiqueta ce
    where coalesce((select max(p.degrau) from pisadas p where p.id = ce.id), 0)
        < (select dt.altura from degrau_tag dt)
  ),
  medido as (
    select
      d.*,
      (select count(*) from alcance a where a.max_degrau >= d.degrau)::bigint as alcancados,
      case when d.fonte = 'crm' then (
        select round(avg(extract(epoch from (p.chegou_em - p.created_at)) / 3600.0)::numeric, 1)
        from pisadas p where p.degrau = d.degrau
      ) end as horas,
      case when d.fonte = 'etiqueta' then (select s.n from so_pela_etiqueta s) end as vindos
    from degraus d
  )
  select
    m.etapa_id,
    m.nome,
    m.cor,
    m.degrau,
    m.conv,
    m.alcancados,
    -- No último degrau não há para onde vazar: quem chegou, chegou.
    (m.alcancados - coalesce(lead(m.alcancados) over (order by m.degrau), m.alcancados))::bigint,
    round(
      100.0 * (m.alcancados - coalesce(lead(m.alcancados) over (order by m.degrau), m.alcancados))
        / nullif(m.alcancados, 0), 1
    ),
    m.horas,
    m.fonte,
    m.vindos
  from medido m
  order by m.degrau;
$$;

comment on function public.crm_report_journey_stage_flow(date, date, text, text, jsonb) is
  'Degraus do funil na ordem, com quantos leads da coorte alcançaram cada '
  'um e quantos ficaram pelo caminho. Etapas de perda e de remarketing '
  'ficam fora da escada: são destinos laterais, não degraus. O degrau '
  '"Portfólio" (source = etiqueta) não é coluna do kanban: entra depois da '
  'etapa de papel triagem e é alimentado pelos números que p_portfolio '
  'trouxer do banco de etiquetas do bot.';
