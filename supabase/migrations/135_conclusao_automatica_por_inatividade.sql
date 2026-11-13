-- ============================================================
-- Conclusão automática por inatividade
--
-- wa_settings.auto_conclude_hours: null = desligado. Ligado, o atendimento em
-- aberto cuja ÚLTIMA mensagem (de qualquer lado) é mais antiga que esse
-- tempo é concluído sozinho, com o motivo "Sem interação" e a nota dizendo
-- que foi automático. Só vale para conversa COM responsável: a da Fila, que
-- ninguém pegou ainda, fica como está. Se o cliente escrever depois, a conversa reabre como
-- sempre (wa_ingest_message).
--
-- Roda a cada 10 minutos pelo pg_cron, direto no banco.
-- ============================================================

alter table public.wa_settings
  add column if not exists auto_conclude_hours int
  check (auto_conclude_hours is null or auto_conclude_hours between 1 and 8760);

create or replace function public.wa_auto_conclude()
returns int
language plpgsql security definer set search_path = public as $$
declare
  r       record;
  v_ids   uuid[];
  v_total int := 0;
begin
  for r in
    select s.organization_id, s.auto_conclude_hours as h
    from public.wa_settings s
    where s.auto_conclude_hours is not null
  loop
    select coalesce(array_agg(c.id), '{}') into v_ids
    from public.wa_conversations c
    where c.organization_id = r.organization_id
      and c.status = 'aberta'
      -- Conversa na Fila (sem responsável) nunca é concluída sozinha: ninguém
      -- atendeu ainda, e concluir esconderia o cliente que está esperando.
      and c.assigned_to is not null
      and coalesce(c.last_message_at, c.updated_at) < now() - make_interval(hours => r.h);

    if cardinality(v_ids) = 0 then
      continue;
    end if;

    update public.wa_tickets t set
      status = 'concluido', closed_at = clock_timestamp(), closed_by = null,
      conclusion = 'Sem interação',
      conclusion_note = 'Concluído automaticamente após ' || r.h || ' h sem mensagens.'
    where t.conversation_id = any(v_ids) and t.status <> 'concluido';

    update public.wa_conversations c set status = 'resolvida', updated_at = now()
    where c.id = any(v_ids);

    insert into public.wa_conversation_events (organization_id, conversation_id, kind, by_user, note)
    select r.organization_id, x, 'resolvida', null,
           'Sem interação: concluído automaticamente após ' || r.h || ' h sem mensagens.'
    from unnest(v_ids) x;

    perform public.wa_dispatch_queue(r.organization_id);
    v_total := v_total + cardinality(v_ids);
  end loop;
  return v_total;
end;
$$;

revoke all on function public.wa_auto_conclude() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule('wa-auto-conclude');
exception when others then null;
end;
$$;

select cron.schedule('wa-auto-conclude', '*/10 * * * *', $$select public.wa_auto_conclude()$$);
