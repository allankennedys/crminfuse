-- Mantém a função que recebe as mensagens do WhatsApp "aquecida": sem isso, a
-- primeira mensagem depois de um tempo parado paga a partida a frio (~1 s).
-- O GET é respondido na hora pela função e não toca no banco.
select cron.unschedule('wa-webhook-aquecer') where exists (select 1 from cron.job where jobname = 'wa-webhook-aquecer');
select cron.schedule('wa-webhook-aquecer', '* * * * *', $$
  select net.http_get(url := 'https://ywdctgawnfaheeeazzgb.supabase.co/functions/v1/wa-webhook');
$$);
