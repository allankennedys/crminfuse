-- ============================================================
-- Dias de teste grátis configuráveis (platform_settings.trial_days)
--
-- 0 = sem teste: a empresa nova nasce aguardando assinatura (acesso bloqueado até
-- escolher e pagar um plano). Quem já está em teste segue como está.
-- Valor atual: 0 (teste desativado por enquanto). Para voltar, o dono muda em
-- Configurações → Plataforma.
-- ============================================================
insert into public.platform_settings (key, value) values ('trial_days', '0')
on conflict (key) do update set value = excluded.value;

create or replace function public.trial_days()
returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select least(greatest(value::int, 0), 90) from public.platform_settings where key = 'trial_days' and value ~ '^\d+$'), 7);
$$;
revoke all on function public.trial_days() from public;
grant execute on function public.trial_days() to anon, authenticated, service_role;

alter table public.subscriptions add column if not exists no_trial boolean not null default false;

create or replace function public.subscription_for_new_org()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  d int := public.trial_days();
begin
  if d > 0 then
    insert into public.subscriptions (organization_id, plan_id, status, trial_ends_at)
    values (new.id, 'profissional', 'trial', now() + make_interval(days => d))
    on conflict (organization_id) do nothing;
  else
    -- Sem teste: "teste" já vencido há mais que a carência, então o acesso nasce bloqueado.
    insert into public.subscriptions (organization_id, plan_id, status, trial_ends_at, no_trial)
    values (new.id, 'profissional', 'trial', now() - interval '4 days', true)
    on conflict (organization_id) do nothing;
  end if;
  return new;
end;
$$;

-- my_subscription passa a informar no_trial.
do $mig$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'my_subscription' and p.prokind = 'f';
  if v_def is null then raise exception 'my_subscription não encontrada'; end if;
  if position('no_trial' in v_def) = 0 then
    v_new := replace(v_def, '''trial_ends_at'', v_s.trial_ends_at,', '''trial_ends_at'', v_s.trial_ends_at, ''no_trial'', v_s.no_trial,');
    if position('no_trial' in v_new) = 0 then raise exception 'my_subscription: trecho esperado não encontrado'; end if;
    execute v_new;
  end if;
end
$mig$;
