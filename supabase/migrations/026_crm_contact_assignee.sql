-- ============================================================
-- CRM — responsável pelo contato (assigned_to)
--
-- Habilita o filtro "por responsável" no kanban: sem esta coluna não
-- existe, em lugar nenhum do banco, quem está cuidando de um lead.
-- Segue o mesmo padrão de created_by (migration 013): FK para
-- public.users, on delete set null — desativar/remover o usuário não
-- apaga o contato, só libera ele para reatribuição.
-- ============================================================

alter table public.crm_contacts
  add column assigned_to uuid references public.users(id) on delete set null;

-- Índice do filtro por responsável e de um futuro "meus contatos".
create index idx_crm_contacts_assigned
  on public.crm_contacts(organization_id, assigned_to)
  where assigned_to is not null;
