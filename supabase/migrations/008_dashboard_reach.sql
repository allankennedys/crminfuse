-- ============================================================
-- PH Groups — Alcance por contatos únicos + status de sincronização
--
-- "Grupo ativo" = tem ao menos um número (sessão) conectado — mesma
-- regra da tela de Grupos. Tudo isolado por public.current_org_id().
-- ============================================================

-- Alcance = contatos ÚNICOS (distinct jid) somando os grupos ativos.
-- Deduplica quem está em vários grupos. jid é a identidade sempre presente
-- do participante (group_participants.jid) — a melhor chave disponível.
create or replace function public.report_reach()
returns bigint
language sql stable security definer set search_path = public as $$
  select count(distinct gp.jid)
  from public.group_participants gp
  join public.groups g on g.id = gp.group_id
  where g.organization_id = public.current_org_id()
    and exists (
      select 1 from public.group_sessions gs
      join public.whatsapp_sessions s on s.id = gs.session_id
      where gs.group_id = g.id and s.status = 'connected'
    );
$$;

-- Status de sincronização por grupo: quantos participantes e quando foi a
-- última sincronização. Grupos sem participantes não aparecem (= não sincronizados).
create or replace function public.groups_sync_status()
returns table(group_id uuid, participant_count bigint, last_synced_at timestamptz)
language sql stable security definer set search_path = public as $$
  select gp.group_id, count(*)::bigint, max(gp.synced_at)
  from public.group_participants gp
  join public.groups g on g.id = gp.group_id
  where g.organization_id = public.current_org_id()
  group by gp.group_id;
$$;
