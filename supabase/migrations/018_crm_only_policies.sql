-- ============================================================
-- Papel "Apenas CRM" — permissões de escrita no CRM
--
-- crm_only opera o funil como um operador: pode criar/editar/mover
-- contatos e etapas. Recriamos as duas políticas de escrita do CRM
-- incluindo o novo papel na lista.
--
-- O que crm_only NÃO ganha aqui de propósito: gestão de chaves de API e
-- das configurações da Meta (continuam admin/admin+operator nas RPCs de
-- 013). A leitura (select) das tabelas do CRM já é liberada a qualquer
-- membro da org, então relatórios e kanban funcionam sem mudança.
--
-- Roda numa transação separada da 017: o valor 'crm_only' já está
-- commitado e pode ser usado nas políticas.
-- ============================================================

drop policy if exists crm_stages_write on public.crm_stages;
create policy crm_stages_write on public.crm_stages
  for all using (
    organization_id = public.current_org_id()
    and public.current_user_role() in ('admin', 'operator', 'crm_only')
  )
  with check (organization_id = public.current_org_id());

drop policy if exists crm_contacts_write on public.crm_contacts;
create policy crm_contacts_write on public.crm_contacts
  for all using (
    organization_id = public.current_org_id()
    and public.current_user_role() in ('admin', 'operator', 'crm_only')
  )
  with check (organization_id = public.current_org_id());
