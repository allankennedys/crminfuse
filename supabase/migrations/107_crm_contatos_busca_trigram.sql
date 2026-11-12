-- ============================================================
-- Busca de contatos por trecho sem varrer a tabela
--
-- A aba Contatos filtra com
--   name ilike '%x%' or email ilike '%x%' or phone ilike '%x%'
--   or conversation_id ilike '%x%'
-- O índice GIN de tsvector (013) não atende ilike com curinga no começo,
-- então cada busca varria a tabela inteira — e a tela ainda pede
-- count(exact) e a soma de vendas com o mesmo filtro. Com poucos dígitos
-- (ex.: 4) casa muita coisa e a consulta pode estourar o statement timeout.
-- Índices trigram deixam o ilike '%trecho%' usar índice.
-- ============================================================

create extension if not exists pg_trgm with schema extensions;

create index if not exists idx_crm_contacts_name_trgm
  on public.crm_contacts using gin (name extensions.gin_trgm_ops);
create index if not exists idx_crm_contacts_email_trgm
  on public.crm_contacts using gin (email extensions.gin_trgm_ops);
create index if not exists idx_crm_contacts_phone_trgm
  on public.crm_contacts using gin (phone extensions.gin_trgm_ops);
create index if not exists idx_crm_contacts_conversation_trgm
  on public.crm_contacts using gin (conversation_id extensions.gin_trgm_ops);
