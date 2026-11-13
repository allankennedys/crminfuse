-- ============================================================
-- Campos personalizados nos contatos
--
-- A organização define campos (texto, número, data ou lista) e cada contato
-- guarda os valores em crm_contacts.custom, um objeto { id_do_campo: valor }.
-- Valor sempre como texto: número com ponto, data "AAAA-MM-DD".
-- O atendente edita pela conversa (wa_client_set_custom) sem ganhar acesso ao
-- CRM inteiro, como no resto do cartão do cliente (121).
-- ============================================================

create table if not exists public.crm_custom_fields (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name            text not null check (length(btrim(name)) between 1 and 60),
  kind            text not null check (kind in ('texto', 'numero', 'data', 'lista')),
  options         text[] not null default '{}',
  position        int not null default 0,
  created_at      timestamptz not null default now()
);
create unique index if not exists uq_crm_custom_fields_name
  on public.crm_custom_fields(organization_id, lower(btrim(name)));

alter table public.crm_custom_fields enable row level security;
drop policy if exists crm_cf_select on public.crm_custom_fields;
create policy crm_cf_select on public.crm_custom_fields
  for select using (organization_id = public.current_org_id() and public.current_user_can('crm.contatos.ver'));
drop policy if exists crm_cf_write on public.crm_custom_fields;
create policy crm_cf_write on public.crm_custom_fields
  for all using (organization_id = public.current_org_id() and public.current_user_can('crm.etapas.editar'))
  with check (organization_id = public.current_org_id() and public.current_user_can('crm.etapas.editar'));

alter table public.crm_contacts
  add column if not exists custom jsonb not null default '{}'::jsonb;
alter table public.crm_contacts drop constraint if exists crm_contacts_custom_size;
alter table public.crm_contacts add constraint crm_contacts_custom_size
  check (jsonb_typeof(custom) = 'object' and pg_column_size(custom) < 20000);

-- Apagar o campo apaga o valor dele nos contatos.
create or replace function public.crm_custom_field_cleanup()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.crm_contacts ct set custom = ct.custom - old.id::text
  where ct.organization_id = old.organization_id and ct.custom ? old.id::text;
  return old;
end;
$$;
drop trigger if exists crm_custom_field_cleanup on public.crm_custom_fields;
create trigger crm_custom_field_cleanup
  after delete on public.crm_custom_fields
  for each row execute function public.crm_custom_field_cleanup();

-- ---------- Cartão do cliente no atendimento ----------
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
      'custom', coalesce(v_ct.custom, '{}'::jsonb),
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
    -- Campos personalizados da organização (140), na ordem de cadastro.
    'custom_fields', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', cf.id, 'name', cf.name, 'kind', cf.kind, 'options', to_jsonb(cf.options)
      ) order by cf.position, cf.created_at), '[]'::jsonb)
      from public.crm_custom_fields cf where cf.organization_id = v_conv.organization_id
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

create or replace function public.wa_client_set_custom(p_conversation uuid, p_custom jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_conv public.wa_conversations := public.wa_visible_conversation(p_conversation);
  v_id   uuid;
  v_out  jsonb := '{}'::jsonb;
  r      record;
  v_val  text;
begin
  v_id := public.wa_ensure_contact(v_conv.id);
  -- Só campos que existem na organização; valor vazio some; tamanho limitado.
  for r in select cf.id, cf.kind, cf.options from public.crm_custom_fields cf
           where cf.organization_id = v_conv.organization_id loop
    v_val := nullif(btrim(coalesce(p_custom ->> r.id::text, '')), '');
    if v_val is null then continue; end if;
    v_val := left(v_val, 200);
    if r.kind = 'numero' and v_val !~ '^-?[0-9]+([.][0-9]+)?$' then
      raise exception 'Campo numérico com valor inválido';
    end if;
    if r.kind = 'data' and v_val !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'Campo de data com valor inválido';
    end if;
    if r.kind = 'lista' and not (v_val = any(r.options)) then
      continue;
    end if;
    v_out := v_out || jsonb_build_object(r.id::text, v_val);
  end loop;
  update public.crm_contacts ct set custom = v_out where ct.id = v_id;
  return public.wa_client_card(v_conv.id);
end;
$$;
revoke all on function public.wa_client_set_custom(uuid, jsonb) from public, anon;
grant execute on function public.wa_client_set_custom(uuid, jsonb) to authenticated;

-- ---------- Unificar cadastros leva os campos ----------
-- O valor do sobrevivente vale; o que só o descartado tinha sobe. Em vez de
-- recopiar as duas funções de fusão, acrescenta a linha a cada uma.
do $$
declare
  r     record;
  v_def text;
  v_new text;
  v_n   int := 0;
begin
  for r in
    select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname in ('crm_merge_contacts', 'crm_merge_duplicate_contacts')
  loop
    v_def := pg_get_functiondef(r.oid);
    if position('custom = coalesce(' in v_def) > 0 then continue; end if;
    v_new := regexp_replace(
      v_def,
      'tags\s+=\s+\(select array\(select distinct unnest\(s\.tags \|\| coalesce\((\w+)\.tags, ''\{\}''\)\)\)\),',
      E'\\&\n    custom = coalesce(\\1.custom, ''{}''::jsonb) || coalesce(s.custom, ''{}''::jsonb),'
    );
    if v_new = v_def then
      raise exception 'Fusão %: trecho das etiquetas não encontrado', r.proname;
    end if;
    execute v_new;
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then
    raise notice 'Nenhuma função de fusão precisou de ajuste';
  end if;
end;
$$;
