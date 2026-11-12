-- ============================================================
-- Venda com o id da Kirvano
--
-- O reembolso chega da Kirvano com o id da VENDA DE LÁ, e o CRM não tinha
-- onde casar: external_id é o id que o n8n escolhe ao lançar (outra coisa).
-- Agora a venda guarda também o id da Kirvano, e a crm-api (action:"refund")
-- acha a venda por ele antes de cair no telefone + valor líquido.
--
-- Opcional: venda da tela, importada ou anterior a esta migration fica
-- null — e é justamente essa que o refund procura por telefone e valor.
--
-- Único por organização, como o external_id (036): um pagamento da Kirvano
-- é uma venda no CRM. Reenviar o mesmo id pela API devolve a venda que já
-- existe (duplicate:true) em vez de lançar outra.
--
-- Nenhuma trigger muda: os webhooks de venda (068/070/079/082/088) e o da
-- comissão (104) montam o corpo com campos nomeados — a coluna nova não entra
-- em nenhum deles nem dispara nada.
--
-- Aplicar pelo SQL Editor ANTES do deploy da crm-api (ela lê a coluna).
-- Nunca por db push.
-- ============================================================

alter table public.crm_sales
  add column if not exists kirvano_sale_id text;

comment on column public.crm_sales.kirvano_sale_id is
  'Id da venda na Kirvano (opcional). Único por organização. É a primeira '
  'chave que a crm-api usa para achar a venda de um reembolso.';

create unique index if not exists idx_crm_sales_kirvano
  on public.crm_sales(organization_id, kirvano_sale_id)
  where kirvano_sale_id is not null;

-- Conferência: tem de voltar 1 linha (a coluna) e 1 linha (o índice).
--   select column_name from information_schema.columns
--   where table_schema = 'public' and table_name = 'crm_sales' and column_name = 'kirvano_sale_id';
--   select indexname from pg_indexes where indexname = 'idx_crm_sales_kirvano';
