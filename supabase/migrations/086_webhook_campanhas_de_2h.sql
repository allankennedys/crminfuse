-- ============================================================
-- Relatório de campanhas a cada 2 horas, no horário comercial
--
-- De segunda a sexta, às 11h05, 13h05, 15h05 e 17h05 de Brasília, o n8n
-- recebe o resumo do dia CORRENTE das campanhas ativas — gasto, vendas, ROI
-- e a classificação de cada uma — com a mensagem já montada para o WhatsApp.
--
-- SÃO QUATRO ENVIOS, NÃO CINCO
--
-- Começando às 11h05 e mantendo o passo de 2 horas, o quinto cairia às 19h05
-- e passaria do teto das 18h que o pedido fixou. Então a série termina às
-- 17h05.
--
-- Isso custa o envio do fim do dia, que era o MAIS confiável dos cinco: às
-- 18h a atribuição da Meta já assentou, e às 11h ela ainda está atrasada em
-- relação ao gasto. Quem quiser o fechamento de volta acrescenta 21 à lista
-- de horas — a última janela fica de 1 hora em vez de 2, e é só isso que
-- quebra.
--
-- OS 5 MINUTOS NÃO SÃO ENFEITE
--
-- Disparar na hora cheia coloca o relatório na mesma fila em que todo mundo
-- agenda coisa, e a Marketing API é justamente onde isso se paga em 429. Os
-- 5 minutos tiram o disparo do pico e ainda dão folga para o gasto da hora
-- assentar do lado da Meta. Quem muda o horário depois: mantenha o minuto
-- fora do zero, pelo mesmo motivo.
--
-- Quem monta o relatório é a Edge Function `ads-campaigns`; esta migration
-- só agenda. A divisão é a mesma da 043 e da 078: o pg_cron sabe QUANDO, a
-- função sabe COMO. O gasto e a receita não estão em tabela nenhuma — moram
-- na Meta —, então não há o que plpgsql faça aqui além de acordar quem sabe
-- buscar.
--
-- 11H05–17H05 EM SÃO PAULO É 14H05–20H05 UTC
--
-- O pg_cron do Supabase conta em UTC, e São Paulo é UTC-3 o ano inteiro: o
-- Brasil não tem mais horário de verão desde 2019. Por isso as horas ficam
-- deslocadas de 3 e não precisam de ajuste semestral.
--
-- O `1-5` também é UTC, e aqui isso É seguro: 14h05–20h05 UTC caem todas no
-- MESMO dia do calendário em São Paulo (11h05–17h05), então o dia da semana
-- não se desloca. A conta seria outra se o disparo fosse de madrugada — é
-- exatamente o que acontece na 078, cujo `0 0 * * *` dispara à meia-noite
-- UTC para acertar as 21h do dia anterior em SP.
--
-- MUDAR O INTERVALO
--
-- O pedido dizia "a cada 2 horas (intervalo configurável)". A configuração é
-- esta linha, e só ela. De hora em hora: `5 14-21 * * 1-5`. De 3 em 3:
-- `5 14,17,20 * * 1-5`. Voltar o fechamento das 18h: acrescente 21 às horas.
-- Rodar também no sábado: `1-6`. Reaplicar este arquivo
-- com a expressão nova troca o agendamento no lugar — o unschedule acima
-- garante que não fiquem dois jobs disparando o mesmo relatório em dobro.
--
-- O primeiro campo é o MINUTO, e é ele que vale 5 aqui. Trocá-lo por `0` põe
-- o relatório de volta na hora cheia; `*` faria a função rodar 60 vezes por
-- hora — o tipo de engano que só aparece na fatura da Meta.
--
-- POR QUE A JANELA NÃO ESTÁ DENTRO DA FUNÇÃO
--
-- A função não checa hora nem dia da semana de propósito. Se checasse,
-- reprocessar um relatório à mão num domingo — ou às 22h, investigando algo —
-- devolveria silêncio em vez do relatório. O horário é política de entrega e
-- mora no agendador; a função responde sempre que perguntada.
--
-- POR QUE x-worker-secret E NÃO UM JWT
--
-- Mesma escolha da 043 e da 078: a função se autentica pelo header
-- x-worker-secret, comparado com o secret WORKER_SECRET. É por isso que ela
-- precisa ser publicada com --no-verify-jwt — sem essa flag a plataforma
-- recusa a chamada antes de o código rodar, e o relatório simplesmente para
-- de chegar, em silêncio, cinco vezes por dia.
--
-- Troque SECRET abaixo pelo mesmo valor usado na 078 antes de aplicar. Um
-- valor divergente dá 401 no primeiro disparo, às 10h, sem ninguém olhando.
--
-- REPROCESSAR UM DIA À MÃO
--
-- A função aceita {"dia":"AAAA-MM-DD"} no corpo. A hora que sai no cabeçalho
-- da mensagem é a do relógio no momento do disparo — reprocessar às 23h um
-- relatório de terça manda "23h47", não "15h05":
--
--   select net.http_post(
--     url := 'https://__SUPABASE_REF__.supabase.co/functions/v1/ads-campaigns',
--     headers := '{"Content-Type": "application/json", "x-worker-secret": "..."}'::jsonb,
--     body := '{"dia": "2026-09-05"}'::jsonb
--   );
--
-- DEPENDE DE: a migration 085 (coluna is_active) e a Edge Function
-- `ads-campaigns` publicada. Agendar antes disso enche o log de erro cinco
-- vezes por dia.
--
-- Reagendar sem depender de o job existir: o unschedule roda a partir de um
-- select, então não estoura quando não encontra nada.
--
-- Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

select cron.unschedule(jobid)
from cron.job
where jobname = 'ph-groups-ads-campaigns';

select cron.schedule(
  'ph-groups-ads-campaigns',
  -- 14h05,16h05,18h05,20h05 UTC
  -- = 11h05,13h05,15h05,17h05 America/Sao_Paulo, seg–sex.
  '5 14,16,18,20 * * 1-5',
  $$
  select net.http_post(
    url := 'https://__SUPABASE_REF__.supabase.co/functions/v1/ads-campaigns',
    headers := '{"Content-Type": "application/json", "x-worker-secret": "SECRET"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
