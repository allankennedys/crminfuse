-- A busca da aba Contatos passou a comparar phone_key por trecho
-- (phone_key ilike '%dígitos%'), para atender telefone digitado com
-- formatação. Sem índice trigram nessa coluna a consulta voltaria a varrer
-- a tabela inteira, como na 107.

create extension if not exists pg_trgm with schema extensions;

create index if not exists idx_crm_contacts_phone_key_trgm
  on public.crm_contacts using gin (phone_key extensions.gin_trgm_ops);
