-- ============================================================
-- Envio resiliente a endereço LID (168)
--
-- O WhatsApp identifica parte dos contatos por um id opaco (LID, ...@lid) em
-- vez do telefone. Há contatos para os quais o envio pelo telefone falha
-- (a Evolution devolve ERROR) e pelo LID funciona — e o contrário também.
--
--  1) "falhou" passa a valer mais que "enviada": antes, o ERROR que chegava
--     depois do envio aceito era descartado e a tela mostrava "enviada".
--     Entregue e lida continuam valendo mais que "falhou".
--  2) Reenvio automático (uma vez) pelo outro endereço quando um texto falha:
--     send_attempts conta as tentativas, wa_retry_begin pega a mensagem e
--     wa_retry_commit troca o id do WhatsApp pelo do reenvio.
-- ============================================================

-- 1) Ordem dos status: pending < sent < failed < delivered < read
create or replace function public.wa_status_rank(p_status text)
returns int
language sql immutable as $$
  select case p_status
    when 'pending'   then 0
    when 'sent'      then 1
    when 'failed'    then 2
    when 'delivered' then 3
    when 'read'      then 4
    else -1
  end;
$$;

-- 2) Tentativas de envio
alter table public.wa_messages
  add column if not exists send_attempts int not null default 1;

-- Reserva o reenvio de um texto que falhou. Devolve a mensagem (e os
-- endereços da conversa) só se ainda cabe uma segunda tentativa; chamadas
-- repetidas para o mesmo ERROR não reenviam duas vezes.
create or replace function public.wa_retry_begin(p_session uuid, p_wa_id text)
returns table (
  message_id uuid, conversation_id uuid, body text,
  remote_jid text, lid_jid text, phone text
)
language sql security definer set search_path = public as $$
  update public.wa_messages m set send_attempts = m.send_attempts + 1
  from public.wa_conversations c
  where m.conversation_id = c.id
    and c.session_id = p_session
    and m.wa_message_id = p_wa_id
    and m.from_me
    and m.type = 'text'
    and m.body is not null
    and m.deleted_at is null
    and m.status in ('pending', 'sent', 'failed')
    and m.send_attempts < 2
  returning m.id, c.id, m.body, c.remote_jid, c.lid_jid, c.phone;
$$;

-- O reenvio saiu: a mensagem passa a valer pelo novo id e volta a "enviada",
-- para o que chegar da Evolution sobre ele (entregue, lida, erro) valer.
create or replace function public.wa_retry_commit(p_message uuid, p_new_wa_id text)
returns void
language sql security definer set search_path = public as $$
  update public.wa_messages
  set wa_message_id = p_new_wa_id, status = 'sent'
  where id = p_message and from_me;
$$;

revoke all on function public.wa_retry_begin(uuid, text) from public, anon, authenticated;
revoke all on function public.wa_retry_commit(uuid, text) from public, anon, authenticated;
