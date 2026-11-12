-- ============================================================
-- CRM: campos de atribuição do lead
--
-- Três campos de texto livre, todos opcionais, para rastrear de onde o
-- contato veio quando ele chega por automação (n8n, anúncio, bot):
--
--   ctwaclid  — Click-to-WhatsApp Ad Click ID (ctwa_clid do Meta): o id
--               do clique no anúncio que iniciou a conversa. Serve para
--               casar o lead com a campanha na hora de medir conversão.
--   source_id — id da origem no sistema externo (id da campanha, do
--               anúncio, do formulário — o que a automação quiser gravar).
--   origem    — rótulo legível da origem (ex.: "Instagram Ads",
--               "Landing quente", "Indicação").
--
-- Texto livre e nullable pela mesma razão do channel (014): a origem pode
-- vir de fora do PH Groups e não pode obrigar cadastro prévio, senão a
-- captura do lead quebraria. Um upsert que não manda esses campos não os
-- altera; mandar string vazia os limpa (vira null, como email/description).
-- ============================================================

alter table public.crm_contacts
  add column if not exists ctwaclid  text,
  add column if not exists source_id text,
  add column if not exists origem    text;
