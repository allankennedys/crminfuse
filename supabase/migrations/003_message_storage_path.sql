-- Caminho da mídia no Firebase Storage (para limpeza automática pós-envio)
alter table public.messages add column if not exists storage_path text;
