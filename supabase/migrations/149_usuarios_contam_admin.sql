-- ============================================================
-- O limite de usuários do plano passa a contar TODOS os usuários ativos,
-- administradores inclusive (antes só os atendentes contavam).
-- A chave "agents" de org_uso e a coluna plans.max_agents mantêm o nome por
-- compatibilidade; o texto na tela diz "usuários".
-- ============================================================

create or replace function public.org_uso(p_org uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'whatsapps', (select count(*) from public.whatsapp_sessions s where s.organization_id = p_org),
    'agents',    (select count(*) from public.users u where u.organization_id = p_org and u.is_active)
  );
$$;

create or replace function public.limite_atendentes()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_max int;
  v_n   int;
begin
  if not new.is_active then return new; end if;
  -- Já contava antes (mesma organização, ativo): nada muda.
  if tg_op = 'UPDATE' and old.organization_id = new.organization_id and old.is_active then
    return new;
  end if;
  select p.max_agents into v_max
  from public.subscriptions s join public.plans p on p.id = s.plan_id
  where s.organization_id = new.organization_id;
  if v_max is null then return new; end if;
  select count(*) into v_n from public.users u
  where u.organization_id = new.organization_id and u.is_active and u.id <> new.id;
  if v_n >= v_max then
    raise exception 'Limite de usuários do seu plano atingido (% de %). Faça upgrade em Configurações → Plano e cobrança.', v_n, v_max;
  end if;
  return new;
end;
$$;
