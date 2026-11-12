-- ============================================================
-- Leads sem origem: busca e paginação no servidor
--
-- A lista vinha inteira (teto de 200) e a tela filtrava o que tinha em
-- memória. Duas consequências ruins numa fila que é justamente a dívida
-- acumulada da base:
--
--   • buscar um contato que existe, mas está fora dos 200 mais recentes,
--     respondia "não encontrado" — o pior tipo de resposta errada, porque
--     parece um fato sobre os dados;
--   • filtrar por etapa no cliente cortava a página, não o conjunto: dava
--     3 resultados de uma etapa que tem 300.
--
-- Agora busca, etapa e limite vão para o banco. A função devolve também o
-- TOTAL que casa com os filtros (count(*) over ()), então a tela sabe se
-- ainda há mais para mostrar sem uma segunda consulta.
--
-- O valor do contato sai do retorno: nesta lista o que importa é quem está
-- sem origem e desde quando — dinheiro aqui era ruído.
--
-- Assinatura nova = DROP antes: acrescentar parâmetros criaria sobrecarga e
-- a chamada por nome ficaria ambígua.
-- ============================================================

drop function if exists public.crm_report_no_origem_list(date, date, text, int);

create or replace function public.crm_report_no_origem_list(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  p_search text default null,
  p_stage_id uuid default null,
  -- true = só quem está fora do funil (stage_id nulo). Separado de
  -- p_stage_id porque "nenhuma etapa" não é um uuid.
  p_out_of_funnel boolean default false,
  p_limit int default 15
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
  -- Quantos casam com os filtros, ignorando o limite. É o que permite
  -- "mostrando 15 de 143" e sumir com o botão quando acabar.
  total       bigint
)
language sql stable security definer set search_path = public as $$
  with termo as (
    select
      -- % e _ são curingas do like: digitados pelo usuário, alargariam a
      -- busca em vez de restringi-la.
      nullif(btrim(regexp_replace(coalesce(p_search, ''), '[%_]', '', 'g')), '') as txt,
      -- Telefone é gravado só com dígitos; casa pelo que a pessoa digitou,
      -- com ou sem máscara.
      nullif(regexp_replace(coalesce(p_search, ''), '\D', '', 'g'), '') as digitos
  ),
  base as (
    select
      c.id, c.name, c.phone, c.channel,
      c.stage_id, s.name as stage_name, s.color as stage_color,
      c.created_at
    from public.crm_contacts c
    left join public.crm_stages s on s.id = c.stage_id
    where c.organization_id = public.current_org_id()
      and (c.origem is null or btrim(c.origem) = '')
      and c.created_at >= public.crm_day_start(p_from)
      and c.created_at < public.crm_day_start(p_to + 1)
      and (p_channel is null or c.channel = p_channel)
      and (p_stage_id is null or c.stage_id = p_stage_id)
      and (not coalesce(p_out_of_funnel, false) or c.stage_id is null)
      and (
        (select txt from termo) is null
        or c.name ilike '%' || (select txt from termo) || '%'
        -- Só entra no OR se houver dígito de verdade: sem esta guarda, uma
        -- busca por texto viraria '%%' no telefone e casaria com todo mundo.
        or (
          (select digitos from termo) is not null
          and c.phone like '%' || (select digitos from termo) || '%'
        )
      )
  )
  select
    b.id, b.name, b.phone, b.channel,
    b.stage_id, b.stage_name, b.stage_color, b.created_at,
    count(*) over ()
  from base b
  -- id no desempate: com o limite crescendo a cada "mostrar mais", duas
  -- linhas do mesmo instante não podem trocar de lugar entre as consultas.
  order by b.created_at desc, b.id
  limit greatest(p_limit, 1);
$$;

comment on function public.crm_report_no_origem_list(date, date, text, text, uuid, boolean, int) is
  'Contatos com o campo Origem vazio na janela, com busca por nome/telefone, '
  'filtro de etapa e limite. A coluna total traz quantos casam com os '
  'filtros, independente do limite.';
