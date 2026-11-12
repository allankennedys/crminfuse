-- ============================================================
-- Soma de vendas dos contatos filtrados, no banco
--
-- A aba Contatos mostrava "quanto o filtro vendeu" baixando os contatos de
-- 1000 em 1000 e somando no navegador: uma busca larga fazia 6+ requisições
-- seguidas a cada mudança de filtro. Esta função devolve só o número.
--
-- ESPELHA applyContactFilters (src/services/crmService.ts). Quem muda um
-- precisa mudar o outro. O cliente prepara o texto da busca (remove
-- caracteres que quebram o .or(), calcula dígitos e variantes de telefone)
-- e passa pronto: aqui só se aplica.
--
-- security invoker: o RLS de crm_contacts continua isolando por organização,
-- exatamente como na consulta que esta função substitui.
--
-- SQL montado só com as condições pedidas, e valores por USING: um plano
-- genérico com "p is null or ..." não usaria os índices trigram (107/108).
-- ============================================================

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
  p_with_sales boolean default false
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
        || ' or phone_key = any($3))';
    else
      v_sql := v_sql || ' and (name ilike ''%'' || $1 || ''%'''
        || ' or email ilike ''%'' || $1 || ''%'''
        || ' or phone ilike ''%'' || $1 || ''%'''
        || ' or conversation_id ilike ''%'' || $1 || ''%'')';
    end if;
  end if;
  if p_tags is not null and cardinality(p_tags) > 0 then v_sql := v_sql || ' and tags @> $4'; end if;
  if p_stage_id is not null then v_sql := v_sql || ' and stage_id = $5'; end if;
  if p_out_of_funnel then v_sql := v_sql || ' and stage_id is null'; end if;
  if p_channel is not null then v_sql := v_sql || ' and channel = $6'; end if;
  if p_no_origem then v_sql := v_sql || ' and (origem is null or origem = '''')'; end if;
  if p_origem is not null then v_sql := v_sql || ' and origem ilike $7'; end if;
  if p_with_sales then v_sql := v_sql || ' and sales_count > 0'; end if;

  execute v_sql into v_total
    using p_safe, p_digits, coalesce(p_keys, '{}'::text[]), p_tags, p_stage_id, p_channel, p_origem;
  return v_total;
end $$;

grant execute on function public.crm_contacts_sales_sum(
  text, text, text[], text[], uuid, boolean, text, boolean, text, boolean
) to authenticated;
