-- Pedido de avaliação sai na hora, sem esperar o worker (que roda a cada 30 min).
--  1) atraso padrão 0 (e as empresas que estão no padrão antigo de 2 min passam a 0);
--  2) gatilho: ao criar o pedido, o banco chama a função `avaliacao` (pg_net), que envia;
--  3) rede de segurança: a mesma função roda a cada minuto (retentativa se falhar).
-- A chave que autentica a chamada é lida de platform_settings (não fica no código).
alter table public.wa_settings alter column rating_delay_minutes set default 0;
update public.wa_settings set rating_delay_minutes = 0 where rating_delay_minutes = 2;

create or replace function public.wa_rating_enviar_agora()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_key text;
begin
  select value into v_key from public.platform_settings where key = 'signup_secret';
  if v_key is null or v_key = '' then return new; end if;
  perform net.http_post(
    url := 'https://ywdctgawnfaheeeazzgb.supabase.co/functions/v1/avaliacao',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-servidor-key', v_key),
    body := '{}'::jsonb
  );
  return new;
exception when others then
  return new; -- nunca atrapalha concluir a conversa; o cron cobre
end $$;
revoke all on function public.wa_rating_enviar_agora() from public, anon, authenticated;

drop trigger if exists wa_rating_enviar_agora on public.wa_ratings;
create trigger wa_rating_enviar_agora
  after insert on public.wa_ratings
  for each row when (new.send_at <= now() + interval '5 seconds')
  execute function public.wa_rating_enviar_agora();

select cron.unschedule('wa-avaliacao') where exists (select 1 from cron.job where jobname = 'wa-avaliacao');
select cron.schedule('wa-avaliacao', '* * * * *', $$
  select net.http_post(
    url := 'https://ywdctgawnfaheeeazzgb.supabase.co/functions/v1/avaliacao',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-servidor-key', (select value from public.platform_settings where key = 'signup_secret')),
    body := '{}'::jsonb
  );
$$);
