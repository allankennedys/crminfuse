-- ============================================================
-- Venda com identificador externo (idempotência para automações)
--
-- Lançar venda pela API é escrita de dinheiro, e automação repete request:
-- n8n reexecuta o node quando dá timeout, o webhook do gateway reenvia, a
-- pessoa clica "retry". Sem chave de idempotência, cada repetição vira uma
-- venda nova — o cliente aparece com 3 compras que nunca existiram e o
-- faturamento do relatório sobe sozinho.
--
-- external_id é o id da venda no sistema de origem (pedido, cobrança,
-- assinatura). Único por organização: a segunda tentativa com o mesmo id
-- bate no índice e a API devolve a venda que já existia, em vez de criar
-- outra. Nulo continua permitido — lançamento manual pela tela não precisa.
-- ============================================================

alter table public.crm_sales
  add column if not exists external_id text;

comment on column public.crm_sales.external_id is
  'Id da venda no sistema de origem (n8n, gateway). Único por organização — '
  'é a chave de idempotência da API: reenvio devolve a venda existente.';

create unique index if not exists idx_crm_sales_external
  on public.crm_sales(organization_id, external_id)
  where external_id is not null;
