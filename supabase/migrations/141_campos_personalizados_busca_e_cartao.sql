-- ============================================================
-- Campos personalizados: busca, filtro e cartão do funil
--
-- BUSCA. A caixa de busca de Contatos passa a olhar também o texto dos
-- campos personalizados. custom_text junta os valores de um contato num
-- texto só (sem as chaves, que são ids); custom_search é a mesma coisa
-- como "coluna calculada", que o PostgREST aceita em filtro. O índice
-- trigram deixa o ilike '%trecho%' usar índice, como nos outros campos (107).
--
-- FILTRO. Por campo e valor exato, com custom @> '{"id": "valor"}'. A soma
-- de vendas da lista (crm_contacts_sales_sum) espelha o filtro e a busca:
-- mudou um, mude o outro.
--
-- CARTÃO. show_on_card marca os campos que aparecem no card do kanban.
-- ============================================================

alter table public.crm_custom_fields
  add column if not exists show_on_card boolean not null default false;

create or replace function public.custom_text(p jsonb)
returns text
language sql immutable parallel safe as $$
  select coalesce(string_agg(v, ' '), '') from jsonb_each_text(coalesce(p, '{}'::jsonb)) as t(k, v);
$$;

create or replace function public.custom_search(c public.crm_contacts)
returns text
language sql immutable parallel safe as $$
  select public.custom_text(c.custom);
$$;

create index if not exists idx_crm_contacts_custom_trgm
  on public.crm_contacts using gin (public.custom_text(custom) extensions.gin_trgm_ops);

-- Assinatura nova (p_custom): troca a antiga.
drop function if exists public.crm_contacts_sales_sum(
  text, text, text[], text[], uuid, boolean, text, boolean, text, boolean
);

create or replace function public.crm_contacts_sales_sum(
  p_safe text default null,           -- busca já sem % , ( ) " \ :
  p_digits text default null,         -- dígitos, quando a busca parece telefone
  p_keys text[] default null,         -- variantes de phone_key do número
  p_tags text[] default null,
  p_stage_id uuid default null,
  p_out_of_funnel boolean default false,
  p_channel text default null,
  p_no_origem boolean default false,
  p_origem text default null,         -- já com \ % _ escapados (ilike)
  p_with_sales boolean default false,
  p_custom jsonb default null         -- campo personalizado: custom @> $8 (141)
) returns bigint
language plpgsql stable security invoker set search_path = public as $$
declare
  v_sql text := 'select coalesce(sum(sales_total_cents), 0)::bigint from public.crm_contacts where true';
  v_total bigint;
begin
  if p_safe is not null then
    if p_digits is not null and p_digits <> '' then
      v_sql := v_sql || ' and (name ilike ''%'' || $1 || ''%'''
        || ' or email ilike ''%'' || $1 || ''%'''
        || ' or phone ilike ''%'' || $2 || ''%'''
        || ' or phone_key ilike ''%'' || $2 || ''%'''
        || ' or conversation_id ilike ''%'' || $2 || ''%'''
        || ' or public.custom_text(custom) ilike ''%'' || $1 || ''%'''
        || ' or phone_key = any($3))';
    else
      v_sql := v_sql || ' and (name ilike ''%'' || $1 || ''%'''
        || ' or email ilike ''%'' || $1 || ''%'''
        || ' or phone ilike ''%'' || $1 || ''%'''
        || ' or conversation_id ilike ''%'' || $1 || ''%'''
        || ' or public.custom_text(custom) ilike ''%'' || $1 || ''%'')';
    end if;
  end if;
  if p_tags is not null and cardinality(p_tags) > 0 then v_sql := v_sql || ' and tags @> $4'; end if;
  if p_stage_id is not null then v_sql := v_sql || ' and stage_id = $5'; end if;
  if p_out_of_funnel then v_sql := v_sql || ' and stage_id is null'; end if;
  if p_channel is not null then v_sql := v_sql || ' and channel = $6'; end if;
  if p_no_origem then v_sql := v_sql || ' and (origem is null or origem = '''')'; end if;
  if p_origem is not null then v_sql := v_sql || ' and origem ilike $7'; end if;
  if p_with_sales then v_sql := v_sql || ' and sales_count > 0'; end if;
  if p_custom is not null then v_sql := v_sql || ' and custom @> $8'; end if;

  execute v_sql into v_total
    using p_safe, p_digits, coalesce(p_keys, '{}'::text[]), p_tags, p_stage_id, p_channel, p_origem, p_custom;
  return v_total;
end $$;

grant execute on function public.crm_contacts_sales_sum(
  text, text, text[], text[], uuid, boolean, text, boolean, text, boolean, jsonb
) to authenticated;
