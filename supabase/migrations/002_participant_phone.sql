-- Adiciona telefone ao participante (extraído do JID na sincronização)
alter table public.group_participants add column if not exists phone text;
