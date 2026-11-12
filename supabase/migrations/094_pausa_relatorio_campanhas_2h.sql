-- ============================================================
-- Pausa o relatório de campanhas de 2 em 2 horas (086)
--
-- Pedido de 14/09/2026: parar o envio de 11h05–17h05, seg–sex.
--
-- PAUSA, NÃO APAGA
--
-- cron.alter_job(active := false) deixa o job em cron.job com o horário e o
-- comando intactos — inclusive o x-worker-secret real, que não está neste
-- repositório (a 086 tem o placeholder SECRET). Um unschedule obrigaria a
-- reaplicar a 086 com o segredo certo para voltar; e errar o segredo dá 401
-- mudo.
--
-- A Edge Function `ads-campaigns` continua publicada: reprocessar um dia à
-- mão (ver a 086) segue funcionando.
--
-- Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

select cron.alter_job(jobid, active := false)
  from cron.job
 where jobname = 'ph-groups-ads-campaigns';

-- ------------------------------------------------------------
-- CONFERIR DEPOIS DE APLICAR
--
--   select jobname, schedule, active from cron.job
--    where jobname = 'ph-groups-ads-campaigns';   -- active = false
--
-- Nenhuma linha no select acima = o job nem existia, nada a pausar.
--
-- REATIVAR:
--
--   select cron.alter_job(jobid, active := true)
--     from cron.job where jobname = 'ph-groups-ads-campaigns';
-- ------------------------------------------------------------
