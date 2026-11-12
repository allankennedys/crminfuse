-- ============================================================
-- 100: "com clique rastreado" passa a contar também a landing
-- ============================================================
-- O card "Leads de anúncio" dizia "N com clique rastreado" contando só
-- ctwa_clid. O lead que clicou no anúncio e caiu na landing tem o clique
-- rastreado do mesmo jeito: fbc + id de campanha, a mesma dupla que a
-- crm_is_ad_contact (071) exige para o caminho do site. Ficava de fora e
-- o número subestimava o que dá para creditar a um anúncio.
--
-- Agora leads_ctwa = ctwa_clid OU (fbc E campanha). A coluna mantém o nome
-- para não mudar a assinatura nem o front. Só esse relatório muda: a regra
-- de envio para a Meta e os outros relatórios ficam como estão.
--
-- Redefinida a partir da 071, a última versão. Nada além do CTE ads e da
-- contagem de leads_ctwa mudou.
-- ============================================================
create or replace function public.crm_report_ads_overview(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to   date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null
)
returns table(
  -- Coorte: entrada na janela
  leads                  bigint,
  leads_ctwa             bigint,
  leads_all              bigint,
  -- Fluxo: o que aconteceu na janela
  conversions            bigint,
  new_clients            bigint,
  clients                bigint,
  sales                  bigint,
  first_sales            bigint,
  repeat_sales           bigint,
  creatives              bigint,
  revenue_cents          bigint,
  avg_ticket_cents       bigint,
  ltv_period_cents       bigint,
  -- Histórico completo dos clientes de anúncio (ignora a janela)
  total_clients          bigint,
  total_sales            bigint,
  total_revenue_cents    bigint,
  total_avg_ticket_cents bigint,
  total_ltv_cents        bigint
)
language sql stable security definer set search_path = public as $$
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
      v.contact_id, v.sold_at, v.creatives, v.value_cents,
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
    (select coalesce(sum(p.creatives), 0) from periodo p)::bigint,
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
$$;
