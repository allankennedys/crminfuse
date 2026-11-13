-- ============================================================
-- Toda conversa tem contato no CRM
--
-- Desde a 121, quem ESCREVE já vira contato (wa_ingest_message chama
-- wa_apply_origin). Ficavam de fora:
--   1. conversas que nasceram antes da 121 (sem contact_id);
--   2. conversa que nasce por mensagem NOSSA (enviada direto do celular ou
--      de outro aparelho), porque só a mensagem do cliente criava o contato.
--
-- Aqui: um gatilho cria o contato assim que a conversa nasce, de qualquer
-- origem, e uma varredura única cobre as que já existem. A falha do contato
-- nunca derruba a entrada da mensagem: a conversa segue e a próxima mensagem
-- do cliente tenta de novo.
-- ============================================================

create or replace function public.wa_conversation_contact_trg()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public.wa_ensure_contact(new.id);
  exception when others then
    raise warning 'wa_conversation_contact_trg: %', sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists wa_conversation_contact on public.wa_conversations;
create trigger wa_conversation_contact
  after insert on public.wa_conversations
  for each row execute function public.wa_conversation_contact_trg();

-- Varredura única: conversas existentes sem contato.
do $$
declare
  r record;
begin
  for r in select c.id from public.wa_conversations c where c.contact_id is null loop
    begin
      perform public.wa_ensure_contact(r.id);
    exception when others then
      raise warning 'backfill contato %: %', r.id, sqlerrm;
    end;
  end loop;
end;
$$;
