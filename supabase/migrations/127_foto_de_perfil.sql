-- ============================================================
-- Foto de perfil do cliente na conversa
--
-- O link vem da Evolution (fetchProfilePictureUrl) e é do próprio CDN do
-- WhatsApp: público, mas expira depois de alguns dias. Por isso guarda
-- quando foi conferido — o webhook e a tela pedem de novo quando passa de
-- 3 dias ou quando a imagem não carrega. Sem foto (cliente que esconde do
-- número da empresa ou que não tem foto) fica null e a tela usa as iniciais.
-- ============================================================

alter table public.wa_conversations
  add column if not exists avatar_url        text,
  add column if not exists avatar_checked_at timestamptz;
