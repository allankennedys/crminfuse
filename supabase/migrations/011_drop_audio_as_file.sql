-- ============================================================
-- PH Groups — Remove a opção de "áudio como arquivo"
--
-- mediatype 'audio'/'document' no sendMedia não funcionou na Evolution v2.3;
-- áudio volta a ser sempre mensagem de voz (PTT). Coluna descartada.
-- ============================================================

alter table public.messages
  drop column if exists audio_as_file;
