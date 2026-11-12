-- ============================================================
-- Sem "criativos" no sistema
--
-- Quantidade de criativos por venda era da operação da PH. A coluna sai de
-- crm_sales e das funções que a usavam; os relatórios perdem a coluna
-- correspondente. crm_sales_metrics (só a API de automações usava, e ela
-- saiu na 122) é apagada.
-- ============================================================

drop function if exists public.crm_sales_metrics(uuid, date, date, text);

drop function if exists public.crm_report_sales_timeseries(date, date, text);
CREATE OR REPLACE FUNCTION public.crm_report_sales_timeseries(p_from date DEFAULT (((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date - 29), p_to date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date, p_channel text DEFAULT NULL::text)
 RETURNS TABLE(day date, sales bigint, revenue_cents bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with dias as (
    -- ::timestamp explícito: com datas puras o Postgres escolheria a
    -- sobrecarga timestamptz e o ::date de volta passaria pelo fuso da
    -- sessão. Aqui a série é só rótulo de dia e não depende de fuso nenhum.
    select gs::date as day
    from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') gs
  ),
  vendas as (
    select
      (v.sold_at at time zone 'America/Sao_Paulo')::date as day,
      count(*) as sales,
      sum(v.value_cents) as revenue_cents
    from public.crm_sales v
    join public.crm_contacts c on c.id = v.contact_id
    where v.organization_id = public.current_org_id()
      and v.sold_at >= public.crm_day_start(p_from)
      and v.sold_at < public.crm_day_start(p_to + 1)
      and (p_channel is null or c.channel = p_channel)
    group by 1
  )
  select
    d.day,
    coalesce(v.sales, 0)::bigint,
    coalesce(v.revenue_cents, 0)::bigint
  from dias d
  left join vendas v on v.day = d.day
  order by d.day;
$function$;

drop function if exists public.crm_report_sales_by_contact(date, date, text, integer);
CREATE OR REPLACE FUNCTION public.crm_report_sales_by_contact(p_from date DEFAULT (((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date - 29), p_to date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date, p_channel text DEFAULT NULL::text, p_limit integer DEFAULT 20)
 RETURNS TABLE(contact_id uuid, name text, channel text, sales bigint, revenue_cents bigint, first_sale_at timestamp with time zone, last_sale_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    c.id,
    c.name,
    c.channel,
    count(*)::bigint,
    coalesce(sum(v.value_cents), 0)::bigint,
    min(v.sold_at),
    max(v.sold_at)
  from public.crm_sales v
  join public.crm_contacts c on c.id = v.contact_id
  where v.organization_id = public.current_org_id()
    and v.sold_at >= public.crm_day_start(p_from)
    and v.sold_at < public.crm_day_start(p_to + 1)
    and (p_channel is null or c.channel = p_channel)
  group by c.id, c.name, c.channel
  order by sum(v.value_cents) desc, count(*) desc, c.name
  limit greatest(p_limit, 1);
$function$;

CREATE OR REPLACE FUNCTION public.crm_sale_from_stage()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_converts boolean;
  v_was_conversion boolean;
begin
  -- Etapa não mudou: nada a fazer. Também é o que torna inofensivo o UPDATE
  -- que a própria trigger de vendas faz no contato.
  if tg_op = 'UPDATE' and old.stage_id is not distinct from new.stage_id then
    return null;
  end if;

  select is_conversion into v_converts
  from public.crm_stages where id = new.stage_id;

  if not coalesce(v_converts, false) then
    return null;
  end if;

  -- Veio de outra etapa que já convertia: não é conversão nova.
  if tg_op = 'UPDATE' then
    select is_conversion into v_was_conversion
    from public.crm_stages where id = old.stage_id;

    if coalesce(v_was_conversion, false) then
      return null;
    end if;
  end if;

  if coalesce(new.value_cents, 0) <= 0 then
    return null;
  end if;

  -- Já tem venda: ou foi a venda que trouxe o contato para cá (031), ou ele
  -- já comprou antes. Nos dois casos não cabe criar outra.
  if exists (select 1 from public.crm_sales where contact_id = new.id) then
    return null;
  end if;

  insert into public.crm_sales (
    organization_id, contact_id, value_cents, sold_at, note
  ) values (
    new.organization_id,
    new.id,
    new.value_cents,
    now(),
    'Criada ao entrar na etapa de conversão'
  );

  return null;
end;
$function$;

drop function if exists public.crm_report_ads_overview(date, date, text);
CREATE OR REPLACE FUNCTION public.crm_report_ads_overview(p_from date DEFAULT (((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date - 29), p_to date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date, p_channel text DEFAULT NULL::text)
 RETURNS TABLE(leads bigint, leads_ctwa bigint, leads_all bigint, conversions bigint, new_clients bigint, clients bigint, sales bigint, first_sales bigint, repeat_sales bigint, revenue_cents bigint, avg_ticket_cents bigint, ltv_period_cents bigint, total_clients bigint, total_sales bigint, total_revenue_cents bigint, total_avg_ticket_cents bigint, total_ltv_cents bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with ads as (
    select c.id, c.created_at, c.ctwaclid, c.fbc, c.campaign_id
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and (p_channel is null or c.channel = p_channel)
      and public.crm_is_ad_contact(c.ctwaclid, c.fbc, c.campaign_id, c.origem)
  ),
  leads_janela as (
    select a.* from ads a
    where a.created_at >= public.crm_day_start(p_from)
      and a.created_at <  public.crm_day_start(p_to + 1)
  ),
  -- Denominador da fatia "quanto da entrada veio de mídia paga".
  entrada_total as (
    select count(*)::bigint as n
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and (p_channel is null or c.channel = p_channel)
      and c.created_at >= public.crm_day_start(p_from)
      and c.created_at <  public.crm_day_start(p_to + 1)
  ),
  -- Primeira conversão da vida de cada contato de anúncio (048): reentrar
  -- na etapa não conta de novo.
  primeira_conversao as (
    select h.contact_id, min(h.created_at) as convertido_em
    from public.crm_stage_history h
    join public.crm_stages s on s.id = h.to_stage_id
    join ads a on a.id = h.contact_id
    where s.is_conversion
    group by h.contact_id
  ),
  -- seq é a ordem da venda na VIDA do cliente, não dentro da janela — é
  -- assim que "1ª venda" continua significando aquisição mesmo quando o
  -- período começa no meio da história dele (mesma tupla de 031/046).
  vendas as (
    select
      v.contact_id, v.sold_at, v.value_cents,
      row_number() over (
        partition by v.contact_id order by v.sold_at, v.created_at, v.id
      ) as seq
    from public.crm_sales v
    join ads a on a.id = v.contact_id
  ),
  periodo as (
    select v.* from vendas v
    where v.sold_at >= public.crm_day_start(p_from)
      and v.sold_at <  public.crm_day_start(p_to + 1)
  )
  select
    (select count(*) from leads_janela)::bigint,
    -- Clique rastreado: CTWA (ctwa_clid) ou landing (fbc + campanha).
    (select count(*) from leads_janela l
      where coalesce(l.ctwaclid, '') <> ''
         or (coalesce(l.fbc, '') <> '' and coalesce(l.campaign_id, '') <> ''))::bigint,
    (select n from entrada_total),
    (select count(*) from primeira_conversao pc
      where pc.convertido_em >= public.crm_day_start(p_from)
        and pc.convertido_em <  public.crm_day_start(p_to + 1))::bigint,
    -- new_clients e first_sales dão o mesmo número por construção (seq = 1
    -- é único por contato). São duas colunas de propósito: uma é
    -- denominador de CAC, a outra é a quebra "1ª venda x recompra" do
    -- ticket. Fundi-las obrigaria a tela a saber que são a mesma coisa.
    (select count(*) from periodo p where p.seq = 1)::bigint,
    (select count(distinct p.contact_id) from periodo p)::bigint,
    (select count(*) from periodo p)::bigint,
    (select count(*) from periodo p where p.seq = 1)::bigint,
    (select count(*) from periodo p where p.seq > 1)::bigint,
    (select coalesce(sum(p.value_cents), 0) from periodo p)::bigint,
    -- ÷ vendas
    (select (coalesce(sum(p.value_cents), 0) / nullif(count(*), 0))::bigint from periodo p),
    -- ÷ clientes ativos na janela
    (select (coalesce(sum(p.value_cents), 0)
             / nullif(count(distinct p.contact_id), 0))::bigint from periodo p),
    (select count(distinct v.contact_id) from vendas v)::bigint,
    (select count(*) from vendas v)::bigint,
    (select coalesce(sum(v.value_cents), 0) from vendas v)::bigint,
    (select (coalesce(sum(v.value_cents), 0) / nullif(count(*), 0))::bigint from vendas v),
    (select (coalesce(sum(v.value_cents), 0)
             / nullif(count(distinct v.contact_id), 0))::bigint from vendas v);
$function$;

alter table public.crm_sales drop column if exists creatives;
