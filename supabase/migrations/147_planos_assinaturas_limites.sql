-- ============================================================
-- Planos, assinaturas e limites por organização
--
-- PLANOS (plans): preço e limites (números de WhatsApp e atendentes). Leitura
-- pública (a tela de cadastro mostra); quem edita é o dono da plataforma, pela
-- função "platform".
--
-- ASSINATURA (subscriptions): uma por organização.
--   status: trial → ativa → atrasada → cancelada (o gateway de cobrança avisa
--   por webhook). "courtesy" = sem cobrança (organizações que já existiam
--   e as que o dono libera).
--
-- ACESSO (org_acesso), calculado pelas datas, sem tarefa agendada:
--   total      uso normal
--   leitura    vê tudo, não envia nem altera (o navegador é barrado por gatilho
--              nas tabelas principais; envio é barrado nas funções)
--   bloqueado  só a tela de pagamento
--   Teste: 7 dias; sem pagar, 3 dias em leitura, depois bloqueio.
--   Atraso: 5 dias de aviso (acesso total), até o dia 15 leitura, depois bloqueio.
--
-- LIMITES: gatilhos recusam criar número ou atendente acima do plano. Só
-- atendentes contam (administradores não), como combinado.
-- ============================================================

create table if not exists public.plans (
  id             text primary key check (id ~ '^[a-z0-9_-]{2,30}$'),
  name           text not null,
  price_cents    int  not null check (price_cents >= 0),
  max_whatsapps  int  not null check (max_whatsapps >= 1),
  max_agents     int  not null check (max_agents >= 0),
  position       int  not null default 0,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

insert into public.plans (id, name, price_cents, max_whatsapps, max_agents, position) values
  ('essencial',    'Essencial',    9900,  1,  2, 1),
  ('profissional', 'Profissional', 20000, 2,  5, 2),
  ('avancado',     'Avançado',     40000, 5, 15, 3)
on conflict (id) do nothing;

alter table public.plans enable row level security;
drop policy if exists plans_read on public.plans;
create policy plans_read on public.plans for select using (active);
grant select on public.plans to anon, authenticated;

create table if not exists public.subscriptions (
  organization_id        uuid primary key references public.organizations(id) on delete cascade,
  plan_id                text not null references public.plans(id),
  status                 text not null default 'trial' check (status in ('trial', 'ativa', 'atrasada', 'cancelada')),
  trial_ends_at          timestamptz,
  overdue_since          timestamptz,
  current_period_end     timestamptz,
  courtesy               boolean not null default false,
  billing_name           text,
  billing_email          text,
  billing_doc            text,
  -- Forma de pagamento: 'cartao' (Stripe, automático) ou 'pix' (registrado à
  -- mão pelo dono da plataforma). null = ainda não escolheu (teste).
  payment_mode           text check (payment_mode in ('cartao', 'pix')),
  stripe_customer_id     text,
  stripe_subscription_id text,
  cancel_at_period_end   boolean not null default false,
  last_payment_at        timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists idx_subscriptions_stripe on public.subscriptions(stripe_subscription_id);

alter table public.subscriptions enable row level security;
-- Dados de cobrança só para os administradores da própria organização.
drop policy if exists subscriptions_admin_read on public.subscriptions;
create policy subscriptions_admin_read on public.subscriptions
  for select using (
    organization_id = public.current_org_id()
    and exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );
-- Sem política de escrita: só o servidor (service role) e as funções abaixo.

-- Configurações da plataforma (chave Pix e contato exibidos ao cliente). Leitura
-- para quem está logado; quem escreve é o dono, pela função "platform".
create table if not exists public.platform_settings (
  key   text primary key check (key ~ '^[a-z_]{2,40}$'),
  value text not null
);
alter table public.platform_settings enable row level security;
drop policy if exists platform_settings_read on public.platform_settings;
create policy platform_settings_read on public.platform_settings
  for select using (auth.uid() is not null and key in ('pix_key', 'pix_holder', 'pix_contact'));

-- Organizações que já existem seguem como estão: cortesia, plano mais alto.
insert into public.subscriptions (organization_id, plan_id, status, courtesy)
select o.id, 'avancado', 'ativa', true from public.organizations o
on conflict (organization_id) do nothing;

-- Organização nova nasce em teste de 7 dias (plano Profissional; o cadastro
-- troca pelo escolhido).
create or replace function public.subscription_for_new_org()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.subscriptions (organization_id, plan_id, status, trial_ends_at)
  values (new.id, 'profissional', 'trial', now() + interval '7 days')
  on conflict (organization_id) do nothing;
  return new;
end;
$$;
drop trigger if exists subscription_for_new_org on public.organizations;
create trigger subscription_for_new_org
  after insert on public.organizations
  for each row execute function public.subscription_for_new_org();

-- ---------- Acesso ----------
create or replace function public.org_acesso(p_org uuid)
returns text
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
      when s.courtesy then 'total'
      when s.status = 'trial' then
        case when now() < coalesce(s.trial_ends_at, now()) then 'total'
             when now() < coalesce(s.trial_ends_at, now()) + interval '3 days' then 'leitura'
             else 'bloqueado' end
      -- Pix registrado à mão: vence pela data do período pago, com a mesma carência
      -- do atraso (5 dias de aviso, até o dia 15 leitura, depois bloqueio).
      when s.status = 'ativa' and s.payment_mode = 'pix' and s.current_period_end is not null then
        case when now() < s.current_period_end + interval '5 days' then 'total'
             when now() < s.current_period_end + interval '15 days' then 'leitura'
             else 'bloqueado' end
      when s.status = 'ativa' then 'total'
      when s.status = 'atrasada' then
        case when now() < coalesce(s.overdue_since, now()) + interval '5 days' then 'total'
             when now() < coalesce(s.overdue_since, now()) + interval '15 days' then 'leitura'
             else 'bloqueado' end
      when s.status = 'cancelada' then
        case when now() < coalesce(s.current_period_end, now()) then 'total' else 'bloqueado' end
      else 'total'
    end
    from public.subscriptions s where s.organization_id = p_org
  ), 'total');
$$;
revoke all on function public.org_acesso(uuid) from public, anon;
grant execute on function public.org_acesso(uuid) to authenticated;

create or replace function public.org_uso(p_org uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'whatsapps', (select count(*) from public.whatsapp_sessions s where s.organization_id = p_org),
    'agents',    (select count(*) from public.users u where u.organization_id = p_org and u.is_active and u.role <> 'admin')
  );
$$;
revoke all on function public.org_uso(uuid) from public, anon;
grant execute on function public.org_uso(uuid) to authenticated;

-- O que a tela precisa saber da assinatura da própria organização.
create or replace function public.my_subscription()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
  v_s   public.subscriptions;
  v_p   public.plans;
  v_adm boolean;
begin
  if v_org is null then return null; end if;
  select * into v_s from public.subscriptions s where s.organization_id = v_org;
  if not found then return null; end if;
  select * into v_p from public.plans p where p.id = v_s.plan_id;
  select exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin') into v_adm;

  return jsonb_build_object(
    -- Pix vencido aparece como "atrasada" (a coluna continua "ativa" até alguém mexer).
    'status', case when v_s.status = 'ativa' and v_s.payment_mode = 'pix'
                        and v_s.current_period_end is not null and v_s.current_period_end < now()
                   then 'atrasada' else v_s.status end,
    'acesso', public.org_acesso(v_org),
    'payment_mode', v_s.payment_mode,
    'cancel_at_period_end', v_s.cancel_at_period_end,
    'reference', upper(left(replace(v_org::text, '-', ''), 8)),
    'pix', (select jsonb_object_agg(ps.key, ps.value) from public.platform_settings ps
            where ps.key in ('pix_key', 'pix_holder', 'pix_contact')),
    'courtesy', v_s.courtesy,
    'trial_ends_at', v_s.trial_ends_at,
    'overdue_since', v_s.overdue_since,
    'current_period_end', v_s.current_period_end,
    'plan', jsonb_build_object(
      'id', v_p.id, 'name', v_p.name, 'price_cents', v_p.price_cents,
      'max_whatsapps', v_p.max_whatsapps, 'max_agents', v_p.max_agents),
    'uso', public.org_uso(v_org),
    'is_admin', v_adm,
    'has_billing', v_s.stripe_subscription_id is not null,
    'billing_name', case when v_adm then v_s.billing_name end,
    'billing_email', case when v_adm then v_s.billing_email end,
    'billing_doc', case when v_adm then v_s.billing_doc end
  );
end;
$$;
revoke all on function public.my_subscription() from public, anon;
grant execute on function public.my_subscription() to authenticated;

-- ---------- Limites ----------
create or replace function public.limite_numeros()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_max int;
  v_n   int;
begin
  select p.max_whatsapps into v_max
  from public.subscriptions s join public.plans p on p.id = s.plan_id
  where s.organization_id = new.organization_id;
  if v_max is null then return new; end if;
  select count(*) into v_n from public.whatsapp_sessions w where w.organization_id = new.organization_id;
  if v_n >= v_max then
    raise exception 'Limite de números do seu plano atingido (% de %). Faça upgrade em Configurações → Plano e cobrança.', v_n, v_max;
  end if;
  return new;
end;
$$;
drop trigger if exists limite_numeros on public.whatsapp_sessions;
create trigger limite_numeros
  before insert on public.whatsapp_sessions
  for each row execute function public.limite_numeros();

create or replace function public.limite_atendentes()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_max int;
  v_n   int;
begin
  if new.role = 'admin' or not new.is_active then return new; end if;
  -- Já contava antes (mesma organização, não-admin, ativo): nada muda.
  if tg_op = 'UPDATE' and old.organization_id = new.organization_id
     and old.role <> 'admin' and old.is_active then
    return new;
  end if;
  select p.max_agents into v_max
  from public.subscriptions s join public.plans p on p.id = s.plan_id
  where s.organization_id = new.organization_id;
  if v_max is null then return new; end if;
  select count(*) into v_n from public.users u
  where u.organization_id = new.organization_id and u.is_active and u.role <> 'admin' and u.id <> new.id;
  if v_n >= v_max then
    raise exception 'Limite de atendentes do seu plano atingido (% de %). Faça upgrade em Configurações → Plano e cobrança.', v_n, v_max;
  end if;
  return new;
end;
$$;
drop trigger if exists limite_atendentes on public.users;
create trigger limite_atendentes
  before insert or update of organization_id, role, is_active on public.users
  for each row execute function public.limite_atendentes();

-- ---------- Leitura / bloqueio: o navegador não grava ----------
-- Só vale para chamada direta do navegador (current_user = authenticated); o
-- que o servidor faz (webhook, funções, RPCs do banco) não é barrado, para não
-- perder mensagem de cliente nem quebrar rotinas internas.
create or replace function public.org_writable_guard()
returns trigger
language plpgsql set search_path = public as $$
declare
  v_org uuid;
  v_ac  text;
begin
  if current_user <> 'authenticated' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then v_org := old.organization_id; else v_org := new.organization_id; end if;
  v_ac := public.org_acesso(v_org);
  if v_ac <> 'total' then
    raise exception 'Assinatura %. Regularize em Configurações → Plano e cobrança para voltar a editar.',
      case v_ac when 'leitura' then 'em modo leitura' else 'suspensa' end;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'crm_contacts', 'crm_sales', 'crm_stages', 'crm_custom_fields', 'wa_settings',
    'wa_quick_replies', 'wa_routing_rules', 'wa_source_rules'
  ] loop
    execute format('drop trigger if exists org_writable_guard on public.%I', t);
    execute format(
      'create trigger org_writable_guard before insert or update or delete on public.%I for each row execute function public.org_writable_guard()', t);
  end loop;
end;
$$;

-- Freio simples do cadastro público: tentativas por IP (limpa as antigas na própria função).
create table if not exists public.signup_attempts (
  id         bigserial primary key,
  ip         text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_signup_attempts on public.signup_attempts(ip, created_at);
alter table public.signup_attempts enable row level security;
