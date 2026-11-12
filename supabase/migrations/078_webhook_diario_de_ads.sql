-- ============================================================
-- Relatório diário de gastos de anúncio para o n8n
--
-- Todo dia às 21h de Brasília o n8n recebe quanto as contas de anúncio
-- gastaram no dia ANTERIOR: total, por conta e por tipo de campanha
-- (@PH, @Pedro, Recrutamento).
--
-- Quem monta o relatório é a Edge Function `ads-daily`; esta migration só
-- agenda. A divisão é a mesma da 043: o pg_cron sabe QUANDO, a função sabe
-- COMO. O gasto não está em tabela nenhuma — mora na Meta —, então não há o
-- que plpgsql faça aqui além de acordar quem sabe buscar.
--
-- 21H EM SÃO PAULO É 00:00 UTC
--
-- O pg_cron do Supabase conta em UTC, e São Paulo é UTC-3 o ano inteiro: o
-- Brasil não tem mais horário de verão desde 2019. Por isso `0 0 * * *`
-- acerta as 21h em qualquer época do ano, sem ajuste semestral.
--
-- Um efeito de escrever assim: o job dispara à MEIA-NOITE UTC do dia
-- seguinte. Rodando o disparo de 21/08 00:00 UTC, em São Paulo são 21h de
-- 20/08, e o dia enviado é 19/08 — o último dia inteiro, fechado e já
-- assentado do lado da Meta. É a leitura literal de "dia anterior", e é
-- também a única janela que não muda depois de entregue.
--
-- POR QUE O 5085fa755ec4d33c3aade64fc9379bd9789b6af90174603e E NÃO UM JWT
--
-- Mesma escolha da 043: a função se autentica pelo header x-worker-secret,
-- comparado com o secret WORKER_SECRET. É por isso que ela precisa ser
-- publicada com --no-verify-jwt — sem essa flag a plataforma recusa a
-- chamada antes de o código rodar, e o relatório simplesmente para de
-- chegar, em silêncio, de 24 em 24 horas.
--
-- O segredo abaixo é o MESMO da 043, de propósito: um valor divergente daria
-- 401 no primeiro disparo, às 21h, sem ninguém olhando.
--
-- REPROCESSAR UM DIA À MÃO
--
-- A função aceita {"dia":"AAAA-MM-DD"} no corpo. Falhou uma noite? Dá para
-- reenviar aquele dia sem esperar o próximo ciclo:
--
--   select net.http_post(
--     url := 'https://__SUPABASE_REF__.supabase.co/functions/v1/ads-daily',
--     headers := '{"Content-Type": "application/json", "x-worker-secret": "..."}'::jsonb,
--     body := '{"dia": "2026-08-15"}'::jsonb
--   );
--
-- DEPENDE DE: a função `ads-daily` publicada, com a URL do webhook do n8n já
-- preenchida. Agendar antes disso enche o log de erro toda noite.
--
-- Reagendar sem depender de o job existir: o unschedule roda a partir de um
-- select, então não estoura quando não encontra nada.
--
-- Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

select cron.unschedule(jobid)
from cron.job
where jobname = 'ph-groups-ads-daily';

select cron.schedule(
  'ph-groups-ads-daily',
  -- 00:00 UTC = 21:00 America/Sao_Paulo, o ano inteiro.
  '0 0 * * *',
  $$
  select net.http_post(
    url := 'https://__SUPABASE_REF__.supabase.co/functions/v1/ads-daily',
    headers := '{"Content-Type": "application/json", "x-worker-secret": "SECRET"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
