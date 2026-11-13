-- ============================================================
-- Filtros do atendimento por dados do contato: etiqueta, compra e anúncio
--
-- A lista de conversas lê as tabelas direto (a RLS recorta por atendente),
-- mas o atendente sem "ver contatos" não lê crm_contacts, então não dá para
-- filtrar por etiqueta/compra com um join do cliente. Estas funções fazem o
-- recorte no banco e devolvem só conversas que a pessoa já enxerga
-- (wa_can_see), como no resto do atendimento (121).
-- ============================================================

create or replace function public.wa_conversas_filtradas(
  p_tags   text[] default null,     -- contato precisa ter TODAS
  p_compra text   default null,     -- 'com' | 'sem'
  p_anuncio text  default null      -- 'sim' | 'nao'
)
returns setof public.wa_conversations
language sql stable security definer set search_path = public as $$
  select c.*
  from public.wa_conversations c
  left join public.crm_contacts ct on ct.id = c.contact_id
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
               or c.ad_ctwa_clid is not null)));
$$;

-- Etiquetas da organização, para a lista do filtro.
create or replace function public.wa_etiquetas()
returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(t order by t), '{}') from (
    select distinct t from (
      select unnest(ct.tags) as t from public.crm_contacts ct
      where ct.organization_id = public.current_org_id()
      order by ct.created_at desc limit 2000
    ) u
  ) x;
$$;

revoke all on function public.wa_conversas_filtradas(text[], text, text) from public, anon;
revoke all on function public.wa_etiquetas() from public, anon;
grant execute on function public.wa_conversas_filtradas(text[], text, text) to authenticated;
grant execute on function public.wa_etiquetas() to authenticated;
