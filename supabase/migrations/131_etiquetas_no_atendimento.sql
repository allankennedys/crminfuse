-- ============================================================
-- Etiquetas no atendimento
--
-- As etiquetas são as do contato do CRM (crm_contacts.tags). O atendente as
-- vê e edita no painel do cliente, sem ganhar acesso ao CRM: a porta é a
-- conversa, conferida por wa_visible_conversation, como no resto do cartão.
-- ============================================================

create or replace function public.wa_client_card(p_conversation uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_conv public.wa_conversations := public.wa_visible_conversation(p_conversation);
  v_ct   public.crm_contacts;
  v_out  jsonb;
begin
  select * into v_ct from public.crm_contacts ct where ct.id = v_conv.contact_id;

  select jsonb_build_object(
    'contact', case when v_ct.id is null then null else jsonb_build_object(
      'id', v_ct.id,
      'name', v_ct.name,
      'phone', v_ct.phone,
      'email', v_ct.email,
      'origem', v_ct.origem,
      'channel', v_ct.channel,
      'stage', (select s.name from public.crm_stages s where s.id = v_ct.stage_id),
      'sales_count', coalesce(v_ct.sales_count, 0),
      'sales_total_cents', coalesce(v_ct.sales_total_cents, 0),
      'from_ad', nullif(btrim(coalesce(v_ct.ctwaclid, '')), '') is not null or public.crm_origem_is_ad(v_ct.origem),
      'has_click', nullif(btrim(coalesce(v_ct.ctwaclid, '')), '') is not null,
      'tags', to_jsonb(coalesce(v_ct.tags, '{}'::text[])),
      'created_at', v_ct.created_at
    ) end,
    'ad', case when v_conv.ad_ctwa_clid is null and v_conv.ad_source_id is null then null else jsonb_build_object(
      'app', v_conv.ad_source_app, 'title', v_conv.ad_title, 'url', v_conv.ad_source_url, 'at', v_conv.ad_at
    ) end,
    -- Etiquetas já usadas na organização (as dos contatos mais recentes).
    'tag_options', (
      select coalesce(jsonb_agg(t order by t), '[]'::jsonb) from (
        select distinct t from (
          select unnest(ct.tags) as t from public.crm_contacts ct
          where ct.organization_id = v_conv.organization_id
          order by ct.created_at desc limit 1000
        ) u
      ) x
    ),
    'sales', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'value_cents', s.value_cents, 'sold_at', s.sold_at, 'payment_method', s.payment_method
      ) order by s.sold_at desc), '[]'::jsonb)
      from (
        select * from public.crm_sales s where s.contact_id = v_ct.id order by s.sold_at desc limit 5
      ) s
    ),
    -- Sugestões para o campo origem: as das frases e as mais usadas.
    'origens', (
      select coalesce(jsonb_agg(o order by o), '[]'::jsonb) from (
        select distinct btrim(r.origem) as o from public.wa_source_rules r
        where r.organization_id = v_conv.organization_id
        union
        select o from (
          select btrim(ct.origem) as o, count(*) as n from public.crm_contacts ct
          where ct.organization_id = v_conv.organization_id and nullif(btrim(coalesce(ct.origem, '')), '') is not null
          group by 1 order by 2 desc limit 15
        ) top
        union select 'Anúncio Instagram' union select 'Anúncio Facebook' union select 'Indicação'
      ) x
    )
  ) into v_out;
  return v_out;
end;
$$;

create or replace function public.wa_client_set_tags(p_conversation uuid, p_tags text[])
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_conv public.wa_conversations := public.wa_visible_conversation(p_conversation);
  v_id   uuid;
  v_tags text[];
begin
  v_id := public.wa_ensure_contact(v_conv.id);
  -- Limpa, tira repetidas (sem diferenciar caixa) e limita.
  select coalesce(array_agg(t order by n), '{}') into v_tags from (
    select distinct on (lower(btrim(x))) btrim(x) as t, n
    from unnest(coalesce(p_tags, '{}')) with ordinality as u(x, n)
    where btrim(x) <> '' and length(btrim(x)) <= 40
    order by lower(btrim(x)), n
  ) d;
  v_tags := v_tags[1:30];
  update public.crm_contacts ct set tags = v_tags where ct.id = v_id;
  return public.wa_client_card(v_conv.id);
end;
$$;

revoke all on function public.wa_client_set_tags(uuid, text[]) from public, anon;
grant execute on function public.wa_client_set_tags(uuid, text[]) to authenticated;
