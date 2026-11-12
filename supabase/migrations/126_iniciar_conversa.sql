-- ============================================================
-- Iniciar conversa pela equipe
--
-- De três lugares — "Nova conversa" no Atendimento, a lista de contatos e o
-- cartão do contato — a pessoa escolhe o cliente (ou digita o número) e o
-- número da empresa. A wa-chat confere na Evolution que o número tem
-- WhatsApp e pega o jid certo; daqui sai a conversa: a que já existe com
-- esse cliente nesse número, ou uma nova, atribuída a quem iniciou.
--
-- Não abre atendimento (wa_tickets): atendimento começa quando o CLIENTE
-- escreve. Se ele responder, o atendimento nasce com quem iniciou (é o
-- responsável da conversa) — e o tempo de primeira resposta mede a equipe,
-- não a mensagem que a própria equipe mandou primeiro.
-- ============================================================

-- Busca de contatos para iniciar conversa. Com a restrição ligada (119),
-- quem não tem "ver todas" só acha os contatos dele: atribuídos a ele no
-- CRM ou com conversa que ele enxerga. Para quem não está na lista, há o
-- número digitado.
create or replace function public.wa_search_contacts(p_term text)
returns table (id uuid, name text, phone text, origem text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_org     uuid := public.current_org_id();
  v_tudo    boolean;
  v_term    text := btrim(coalesce(p_term, ''));
  v_digits  text := regexp_replace(coalesce(p_term, ''), '\D', '', 'g');
begin
  if not (public.current_user_can('atendimento.ver') or public.current_user_can('atendimento.ver_todas')) then
    return;
  end if;
  if length(v_term) < 2 then
    return;
  end if;

  v_tudo := public.current_user_can('atendimento.ver_todas')
         or public.current_user_can('crm.contatos.ver')
         or not public.wa_restricted(v_org);

  return query
    select c.id, c.name, c.phone, c.origem
    from public.crm_contacts c
    where c.organization_id = v_org
      and c.phone is not null
      and (
        lower(extensions.unaccent(c.name)) like '%' || lower(extensions.unaccent(v_term)) || '%'
        or (length(v_digits) >= 4 and c.phone like '%' || v_digits || '%')
      )
      and (
        v_tudo
        or c.assigned_to = auth.uid()
        or exists (
          select 1 from public.wa_conversations w
          where w.contact_id = c.id and public.wa_can_see(w.organization_id, w.assigned_to)
        )
      )
    order by c.updated_at desc
    limit 20;
end;
$$;

-- Números de onde dá para iniciar: os da organização ligados ao
-- atendimento. O atendente não é dono de número nenhum (117) e mesmo assim
-- atende por eles — por isso não é a lista de "meus números".
create or replace function public.wa_start_sessions()
returns table (id uuid, instance_name text, phone_number text, status text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.current_user_can('atendimento.ver') or public.current_user_can('atendimento.ver_todas')) then
    return;
  end if;
  return query
    select s.id, s.instance_name, s.phone_number, s.status::text
    from public.whatsapp_sessions s
    where s.organization_id = public.current_org_id() and s.chat_enabled
    order by s.created_at;
end;
$$;

-- Abre ou reaproveita a conversa. Só service role (wa-chat), depois de a
-- Evolution confirmar o número; p_user é quem pediu, já autenticado lá.
create or replace function public.wa_open_conversation(
  p_session uuid,
  p_jid     text,
  p_name    text,
  p_contact uuid,
  p_user    uuid
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org   uuid;
  v_phone text := nullif(regexp_replace(split_part(coalesce(p_jid, ''), '@', 1), '\D', '', 'g'), '');
  v_conv  public.wa_conversations;
  v_dono  text;
begin
  select s.organization_id into v_org
  from public.whatsapp_sessions s where s.id = p_session and s.chat_enabled;
  if v_org is null then
    raise exception 'Este número não está ligado ao atendimento';
  end if;
  if not public.wa_eligible(v_org, p_user) then
    raise exception 'Seu usuário não pode atender conversas';
  end if;
  if p_contact is not null and not exists (
    select 1 from public.crm_contacts c where c.id = p_contact and c.organization_id = v_org
  ) then
    raise exception 'Contato não encontrado';
  end if;

  -- A conversa que já existe com esse cliente nesse número: pelo jid ou,
  -- se o WhatsApp devolveu o número com/sem o 9, pelo telefone canônico.
  select * into v_conv
  from public.wa_conversations c
  where c.session_id = p_session
    and (c.remote_jid = p_jid or (v_phone is not null and c.phone_key = public.crm_phone_key(v_phone)))
  order by (c.remote_jid = p_jid) desc
  limit 1
  for update;

  if found then
    if v_conv.assigned_to is null then
      perform public.wa_apply_assignment(v_conv.id, p_user, p_user, 'atribuida', 'Conversa iniciada pela equipe');
    elsif v_conv.assigned_to <> p_user
      and not public.user_has_perm(p_user, 'atendimento.ver_todas')
      and public.wa_restricted(v_org) then
      select coalesce(nullif(btrim(u.full_name), ''), u.username, u.email) into v_dono
      from public.users u where u.id = v_conv.assigned_to;
      raise exception 'Este cliente já está em atendimento com %', coalesce(v_dono, 'outra pessoa');
    end if;
    if v_conv.contact_id is null and p_contact is not null then
      update public.wa_conversations c set contact_id = p_contact where c.id = v_conv.id;
    end if;
    return v_conv.id;
  end if;

  insert into public.wa_conversations
    (organization_id, session_id, remote_jid, phone, push_name, contact_id, assigned_to, assigned_at, assigned_by)
  values
    (v_org, p_session, p_jid, v_phone, nullif(btrim(coalesce(p_name, '')), ''), p_contact, p_user, now(), p_user)
  returning * into v_conv;

  insert into public.wa_conversation_events (organization_id, conversation_id, kind, to_user, by_user, note)
  values (v_org, v_conv.id, 'atribuida', p_user, p_user, 'Conversa iniciada pela equipe');

  -- Número digitado sem contato: vira contato do CRM, como quem escreve
  -- primeiro (121).
  if p_contact is null then
    perform public.wa_ensure_contact(v_conv.id);
  end if;

  return v_conv.id;
end;
$$;

revoke all on function public.wa_open_conversation(uuid, text, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.wa_search_contacts(text) from public, anon;
revoke all on function public.wa_start_sessions() from public, anon;
grant execute on function public.wa_search_contacts(text) to authenticated;
grant execute on function public.wa_start_sessions() to authenticated;
