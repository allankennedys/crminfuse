-- ============================================================
-- Credencial da UTMify, guardada junto do token da Meta
--
-- Para enviar as vendas do CRM à UTMify (POST /api-credentials/orders,
-- cabeçalho x-api-token). Mora em crm_settings pelo mesmo motivo do
-- meta_access_token (nota 1 da 013): a tabela tem RLS ligada e NENHUMA
-- policy — nem o dono da organização lê pelo navegador. Só o SQL Editor e
-- função security definer / service role enxergam a coluna.
--
-- O VALOR NÃO VAI NESTE ARQUIVO. Migration é versionada; credencial em git
-- é credencial vazada. Grave pelo SQL Editor:
--
--   update public.crm_settings set utmify_api_token = '<credencial>';
--
-- Aditivo e idempotente. Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

alter table public.crm_settings
  add column if not exists utmify_api_token text;

comment on column public.crm_settings.utmify_api_token is
  'Credencial de API da UTMify (x-api-token). Secreta: crm_settings não tem '
  'policy de leitura (013).';
