-- ============================================================
-- PH Groups — Jobs de sincronização de participantes em background
--
-- Reusa participant_jobs: cada job 'sync' sincroniza UM grupo. O worker
-- processa poucos por rodada (pacing natural) — sobrevive ao painel fechado.
-- ============================================================

alter table public.participant_jobs
  drop constraint if exists participant_jobs_action_check;

alter table public.participant_jobs
  add constraint participant_jobs_action_check
  check (action in ('add', 'remove', 'sync'));
