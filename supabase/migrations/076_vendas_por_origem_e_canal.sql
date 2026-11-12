-- ============================================================
-- Vendas por origem e por canal
--
-- A aba Funil já quebra por origem e por canal, mas do jeito dela: coorte
-- de LEADS criados na janela, com a receita da 1ª venda de quem converteu.
-- A pergunta da aba Vendas é outra e nunca teve resposta na tela:
--
--   "do que foi FATURADO neste período, quanto veio de cada origem?"
--
-- As duas não batem e não devem bater. Um exemplo que vai acontecer: lead
-- de janeiro que recomprou em agosto entra inteiro aqui (a venda é de
-- agosto) e não aparece na quebra do Funil de agosto (o lead é de janeiro).
-- Recompra idem: aqui toda venda conta, lá só a primeira.
--
-- UMA FUNÇÃO, DUAS DIMENSÕES
--
-- Origem e canal são a mesma consulta com outro group by, e duplicá-la
-- levaria a duas definições de "receita por dimensão" que divergiriam na
-- primeira mudança. p_dim escolhe qual, e um valor desconhecido devolve
-- vazio em vez de somar tudo num balde só.
--
-- AGRUPAMENTO DA ORIGEM: sem caixa e sem acento, com a grafia mais frequente
-- como rótulo — a mesma regra da 038, para "Anúncio" e "anuncio" não virarem
-- duas linhas. Canal é agrupado como está: é nome de número de WhatsApp, não
-- texto digitado à mão.
--
-- SEM ORIGEM É UMA LINHA, NÃO UM SUMIÇO. A quebra do Funil descarta contato
-- sem origem; aqui isso esconderia faturamento, que é o pior tipo de linha
-- para esconder. Ele aparece com rótulo nulo e a tela mostra "Sem origem".
-- ============================================================

create or replace function public.crm_report_sales_breakdown(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  -- 'origem' ou 'canal'.
  p_dim text default 'origem'
)
returns table(
  label            text,
  sales            bigint,
  first_sales      bigint,
  repeat_sales     bigint,
  clients          bigint,
  revenue_cents    bigint,
  avg_ticket_cents bigint,
  share            numeric
)
language sql stable security definer set search_path = public, extensions as $$
  with vendas as (
    select
      v.contact_id,
      v.value_cents,
      -- Ordem da venda na VIDA do cliente (031/046): é assim que "1ª venda"
      -- continua significando aquisição quando a janela começa no meio da
      -- história dele.
      row_number() over (
        partition by v.contact_id order by v.sold_at, v.created_at, v.id
      ) as seq,
      v.sold_at,
      nullif(btrim(coalesce(c.origem, '')), '') as origem,
      nullif(btrim(coalesce(c.channel, '')), '') as channel
    from public.crm_sales v
    join public.crm_contacts c on c.id = v.contact_id
    where v.organization_id = public.current_org_id()
      and (p_channel is null or c.channel = p_channel)
  ),
  periodo as (
    select w.* from vendas w
    where w.sold_at >= public.crm_day_start(p_from)
      and w.sold_at <  public.crm_day_start(p_to + 1)
  ),
  -- O total da janela, para a fatia de cada linha. Calculado uma vez: com
  -- uma subconsulta por linha, o percentual custaria uma varredura extra
  -- para cada origem.
  total as (
    select coalesce(sum(p.value_cents), 0)::numeric as cents from periodo p
  ),
  agrupado as (
    select
      case p_dim
        -- A grafia mais frequente vira o rótulo do grupo, como na 038.
        when 'origem' then mode() within group (order by p.origem)
        else mode() within group (order by p.channel)
      end as label,
      count(*)::bigint as sales,
      count(*) filter (where p.seq = 1)::bigint as first_sales,
      count(*) filter (where p.seq > 1)::bigint as repeat_sales,
      count(distinct p.contact_id)::bigint as clients,
      coalesce(sum(p.value_cents), 0)::bigint as revenue_cents
    from periodo p
    where p_dim in ('origem', 'canal')
    group by
      case p_dim
        when 'origem' then lower(extensions.unaccent(p.origem))
        else lower(p.channel)
      end
  )
  select
    a.label,
    a.sales,
    a.first_sales,
    a.repeat_sales,
    a.clients,
    a.revenue_cents,
    (a.revenue_cents / nullif(a.sales, 0))::bigint,
    round(100.0 * a.revenue_cents / nullif((select t.cents from total t), 0), 1)
  from agrupado a
  -- Por dinheiro, não por número de vendas: a pergunta da aba é faturamento.
  order by a.revenue_cents desc, a.sales desc, a.label nulls last;
$$;

comment on function public.crm_report_sales_breakdown(date, date, text, text) is
  'Faturamento da janela quebrado por origem ou por canal do contato '
  '(p_dim = origem | canal), pela data da VENDA e contando recompra. Não '
  'bate com crm_report_by_origem/by_channel de propósito: aquelas são coorte '
  'de leads criados na janela. Rótulo nulo = contato sem o campo preenchido.';

grant execute on function public.crm_report_sales_breakdown(date, date, text, text)
  to authenticated;
