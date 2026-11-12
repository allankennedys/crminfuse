-- ============================================================
-- Conserto da 123: crm_report_sales (resumo de Vendas) usa
-- crm_sales_metrics por dentro. A 123 apagou a segunda achando que só a API
-- de automações a usava — volta aqui, sem criativos, com o acesso de antes
-- (só service role; quem a tela chama é crm_report_sales).
-- ============================================================

drop function if exists public.crm_report_sales(date, date, text);

CREATE OR REPLACE FUNCTION public.crm_sales_metrics(p_org uuid, p_from date DEFAULT (((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date - 29), p_to date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date, p_channel text DEFAULT NULL::text)
 RETURNS TABLE(sales bigint, first_sales bigint, repeat_sales bigint, clients bigint, revenue_cents bigint, avg_ticket_cents bigint, ltv_cents bigint, total_sales bigint, total_clients bigint, total_revenue_cents bigint, total_avg_ticket_cents bigint, total_ltv_cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with todas as (
    select
      v.contact_id,
      v.sold_at,
      v.value_cents,
      row_number() over (
        partition by v.contact_id order by v.sold_at, v.created_at, v.id
      ) as seq
    from public.crm_sales v
    join public.crm_contacts c on c.id = v.contact_id
    where v.organization_id = p_org
      and (p_channel is null or c.channel = p_channel)
  ),
  periodo as (
    select * from todas
    where todas.sold_at >= public.crm_day_start(p_from)
      and todas.sold_at < public.crm_day_start(p_to + 1)
  )
  select
    (select count(*) from periodo p)::bigint,
    (select count(*) from periodo p where p.seq = 1)::bigint,
    (select count(*) from periodo p where p.seq > 1)::bigint,
    (select count(distinct p.contact_id) from periodo p)::bigint,
    (select coalesce(sum(p.value_cents), 0) from periodo p)::bigint,
    -- ÷ vendas
    (select (coalesce(sum(p.value_cents), 0) / nullif(count(*), 0))::bigint from periodo p),
    -- ÷ clientes distintos. No período isto é "receita por cliente ativo na
    -- janela", não o LTV do cliente: quem comprou em janeiro e recomprou em
    -- julho conta como uma venda só se a janela for julho. O LTV de verdade é
    -- o total_ltv_cents abaixo.
    (select (coalesce(sum(p.value_cents), 0)
             / nullif(count(distinct p.contact_id), 0))::bigint from periodo p),
    (select count(*) from todas t)::bigint,
    (select count(distinct t.contact_id) from todas t)::bigint,
    (select coalesce(sum(t.value_cents), 0) from todas t)::bigint,
    (select (coalesce(sum(t.value_cents), 0) / nullif(count(*), 0))::bigint from todas t),
    (select (coalesce(sum(t.value_cents), 0)
             / nullif(count(distinct t.contact_id), 0))::bigint from todas t);
$function$;

revoke all on function public.crm_sales_metrics(uuid, date, date, text) from public, anon, authenticated;
grant execute on function public.crm_sales_metrics(uuid, date, date, text) to service_role;

CREATE OR REPLACE FUNCTION public.crm_report_sales(p_from date DEFAULT (((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date - 29), p_to date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date, p_channel text DEFAULT NULL::text)
 RETURNS TABLE(sales bigint, first_sales bigint, repeat_sales bigint, clients bigint, revenue_cents bigint, avg_ticket_cents bigint, ltv_cents bigint, total_sales bigint, total_clients bigint, total_revenue_cents bigint, total_avg_ticket_cents bigint, total_ltv_cents bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select * from public.crm_sales_metrics(public.current_org_id(), p_from, p_to, p_channel);
$function$;
