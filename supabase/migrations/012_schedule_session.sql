-- ------------------------------------------------------------
-- Número de origem do envio agendado
--
-- NULL = automático: o worker distribui entre os números conectados
-- vinculados ao grupo (comportamento anterior, mantido como padrão).
-- Preenchido = envio sai obrigatoriamente daquele número; se ele estiver
-- desconectado na hora, o envio falha (não cai para outro número).
--
-- on delete set null: se o número for removido do painel, os agendamentos
-- que dependiam dele voltam para a distribuição automática em vez de sumir.
-- ------------------------------------------------------------
alter table public.schedules
  add column if not exists session_id uuid
    references public.whatsapp_sessions(id) on delete set null;
