-- ============================================================
-- Filtro por data no atendimento: abertura, conclusão ou última interação
--
-- Amplia wa_conversas_filtradas (133) com um recorte por data:
--   'abertura'  → quando o atendimento atual da conversa foi aberto
--   'conclusao' → quando o atendimento atual foi concluído (só concluídos)
--   'interacao' → última mensagem da conversa (de qualquer lado)
-- "Atendimento atual" = o mais recente da conversa (wa_tickets).
-- p_de é inclusivo e p_ate é exclusivo (o cliente manda a meia-noite de SP
-- do dia seguinte ao último dia escolhido).
-- ============================================================

drop function if exists public.wa_conversas_filtradas(text[], text, text);

create or replace function public.wa_conversas_filtradas(
  p_tags      text[]      default null,
  p_compra    text        default null,
  p_anuncio   text        default null,
  p_data_tipo text        default null,   -- 'abertura' | 'conclusao' | 'interacao'
  p_de        timestamptz default null,
  p_ate       timestamptz default null
)
returns setof public.wa_conversations
language sql stable security definer set search_path = public as $$
  select c.*
  from public.wa_conversations c
  left join public.crm_contacts ct on ct.id = c.contact_id
  left join lateral (
    select t.opened_at, t.closed_at
    from public.wa_tickets t
    where t.conversation_id = c.id
    order by t.opened_at desc
    limit 1
  ) tk on true
  where public.wa_can_see(c.organization_id, c.assigned_to)
    and (p_tags is null or cardinality(p_tags) = 0
         or (ct.id is not null and ct.tags @> p_tags))
    and (p_compra is null
         or (p_compra = 'com' and coalesce(ct.sales_count, 0) > 0)
         or (p_compra = 'sem' and coalesce(ct.sales_count, 0) = 0))
    and (p_anuncio is null
         or (p_anuncio = 'sim' and (
               nullif(btrim(coalesce(ct.ctwaclid, '')), '') is not null
               or public.crm_origem_is_ad(ct.origem)
               or c.ad_ctwa_clid is not null))
         or (p_anuncio = 'nao' and not (
               nullif(btrim(coalesce(ct.ctwaclid, '')), '') is not null
               or public.crm_origem_is_ad(ct.origem)
               or c.ad_ctwa_clid is not null)))
    and (p_data_tipo is null or (
          (p_data_tipo = 'abertura'  and (p_de is null or tk.opened_at >= p_de) and (p_ate is null or tk.opened_at < p_ate) and tk.opened_at is not null)
       or (p_data_tipo = 'conclusao' and (p_de is null or tk.closed_at >= p_de) and (p_ate is null or tk.closed_at < p_ate) and tk.closed_at is not null)
       or (p_data_tipo = 'interacao' and (p_de is null or c.last_message_at >= p_de) and (p_ate is null or c.last_message_at < p_ate) and c.last_message_at is not null)
    ));
$$;

revoke all on function public.wa_conversas_filtradas(text[], text, text, text, timestamptz, timestamptz) from public, anon;
grant execute on function public.wa_conversas_filtradas(text[], text, text, text, timestamptz, timestamptz) to authenticated;
