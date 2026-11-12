-- ============================================================
-- Quem são os convertidos do card "Conversões"
--
-- A aba Funil dizia quantos leads da janela converteram e parava aí. A
-- pergunta seguinte é sempre a mesma — "quem?" — e até aqui só dava para
-- responder abrindo o funil e procurando na mão.
--
-- A POPULAÇÃO É EXATAMENTE A DO CARD, e isso é o ponto da migration.
--
-- crm_report_overview (037) conta como convertido o lead CRIADO na janela
-- que em algum momento passou por etapa de conversão — inclusive se fechou
-- depois do fim da janela. Esta função repete a mesma condição, linha por
-- linha, para a lista e o card nunca discordarem. Se um dia o overview
-- mudar de critério, as duas mudam juntas ou a tela volta a mentir.
--
-- Não confundir com crm_report_conversions_in_period (048/051), que recorta
-- pela data da VENDA e é outra pergunta: "o que fechou dentro da janela,
-- venha o lead de quando vier". Aquela alimenta a aba Vendas.
--
-- convertido_em: a data da 1ª venda (sold_at), com a entrada na etapa como
-- reserva de quem não tem venda registrada. Mesma regra da 051 — dois
-- relógios diferentes para a mesma conversão fariam a lista ordenar de um
-- jeito e a aba Vendas de outro.
--
-- p_limit com teto: a lista é para ler na tela, não para exportar. Sem teto,
-- um All-Time devolveria dezenas de milhares de linhas para um <table>.
-- ============================================================

create or replace function public.crm_report_converted_contacts(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  p_limit int default 100
)
returns table(
  contact_id    uuid,
  name          text,
  phone         text,
  channel       text,
  origem        text,
  created_at    timestamptz,
  converted_at  timestamptz,
  hours_to_conv numeric,
  value_cents   bigint,
  sales_count   int,
  total         bigint
)
language sql stable security definer set search_path = public as $$
  with coorte as (
    select
      c.id, c.name, c.phone, c.channel, c.origem, c.created_at,
      c.value_cents, c.sales_count,
      -- A entrada na etapa é o que DEFINE quem converteu (mesma subconsulta
      -- do overview); o sold_at abaixo só escolhe a data que se mostra.
      (
        select min(h.created_at)
        from public.crm_stage_history h
        join public.crm_stages s on s.id = h.to_stage_id
        where h.contact_id = c.id and s.is_conversion
      ) as registrado_em
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and c.created_at >= public.crm_day_start(p_from)
      and c.created_at < public.crm_day_start(p_to + 1)
      and (p_channel is null or c.channel = p_channel)
  ),
  convertidos as (
    select
      k.*,
      coalesce(
        (select min(v.sold_at) from public.crm_sales v where v.contact_id = k.id),
        k.registrado_em
      ) as convertido_em
    from coorte k
    where k.registrado_em is not null
  )
  select
    n.id,
    n.name,
    n.phone,
    n.channel,
    n.origem,
    n.created_at,
    n.convertido_em,
    -- Negativo quando a venda foi lançada com data anterior à entrada do
    -- lead (acontece em venda manual do histórico): a tela mostra "—" em vez
    -- de "fechou em -3 dias".
    round((extract(epoch from (n.convertido_em - n.created_at)) / 3600.0)::numeric, 1),
    coalesce(n.value_cents, 0)::bigint,
    coalesce(n.sales_count, 0),
    count(*) over ()::bigint
  from convertidos n
  -- Mais recente primeiro: quem fechou ontem é quem se quer conferir hoje.
  order by n.convertido_em desc nulls last
  limit least(greatest(p_limit, 1), 500);
$$;

comment on function public.crm_report_converted_contacts(date, date, text, int) is
  'Leads CRIADOS na janela que converteram — a mesma população que o '
  'converted de crm_report_overview conta. Data mostrada é a da 1ª venda, '
  'com a entrada na etapa de conversão como reserva. total = quantos são no '
  'total, antes do limite.';

grant execute on function public.crm_report_converted_contacts(date, date, text, int)
  to authenticated;
