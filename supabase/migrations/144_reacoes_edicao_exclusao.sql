-- ============================================================
-- Reações, edição e exclusão de mensagens
--
-- Reação deixa de ser uma "mensagem" solta ("Reagiu com 👍") e vira um selo
-- na mensagem reagida (wa_messages.reactions). Edição e exclusão feitas pelo
-- cliente (ou pelo celular) atualizam a mensagem em vez de sumir ou passar
-- batido: edited_at marca "editada" e deleted_at marca "apagada" (o texto
-- original fica guardado e a tela mostra um aviso).
--
-- O atendente pode editar e apagar para todos as mensagens que enviou, SE o
-- admin permitir (wa_settings). Quem configura o atendimento sempre pode.
-- ============================================================

alter table public.wa_messages
  add column if not exists reactions jsonb not null default '[]'::jsonb,
  add column if not exists edited_at timestamptz,
  add column if not exists deleted_at timestamptz;

alter table public.wa_settings
  add column if not exists allow_edit_messages boolean not null default false,
  add column if not exists allow_delete_messages boolean not null default false;

-- Aplica um evento a uma mensagem já gravada. Só o servidor chama (webhook e
-- função de envio): não tem GRANT para o navegador.
--   p_kind: 'reaction' | 'edit' | 'delete'
--   p_target: wa_message_id (id do WhatsApp) da mensagem afetada
--   p_actor: 'cliente' | 'equipe' | id do atendente (quem reagiu)
-- Mensagem não encontrada = nada acontece (devolve false): o evento pode
-- chegar antes da mensagem, ou ser de uma conversa que não é nossa.
create or replace function public.wa_message_event(
  p_session uuid,
  p_kind    text,
  p_target  text,
  p_text    text default null,
  p_actor   text default null
)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_msg  public.wa_messages;
  v_last timestamptz;
begin
  select m.* into v_msg
  from public.wa_messages m
  join public.wa_conversations c on c.id = m.conversation_id
  where c.session_id = p_session and m.wa_message_id = p_target
  order by m.created_at desc
  limit 1;
  if not found then
    return false;
  end if;

  if p_kind = 'reaction' then
    update public.wa_messages m set reactions = (
      coalesce((
        select jsonb_agg(r) from jsonb_array_elements(m.reactions) r
        where r->>'by' is distinct from p_actor
      ), '[]'::jsonb)
      || case when nullif(btrim(coalesce(p_text, '')), '') is null then '[]'::jsonb
              else jsonb_build_array(jsonb_build_object('by', p_actor, 'emoji', left(btrim(p_text), 16))) end
    ) where m.id = v_msg.id;

  elsif p_kind = 'edit' then
    if v_msg.type <> 'text' or nullif(btrim(coalesce(p_text, '')), '') is null then
      return false;
    end if;
    update public.wa_messages m set body = p_text, edited_at = now() where m.id = v_msg.id;
    -- A prévia da lista acompanha, se esta for a última mensagem.
    select c.last_message_at into v_last from public.wa_conversations c where c.id = v_msg.conversation_id;
    if v_last is not null and v_msg.wa_timestamp >= v_last then
      update public.wa_conversations c set last_message_preview = left(p_text, 160) where c.id = v_msg.conversation_id;
    end if;

  elsif p_kind = 'delete' then
    update public.wa_messages m set deleted_at = coalesce(m.deleted_at, now()) where m.id = v_msg.id;
    select c.last_message_at into v_last from public.wa_conversations c where c.id = v_msg.conversation_id;
    if v_last is not null and v_msg.wa_timestamp >= v_last then
      update public.wa_conversations c set last_message_preview = '🚫 Mensagem apagada' where c.id = v_msg.conversation_id;
    end if;
  else
    raise exception 'Evento desconhecido: %', p_kind;
  end if;
  return true;
end;
$$;
revoke all on function public.wa_message_event(uuid, text, text, text, text) from public, anon, authenticated;
