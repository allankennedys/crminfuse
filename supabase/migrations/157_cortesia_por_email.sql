-- ============================================================
-- Cortesia por e-mail: quem está nesta lista tem a conta criada já em cortesia
-- (sem cobrança, sem prazo) no plano mais alto (Avançado = tudo incluso).
-- Vale no cadastro e também se o plano for trocado depois (o cadastro escolhe
-- plano logo após criar a empresa). Para encerrar, remova o e-mail da lista e
-- ajuste a assinatura em Plataforma.
-- ============================================================
create table if not exists public.cortesias_email (
  email      text primary key check (email = lower(email)),
  created_at timestamptz not null default now()
);
alter table public.cortesias_email enable row level security;  -- sem policies: só o servidor/migrações

insert into public.cortesias_email (email) values ('klenofelipe@gmail.com')
on conflict do nothing;

-- Força cortesia + plano Avançado na assinatura de uma empresa que tem admin na lista.
create or replace function public.forcar_cortesia_por_email()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from public.users u
    join public.cortesias_email c on c.email = lower(u.email)
    where u.organization_id = new.organization_id
  ) then
    new.courtesy := true;
    new.plan_id := 'avancado';
    new.status := 'ativa';
    new.trial_ends_at := null;
    new.no_trial := false;
    new.cancel_at_period_end := false;
  end if;
  return new;
end;
$$;
drop trigger if exists forcar_cortesia_por_email on public.subscriptions;
create trigger forcar_cortesia_por_email
  before insert or update on public.subscriptions
  for each row execute function public.forcar_cortesia_por_email();

-- Quando o usuário é criado (a empresa já existe, com assinatura), reaplica.
create or replace function public.cortesia_ao_criar_usuario()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.cortesias_email where email = lower(new.email)) then
    update public.subscriptions set updated_at = now() where organization_id = new.organization_id;
  end if;
  return new;
end;
$$;
drop trigger if exists cortesia_ao_criar_usuario on public.users;
create trigger cortesia_ao_criar_usuario
  after insert on public.users
  for each row execute function public.cortesia_ao_criar_usuario();

-- Se a conta já existir, libera agora.
update public.subscriptions s set updated_at = now()
where exists (select 1 from public.users u where u.organization_id = s.organization_id and lower(u.email) = 'klenofelipe@gmail.com');
