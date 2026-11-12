-- ============================================================
-- Fila da Meta a cada 30 minutos (era 10)
--
-- A janela entre a conversão e a entrega é a única chance de corrigir um
-- valor lançado errado: uma vez enviado, a Conversions API não tem como
-- desfazer nem atualizar o evento (reenviar criaria uma segunda compra).
-- Com a 042, a correção da venda atualiza o evento que ainda está na fila —
-- então alargar a janela vira tempo real de conserto.
--
-- 30 minutos é atraso irrelevante para a Meta: as janelas de atribuição são
-- de dias, e o evento carrega o próprio horário do acontecimento
-- (event_time), não o do envio. O que se ganha em troca é a diferença entre
-- corrigir um número e conviver com ele para sempre.
--
-- CAPACIDADE
--
-- O worker processa BATCH_SIZE (25) eventos por execução: passa de 150 para
-- 50 conversões por hora. Sobra com folga para o volume atual; se um dia a
-- fila começar a atrasar, o ajuste é subir o BATCH_SIZE no worker, não
-- voltar a cadência.
--
-- Reagendar sem depender de o job existir: o unschedule roda a partir de um
-- select, então não estoura quando não encontra nada.
-- ============================================================

select cron.unschedule(jobid)
from cron.job
where jobname = 'ph-groups-crm-worker';

select cron.schedule(
  'ph-groups-crm-worker',
  '*/30 * * * *',
  $$
  select net.http_post(
    url := 'https://djtpkyvvrntyagmivjqr.supabase.co/functions/v1/crm-worker',
    headers := '{"Content-Type": "application/json", "x-worker-secret": "5085fa755ec4d33c3aade64fc9379bd9789b6af90174603e"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
