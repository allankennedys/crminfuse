-- ============================================================
-- PH Groups — Opção de enviar áudio como ARQUIVO em vez de mensagem de voz
--
-- Padrão false = comportamento atual (áudio narrado / PTT via
-- /message/sendWhatsAppAudio). true = envia como arquivo (sendMedia).
-- ============================================================

alter table public.messages
  add column if not exists audio_as_file boolean not null default false;
