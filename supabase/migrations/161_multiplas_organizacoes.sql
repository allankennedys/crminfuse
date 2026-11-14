-- ============================================================
-- Um usuário em várias organizações, com papel próprio em cada uma.
--
-- memberships = fonte da verdade do vínculo (usuário × empresa: papel, permissões,
-- ativo). public.users continua com UMA linha por pessoa e espelha a empresa ATIVA
-- (organization_id, role, permissions, is_active): todas as regras de acesso
-- (current_org_id, current_user_role, current_user_can, RLS) seguem funcionando sem
-- mudança. Trocar de empresa = apontar esse espelho para outro vínculo.
--
-- Sincronia nos dois sentidos por gatilhos, com guarda de profundidade para não
-- entrar em ciclo, e a flag app.switching para a troca de empresa não ser tratada
-- como "movimentação" do usuário.
-- Limite conhecido: a pessoa só aparece como atendente (distribuição, listas de
-- atribuição) na empresa onde está ativa no momento.
-- ============================================================
create table if not exists public.memberships (
  user_id         uuid not null references public.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  role            public.user_role not null default 'operator',
  permissions     text[],
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  primary key (user_id, organization_id)
);
create index if not exists idx_memberships_org on public.memberships(organization_id);

insert into public.memberships (user_id, organization_id, role, permissions, is_active, created_at)
select u.id, u.organization_id, u.role, u.permissions, u.is_active, u.created_at from public.users u
on conflict do nothing;

alter table public.memberships enable row level security;
drop policy if exists memberships_select on public.memberships;
create policy memberships_select on public.memberships
  for select using (user_id = auth.uid() or organization_id = public.current_org_id());
-- Sem políticas de escrita: só gatilhos e funções (security definer).

-- ---------- Limite de usuários do plano: conta vínculos ----------
create or replace function public.limite_atendentes()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_max  int;
  v_n    int;
  v_user uuid;
begin
  if current_setting('app.switching', true) = '1' then return new; end if;
  if tg_table_name = 'memberships' then v_user := new.user_id; else v_user := new.id; end if;
  if not new.is_active then return new; end if;
  if tg_op = 'UPDATE' and old.organization_id = new.organization_id and old.is_active then
    return new;
  end if;
  select p.max_agents into v_max
  from public.subscriptions s join public.plans p on p.id = s.plan_id
  where s.organization_id = new.organization_id;
  if v_max is null then return new; end if;
  select count(*) into v_n from public.memberships m
  where m.organization_id = new.organization_id and m.is_active and m.user_id <> v_user;
  if v_n >= v_max then
    raise exception 'Limite de usuários do seu plano atingido (% de %). Faça upgrade em Configurações → Plano e cobrança.', v_n, v_max;
  end if;
  return new;
end;
$$;
drop trigger if exists limite_atendentes on public.memberships;
create trigger limite_atendentes
  before insert or update of is_active on public.memberships
  for each row execute function public.limite_atendentes();

-- ---------- users → memberships ----------
create or replace function public.sync_membership_from_user()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if current_setting('app.switching', true) = '1' then return new; end if;
  if tg_op = 'INSERT' then
    insert into public.memberships (user_id, organization_id, role, permissions, is_active)
    values (new.id, new.organization_id, new.role, new.permissions, new.is_active)
    on conflict (user_id, organization_id) do nothing;
    return new;
  end if;
  if pg_trigger_depth() > 1 then return new; end if;
  if old.organization_id is distinct from new.organization_id then
    -- Usuário movido para outra empresa (fluxos de cadastro/convite): o vínculo
    -- provisório antigo sai e o novo entra.
    delete from public.memberships where user_id = new.id and organization_id = old.organization_id;
    insert into public.memberships (user_id, organization_id, role, permissions, is_active)
    values (new.id, new.organization_id, new.role, new.permissions, new.is_active)
    on conflict (user_id, organization_id) do update
      set role = excluded.role, permissions = excluded.permissions, is_active = excluded.is_active;
  else
    update public.memberships m
       set role = new.role, permissions = new.permissions, is_active = new.is_active
     where m.user_id = new.id and m.organization_id = new.organization_id
       and (m.role, m.permissions, m.is_active) is distinct from (new.role, new.permissions, new.is_active);
  end if;
  return new;
end;
$$;
drop trigger if exists sync_membership_from_user on public.users;
create trigger sync_membership_from_user
  after insert or update of organization_id, role, permissions, is_active on public.users
  for each row execute function public.sync_membership_from_user();

-- ---------- memberships → users (só se for a empresa ativa) ----------
create or replace function public.sync_user_from_membership()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  update public.users u
     set role = new.role, permissions = new.permissions, is_active = new.is_active
   where u.id = new.user_id and u.organization_id = new.organization_id
     and (u.role, u.permissions, u.is_active) is distinct from (new.role, new.permissions, new.is_active);
  return new;
end;
$$;
drop trigger if exists sync_user_from_membership on public.memberships;
create trigger sync_user_from_membership
  after update of role, permissions, is_active on public.memberships
  for each row execute function public.sync_user_from_membership();

-- ---------- Apontar o espelho (users) para uma empresa ----------
create or replace function public.ativar_organizacao(p_user uuid, p_org uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  m public.memberships;
begin
  select * into m from public.memberships
  where user_id = p_user and organization_id = p_org and is_active;
  if not found then raise exception 'Você não tem acesso ativo a essa empresa.'; end if;
  perform set_config('app.switching', '1', true);
  update public.users set organization_id = m.organization_id, role = m.role,
         permissions = m.permissions, is_active = true
   where id = p_user;
  perform set_config('app.switching', '0', true);
end;
$$;
revoke all on function public.ativar_organizacao(uuid, uuid) from public, anon, authenticated;
grant execute on function public.ativar_organizacao(uuid, uuid) to service_role;

create or replace function public.switch_organization(p_org uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Não autenticado'; end if;
  perform public.ativar_organizacao(auth.uid(), p_org);
end;
$$;
revoke all on function public.switch_organization(uuid) from public, anon;
grant execute on function public.switch_organization(uuid) to authenticated;

-- Empresas do usuário logado.
create or replace function public.my_organizations()
returns table (organization_id uuid, name text, role public.user_role, is_current boolean)
language sql stable security definer set search_path = public as $$
  select m.organization_id, o.name, m.role,
         m.organization_id = (select u.organization_id from public.users u where u.id = auth.uid())
  from public.memberships m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = auth.uid() and m.is_active
  order by o.name;
$$;
revoke all on function public.my_organizations() from public, anon;
grant execute on function public.my_organizations() to authenticated;

-- ---------- Equipe da empresa atual (inclui quem está ativo em outra empresa) ----------
create or replace function public.org_members()
returns table (
  id uuid, organization_id uuid, email text, full_name text, role public.user_role,
  is_active boolean, created_at timestamptz, username text, permissions text[], tour_done_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Apenas administradores veem a equipe';
  end if;
  return query
  select u.id, m.organization_id, u.email, u.full_name, m.role, m.is_active, m.created_at,
         u.username, m.permissions, u.tour_done_at
  from public.memberships m join public.users u on u.id = m.user_id
  where m.organization_id = public.current_org_id()
  order by m.created_at;
end;
$$;
revoke all on function public.org_members() from public, anon;
grant execute on function public.org_members() to authenticated;

create or replace function public.update_member(p_user uuid, p_role public.user_role default null, p_active boolean default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
begin
  if public.current_user_role() is distinct from 'admin' then
    raise exception 'Apenas administradores alteram a equipe';
  end if;
  update public.memberships m
     set role = coalesce(p_role, m.role),
         is_active = coalesce(p_active, m.is_active)
   where m.user_id = p_user and m.organization_id = v_org;
  if not found then raise exception 'Usuário não encontrado nesta organização'; end if;
end;
$$;
revoke all on function public.update_member(uuid, public.user_role, boolean) from public, anon;
grant execute on function public.update_member(uuid, public.user_role, boolean) to authenticated;

-- Permissões personalizadas passam a gravar no vínculo (o espelho acompanha).
create or replace function public.user_permissions_save(p_user uuid, p_permissions text[] default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
  v_role public.user_role;
begin
  if public.current_user_role() <> 'admin' then
    raise exception 'Apenas administradores podem alterar permissões';
  end if;
  select m.role into v_role from public.memberships m where m.user_id = p_user and m.organization_id = v_org;
  if not found then raise exception 'Usuário não encontrado nesta organização'; end if;
  if v_role = 'admin' then
    raise exception 'Administradores têm acesso total e não aceitam permissões personalizadas';
  end if;
  update public.memberships set permissions = p_permissions where user_id = p_user and organization_id = v_org;
end;
$$;

-- ---------- Sair de uma empresa sem perder a conta ----------
-- Remove o vínculo; se era a empresa ativa e há outra, a pessoa passa para ela.
-- Devolve true se sobrou outro vínculo (então a conta NÃO deve ser apagada).
create or replace function public.remover_vinculo(p_user uuid, p_org uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_outra uuid;
begin
  select organization_id into v_outra from public.memberships
  where user_id = p_user and organization_id <> p_org and is_active
  order by created_at limit 1;
  if v_outra is null then return false; end if;
  if (select organization_id from public.users where id = p_user) = p_org then
    perform public.ativar_organizacao(p_user, v_outra);
  end if;
  delete from public.memberships where user_id = p_user and organization_id = p_org;
  return true;
end;
$$;
revoke all on function public.remover_vinculo(uuid, uuid) from public, anon, authenticated;
grant execute on function public.remover_vinculo(uuid, uuid) to service_role;

-- Apagar uma empresa não pode levar a conta de quem tem outra empresa (a linha de
-- users cairia por cascade): antes, essas pessoas passam para outra empresa.
create or replace function public.reposicionar_membros_ao_apagar_org()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_outra uuid;
begin
  for r in select u.id from public.users u where u.organization_id = old.id loop
    select organization_id into v_outra from public.memberships
    where user_id = r.id and organization_id <> old.id and is_active order by created_at limit 1;
    if v_outra is not null then
      perform public.ativar_organizacao(r.id, v_outra);
    end if;
  end loop;
  return old;
end;
$$;
drop trigger if exists reposicionar_membros_ao_apagar_org on public.organizations;
create trigger reposicionar_membros_ao_apagar_org
  before delete on public.organizations
  for each row execute function public.reposicionar_membros_ao_apagar_org();
