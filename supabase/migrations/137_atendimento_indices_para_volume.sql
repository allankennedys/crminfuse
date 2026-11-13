-- ============================================================
-- Atendimento com milhares de conversas: índices da lista e da busca
--
-- A lista filtra por situação e atendente e ordena pela última mensagem; a
-- tela agora pagina (50 por vez). Sem índice que cubra "situação + ordem", o
-- banco ordenaria toda a organização a cada página.
-- ============================================================

-- Situação + ordem (Todas, Concluídas, busca).
create index if not exists idx_wa_conv_status_recent
  on public.wa_conversations(organization_id, status, last_message_at desc nulls last, id);

-- Minhas e filtro por atendente: atendente + situação + ordem.
create index if not exists idx_wa_conv_assigned_status_recent
  on public.wa_conversations(organization_id, assigned_to, status, last_message_at desc nulls last, id);

-- Fila e o contador "Fila": só as sem atendente, que são poucas.
create index if not exists idx_wa_conv_fila
  on public.wa_conversations(organization_id, status, last_message_at desc nulls last, id)
  where assigned_to is null;

-- Busca por nome ou número sem varrer a tabela (ilike '%trecho%').
create extension if not exists pg_trgm with schema extensions;

create index if not exists idx_wa_conv_push_name_trgm
  on public.wa_conversations using gin (push_name extensions.gin_trgm_ops);
create index if not exists idx_wa_conv_phone_trgm
  on public.wa_conversations using gin (phone extensions.gin_trgm_ops);

-- Atendimento mais recente de cada conversa (filtro por data de abertura/conclusão).
create index if not exists idx_wa_tickets_conv_opened
  on public.wa_tickets(conversation_id, opened_at desc);
