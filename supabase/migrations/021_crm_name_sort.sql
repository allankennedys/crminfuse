-- ============================================================
-- Ordenação alfabética com emojis/símbolos no fim
--
-- A lista de Contatos ordena e pagina NO BANCO (order + range), e o
-- PostgREST só ordena por coluna — não por expressão. Então criamos uma
-- coluna de ordenação derivada:
--
--   name_sort = faixa + lower(name)
--     faixa '0' = nome começa com LETRA (A–Z, incl. acentos latinos)
--     faixa '1' = começa com emoji, símbolo, dígito, pontuação, etc.
--
-- Assim os nomes "de verdade" vêm primeiro em ordem alfabética
-- (case-insensitive, via lower) e os que começam com emoji/caractere
-- especial caem todos no final da lista.
--
-- Coluna STORED + índice: a ordenação continua barata mesmo com a lista
-- paginada. Expressão imutável (case/regex/lower/||), exigência do banco
-- para colunas geradas.
--
-- Deploy: migration ANTES do frontend que passa a ordenar por name_sort.
-- ============================================================

alter table public.crm_contacts
  add column if not exists name_sort text
  generated always as (
    (case when name ~ '^[A-Za-zÀ-ÖØ-öø-ÿ]' then '0' else '1' end) || lower(name)
  ) stored;

create index if not exists idx_crm_contacts_name_sort
  on public.crm_contacts (organization_id, name_sort);
