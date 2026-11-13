-- ============================================================
-- Convites: usuário novo só entra por convite do administrador
--
-- O cadastro público cria apenas o DONO de uma organização nova (com teste e
-- assinatura). Atendentes e outros administradores entram por link de convite
-- gerado por um administrador da organização (e, opcionalmente, enviado por
-- e-mail). O convite:
--   • vale 7 dias, uma vez só, e pode ser revogado;
--   • só guarda o HASH do código (o link aparece uma vez, ao ser criado);
--   • leva o cargo e, se o admin personalizou, as permissões.
-- Escrita só pelo servidor (função "invite"); o administrador lê os pendentes.
-- ============================================================

create table if not exists public.invitations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  role            text not null check (role in ('admin', 'atendente')),
  email           text,
  permissions     text[],
  token_hash      text not null unique,
  created_by      uuid references public.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '7 days',
  used_at         timestamptz,
  used_by         uuid references public.users(id) on delete set null,
  revoked_at      timestamptz
);
create index if not exists idx_invitations_org on public.invitations(organization_id, created_at desc);

alter table public.invitations enable row level security;
drop policy if exists invitations_admin_read on public.invitations;
create policy invitations_admin_read on public.invitations
  for select using (
    organization_id = public.current_org_id()
    and exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin')
  );
