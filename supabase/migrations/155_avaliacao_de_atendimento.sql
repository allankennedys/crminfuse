-- ============================================================
-- Avaliação do atendimento
--
-- O admin liga o recurso e escreve a mensagem. Ao CONCLUIR um atendimento (por
-- uma pessoa, depois de ela ter respondido o cliente), o sistema pede, pelo
-- próprio WhatsApp e depois de alguns minutos, uma nota de 1 a 5. A próxima
-- mensagem do cliente com só esse número (em até 2 h depois da conclusão) vira a avaliação: não
-- reabre o atendimento, não cria atendimento novo e recebe um agradecimento.
-- Com nota 1, 2 ou 3 o agradecimento pergunta o que aconteceu: a resposta seguinte
-- (em até 2 h) vira o comentário, também sem reabrir.
--
--   wa_settings.rating_*   configuração
--   wa_ratings             um pedido por atendimento, com a nota (e o comentário, se nota baixa)
--   wa_rating_due/sent     usadas pelo worker para enviar os pedidos
--   wa_rating_report       médias para o relatório
-- ============================================================

alter table public.wa_settings
  add column if not exists rating_on boolean not null default false,
  add column if not exists rating_text text,
  add column if not exists rating_thanks_text text,
  add column if not exists rating_delay_minutes int not null default 2
    check (rating_delay_minutes between 0 and 60),
  -- Nota 1, 2 ou 3: o agradecimento já pergunta o que aconteceu e a resposta vira comentário.
  add column if not exists rating_comment_on boolean not null default true,
  add column if not exists rating_comment_text text;

create table if not exists public.wa_ratings (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ticket_id       uuid not null unique references public.wa_tickets(id) on delete cascade,
  conversation_id uuid not null references public.wa_conversations(id) on delete cascade,
  session_id      uuid references public.whatsapp_sessions(id) on delete set null,
  agent_id        uuid references public.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  send_at         timestamptz not null,
  expires_at      timestamptz not null,
  claimed_at      timestamptz,
  attempts        int not null default 0,
  sent_at         timestamptz,
  score           smallint check (score between 1 and 5),
  answered_at     timestamptz,
  thanks_sent_at  timestamptz,
  comment_requested_at timestamptz,
  feedback        text,
  comment_at      timestamptz
);
create index if not exists idx_wa_ratings_conv on public.wa_ratings(conversation_id, created_at desc);
create index if not exists idx_wa_ratings_due on public.wa_ratings(send_at) where sent_at is null;
create index if not exists idx_wa_ratings_org on public.wa_ratings(organization_id, created_at);

alter table public.wa_ratings enable row level security;
drop policy if exists wa_ratings_select on public.wa_ratings;
create policy wa_ratings_select on public.wa_ratings
  for select using (exists (select 1 from public.wa_conversations c where c.id = conversation_id));
-- Sem policy de escrita: só pelo banco (gatilho e funções abaixo).

-- Mensagem enviada pelo sistema (saudação, ausência, pedido de avaliação, agradecimento):
-- aparece como "Sistema" na conversa, em vez de "Enviada pelo celular".
alter table public.wa_messages add column if not exists is_system boolean not null default false;

-- Evento na linha do tempo da conversa.
alter table public.wa_conversation_events drop constraint if exists wa_conversation_events_kind_check;
alter table public.wa_conversation_events
  add constraint wa_conversation_events_kind_check
  check (kind in ('atribuida', 'transferida', 'fila', 'auto', 'resolvida', 'reaberta', 'avaliada'));

-- ---------- Pedido criado ao concluir ----------
create or replace function public.wa_rating_on_close()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_set public.wa_settings;
  v_send timestamptz;
begin
  if new.status <> 'concluido' or old.status = 'concluido' then return new; end if;
  -- Só quando uma pessoa concluiu, depois de ter respondido o cliente.
  if new.closed_by is null or new.first_response_at is null then return new; end if;

  select * into v_set from public.wa_settings s where s.organization_id = new.organization_id;
  if not found or not v_set.rating_on then return new; end if;

  -- Não pede de novo se já pediu à mesma conversa nas últimas 24 h.
  if exists (select 1 from public.wa_ratings r
             where r.conversation_id = new.conversation_id and r.created_at > now() - interval '24 hours') then
    return new;
  end if;

  v_send := now() + make_interval(mins => v_set.rating_delay_minutes);
  insert into public.wa_ratings (organization_id, ticket_id, conversation_id, session_id, agent_id, send_at, expires_at)
  values (new.organization_id, new.id, new.conversation_id, new.session_id,
          coalesce(new.assigned_to, new.closed_by), v_send, coalesce(new.closed_at, now()) + interval '2 hours')
  on conflict (ticket_id) do nothing;
  return new;
end $$;

drop trigger if exists wa_rating_on_close on public.wa_tickets;
create trigger wa_rating_on_close
  after update of status on public.wa_tickets
  for each row execute function public.wa_rating_on_close();

-- ---------- Envio (worker) ----------
create or replace function public.wa_rating_due(p_limit int default 20)
returns table (id uuid, instance_name text, pn_jid text, lid_jid text, text_out text, conversation_id uuid, session_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_ids uuid[];
begin
  select coalesce(array_agg(x.id), '{}') into v_ids from (
    select r.id from public.wa_ratings r
    join public.wa_conversations c on c.id = r.conversation_id
    where r.sent_at is null and r.send_at <= now() and r.expires_at > now() and r.attempts < 3
      and (r.claimed_at is null or r.claimed_at < now() - interval '5 minutes')
      and c.status = 'resolvida'
    order by r.send_at
    limit greatest(p_limit, 1)
    for update of r skip locked
  ) x;
  if cardinality(v_ids) = 0 then return; end if;

  update public.wa_ratings r set claimed_at = now() where r.id = any(v_ids);

  return query
  select r.id, s.instance_name,
         coalesce(case when c.remote_jid like '%@s.whatsapp.net' then c.remote_jid end,
                  case when c.phone is not null then c.phone || '@s.whatsapp.net' end),
         coalesce(c.lid_jid, case when c.remote_jid like '%@lid' then c.remote_jid end),
         (
           select replace(
             case when nm.n = '' then replace(replace(tx.t, ' {nome}', ''), '{nome}', '') else replace(tx.t, '{nome}', nm.n) end,
             '{atendente}', coalesce(nullif(ag.n, ''), 'nossa equipe'))
           from (select coalesce(nullif(btrim(st.rating_text), ''),
                   'Olá {nome}! Seu atendimento com {atendente} foi concluído. Como você avalia? Responda com uma nota de 1 a 5 (1 = ruim, 5 = excelente).') as t
                 from (select 1) z left join public.wa_settings st on st.organization_id = r.organization_id) tx,
                (select split_part(btrim(coalesce(nullif(btrim(ct.name), ''), nullif(btrim(c.push_name), ''), '')), ' ', 1) as n
                 from (select 1) z2 left join public.crm_contacts ct on ct.id = c.contact_id) nm,
                (select split_part(btrim(coalesce(u.full_name, '')), ' ', 1) as n
                 from (select 1) z3 left join public.users u on u.id = r.agent_id) ag
         ),
         r.conversation_id, r.session_id
  from public.wa_ratings r
  join public.wa_conversations c on c.id = r.conversation_id
  join public.whatsapp_sessions s on s.id = c.session_id
  where r.id = any(v_ids);
end $$;
revoke all on function public.wa_rating_due(int) from public, anon, authenticated;
grant execute on function public.wa_rating_due(int) to service_role;

create or replace function public.wa_rating_sent(p_id uuid, p_ok boolean)
returns void
language sql security definer set search_path = public as $$
  update public.wa_ratings
     set sent_at = case when p_ok then now() end,
         attempts = case when p_ok then attempts else attempts + 1 end,
         claimed_at = null
   where id = p_id and sent_at is null;
$$;
revoke all on function public.wa_rating_sent(uuid, boolean) from public, anon, authenticated;
grant execute on function public.wa_rating_sent(uuid, boolean) to service_role;

-- ---------- Relatório ----------
create or replace function public.wa_rating_report(p_from date, p_to date, p_user uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
  v_ini timestamptz := (p_from::timestamp at time zone 'America/Sao_Paulo');
  v_fim timestamptz := ((p_to + 1)::timestamp at time zone 'America/Sao_Paulo');
  v jsonb;
begin
  if not exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'admin' and u.is_active) then
    raise exception 'Relatório disponível só para administradores';
  end if;

  with r as (
    select x.* from public.wa_ratings x
    join public.wa_tickets t on t.id = x.ticket_id
    where x.organization_id = v_org and t.closed_at >= v_ini and t.closed_at < v_fim
      and x.sent_at is not null and (p_user is null or x.agent_id = p_user)
  )
  select jsonb_build_object(
    'enviadas', (select count(*) from r),
    'respondidas', (select count(*) from r where score is not null),
    'media', (select round(avg(score)::numeric, 2) from r where score is not null),
    'distribuicao', coalesce((
      select jsonb_agg(jsonb_build_object('nota', n, 'total', (select count(*) from r where r.score = n)) order by n)
      from generate_series(1, 5) n), '[]'::jsonb),
    'por_atendente', coalesce((
      select jsonb_agg(jsonb_build_object('id', agent_id, 'media', m, 'total', c, 'enviadas', e) order by c desc)
      from (select agent_id, round(avg(score)::numeric, 2) m, count(score) c, count(*) e
            from r where agent_id is not null group by agent_id) q), '[]'::jsonb),
    'comentarios', coalesce((
      select jsonb_agg(jsonb_build_object('nota', score, 'texto', feedback, 'agente', agent_id, 'quando', comment_at) order by comment_at desc)
      from (select * from r where feedback is not null order by comment_at desc limit 20) k), '[]'::jsonb)
  ) into v;
  return v;
end $$;
revoke all on function public.wa_rating_report(date, date, uuid) from public, anon;
grant execute on function public.wa_rating_report(date, date, uuid) to authenticated;

-- ---------- Captura da nota e agradecimento (patches nas funções existentes) ----------
do $mig$
declare
  v_def text;
  v_new text;
begin
  -- wa_ingest_message: a nota não reabre nem cria atendimento.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'wa_ingest_message' and p.prokind = 'f';
  if v_def is null then raise exception 'wa_ingest_message não encontrada'; end if;

  if position('v_rating' in v_def) = 0 then
    v_new := replace(v_def, 'v_keeper   uuid;', E'v_keeper   uuid;\n  v_rating   boolean := false;\n  v_comment  boolean := false;');
    v_new := replace(v_new, E'if v_inserted then\n    v_preview := left(coalesce(',
      $r$if v_inserted then
    if p_status = 'auto' then
      update public.wa_messages set is_system = true where id = v_msg;
    end if;
    -- Avaliação do atendimento: só um número de 1 a 5, respondendo a um pedido recente.
    if not p_from_me and p_type = 'text' then
      update public.wa_ratings r
         set score = substring(btrim(p_body) from 1 for 1)::int, answered_at = now()
       where r.conversation_id = v_conv.id and r.score is null and r.sent_at is not null
         and r.expires_at > now()
         and btrim(coalesce(p_body, '')) ~ '^[1-5][[:space:].!]*$';
      if found then
        v_rating := true;
        insert into public.wa_conversation_events (organization_id, conversation_id, kind, note)
        values (v_org, v_conv.id, 'avaliada', substring(btrim(p_body) from 1 for 1));
      else
        -- Comentário depois de uma nota baixa: a próxima mensagem de texto em até 2 h.
        update public.wa_ratings r
           set feedback = left(btrim(p_body), 1000), comment_at = now()
         where r.conversation_id = v_conv.id and r.feedback is null and r.comment_requested_at is not null
           and r.comment_requested_at > now() - interval '2 hours' and btrim(coalesce(p_body, '')) <> '';
        if found then v_rating := true; v_comment := true; end if;
      end if;
    end if;
    v_preview := left(coalesce($r$);
    v_new := replace(v_new, 'status               = case when p_from_me then c.status else ''aberta'' end,',
                            'status               = case when p_from_me or v_rating then c.status else ''aberta'' end,');
    v_new := replace(v_new, 'else c.unread_count + 1 end,', 'else c.unread_count + (case when v_rating and not v_comment then 0 else 1 end) end,');
    v_new := replace(v_new, E'if not p_from_me then\n      -- Cliente escreveu', E'if not p_from_me and not v_rating then\n      -- Cliente escreveu');
    if position('v_rating then c.status' in v_new) = 0 or position('v_rating and not v_comment' in v_new) = 0
       or position('not v_rating then' in v_new) = 0 or position('wa_ratings r' in v_new) = 0 or position('is_system = true' in v_new) = 0
       or position('v_rating   boolean' in v_new) = 0 or position('v_comment  boolean' in v_new) = 0 then
      raise exception 'wa_ingest_message: trechos esperados não encontrados';
    end if;
    execute v_new;
  end if;

  -- wa_auto_reply_pick: o agradecimento sai antes de saudação e ausência.
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'wa_auto_reply_pick' and p.prokind = 'f';
  if v_def is null then raise exception 'wa_auto_reply_pick não encontrada'; end if;

  if position('thanks_sent_at' in v_def) = 0 then
    v_new := replace(v_def, 'v_hours := coalesce(v_set.business_hours,',
      $r$-- Acabou de chegar o comentário da avaliação: não responde nada.
  if exists (select 1 from public.wa_ratings r where r.conversation_id = v_conv.id and r.comment_at > now() - interval '1 minute') then
    return null;
  end if;

  if exists (select 1 from public.wa_ratings r where r.conversation_id = v_conv.id and r.score is not null and r.thanks_sent_at is null) then
    select r.score into v_n from public.wa_ratings r
     where r.conversation_id = v_conv.id and r.score is not null and r.thanks_sent_at is null
     order by r.answered_at desc limit 1;
    update public.wa_ratings r
       set thanks_sent_at = now(),
           comment_requested_at = case when v_n <= 3 and v_set.rating_comment_on then now() end
     where r.conversation_id = v_conv.id and r.score is not null and r.thanks_sent_at is null;
    if v_set.rating_on then
      v_text := coalesce(nullif(btrim(v_set.rating_thanks_text), ''), 'Obrigado pela sua avaliação! Ela nos ajuda a melhorar.');
      if v_n <= 3 and v_set.rating_comment_on then
        v_text := v_text || E'\n\n' || coalesce(nullif(btrim(v_set.rating_comment_text), ''),
          'Sentimos muito que não tenha sido uma boa experiência. Quer nos contar o que aconteceu? É só responder esta mensagem.');
      end if;
      return v_text;
    end if;
    return null;
  end if;

  v_hours := coalesce(v_set.business_hours,$r$);
    if position('thanks_sent_at' in v_new) = 0 then
      raise exception 'wa_auto_reply_pick: trecho esperado não encontrado';
    end if;
    execute v_new;
  end if;
end
$mig$;
