-- ============================================================
-- Relatório por origem: agrupar ignorando maiúsculas/minúsculas e acento
--
-- origem é texto livre vindo de automações (n8n, anúncios). Sem
-- normalização, "Anúncio", "anuncio" e "ANUNCIO" viram TRÊS linhas no
-- relatório por origem, fatiando a mesma origem e distorcendo a leitura.
--
-- A chave de agrupamento passa a ser lower(unaccent(origem)): case e acento
-- somem só na COMPARAÇÃO. O rótulo exibido continua legível — usamos a
-- grafia mais frequente do grupo (mode()), então a tabela mostra "Anúncio"
-- (a forma que mais aparece), não "anuncio".
--
-- Vale para o passado e para o futuro: variações que a automação mandar
-- depois caem sozinhas na mesma linha, sem precisar limpar os dados.
--
-- Só crm_report_by_origem muda. crm_report_overview conta o total de leads
-- sem quebrar por origem, então não é afetada.
-- ============================================================

-- unaccent('Anúncio') -> 'Anuncio'. No Supabase as extensões vivem no schema
-- "extensions"; por isso a função é qualificada como extensions.unaccent
-- abaixo, sem depender do search_path.
create extension if not exists unaccent with schema extensions;

-- Mesma assinatura de 023 (int, text): create or replace substitui no lugar.
create or replace function public.crm_report_by_origem(days int default 30, p_channel text default null)
returns table(
  origem          text,
  leads           bigint,
  converted       bigint,
  conversion_rate numeric,
  revenue_cents   bigint
)
language sql stable security definer set search_path = public as $$
  select
    -- Rótulo = grafia mais comum do grupo, para a tela mostrar algo legível
    -- e acentuado em vez de uma forma normalizada.
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
    and c.created_at >= now() - make_interval(days => days)
    and c.origem is not null
    and c.origem <> ''
    and (p_channel is null or c.channel = p_channel)
  -- Agrupa ignorando caixa e acento: "Anúncio" e "anuncio" caem juntos.
  group by lower(extensions.unaccent(c.origem))
  order by 2 desc, 1;
$$;
