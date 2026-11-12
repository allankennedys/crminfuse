-- ============================================================
-- Origens já usadas, para o campo Origem virar lista
--
-- Origem é texto livre e continua sendo: o painel oferece o que já existe e
-- aceita uma nova, igual ao campo Canal (014). O que muda é parar de exigir
-- que a pessoa lembre e redigite a grafia exata.
--
-- AGRUPA IGUAL AO RELATÓRIO (025)
--
-- A chave é lower(unaccent(origem)), então "Anúncio", "anuncio" e "ANUNCIO"
-- viram UMA opção — senão a lista mostraria três entradas da mesma origem e
-- o próprio picker continuaria produzindo variação. O rótulo exibido é a
-- grafia mais frequente (mode()), a mesma que o relatório mostra.
--
-- Vale lembrar por que isso importa mais do que estética: origem que declara
-- anúncio manda a conversão para a Meta (033). Escolher da lista em vez de
-- digitar reduz o "Anuncio" sem acento que não casa com nada e o typo que
-- deixa a venda fora da atribuição.
-- ============================================================

create or replace function public.crm_origens()
returns table (origem text, contact_count bigint)
language sql stable security definer set search_path = public, extensions as $$
  select
    mode() within group (order by c.origem) as origem,
    count(*)
  from public.crm_contacts c
  where c.organization_id = public.current_org_id()
    and c.origem is not null
    and btrim(c.origem) <> ''
  group by lower(extensions.unaccent(c.origem))
  order by count(*) desc, 1;
$$;

comment on function public.crm_origens() is
  'Origens em uso na organização, agrupadas sem caixa e sem acento, com a '
  'grafia mais frequente como rótulo. Alimenta a lista do campo Origem.';
