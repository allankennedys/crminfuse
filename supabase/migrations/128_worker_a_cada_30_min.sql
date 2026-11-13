-- ============================================================
-- Worker a cada 30 min (era a cada minuto)
--
-- O worker veio do painel de grupos da PH (fila, agendamentos, participantes),
-- que não existe neste projeto. O que sobrou de útil é conferir se cada
-- número está conectado — e isso agora chega na hora pelo próprio webhook
-- (evento CONNECTION_UPDATE, wa-webhook). O worker fica de reserva, para o
-- caso de um aviso se perder. Economia: ~42 mil execuções de função por mês.
-- ============================================================

select cron.alter_job(
  job_id   := (select jobid from cron.job where jobname = 'whatsapp-worker'),
  schedule := '*/30 * * * *'
);
