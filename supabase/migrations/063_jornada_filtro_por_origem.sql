-- ============================================================
-- Jornada: filtro por origem
--
-- A aba já filtrava por canal. Origem faltava, e é o recorte que responde
-- "o lead de anúncio se comporta como o de indicação?" — que é outra
-- pergunta, não um detalhe do mesmo filtro.
--
-- POR QUE ISTO É UM DROP + CREATE, E NÃO UM REPLACE
--
-- create or replace não muda a lista de parâmetros: acrescentar p_origem
-- criaria uma SEGUNDA função com o mesmo nome, e as chamadas sem o
-- parâmetro ficariam ambíguas. Então cada função é derrubada e recriada.
--
-- O corpo de cada uma é o mesmo de 060/061/062, palavra por palavra, com
-- duas mudanças e nada mais:
--   1. p_origem text default null no fim da lista de parâmetros;
--   2. uma condição a mais na coorte, ao lado da de canal.
--
-- Parâmetro no FIM de propósito: o cliente chama por nome (p_from, p_to,
-- p_channel…), então a ordem não quebra ninguém, e quem esquecer de passar
-- p_origem continua recebendo o relatório inteiro.
--
-- COMO A ORIGEM É COMPARADA
--
-- lower(unaccent(...)) dos dois lados, a mesma chave que crm_origens() (038)
-- usa para montar a lista e que crm_report_by_origem (025/037) usa para
-- agrupar. Sem isso, "Anúncio" escolhido no filtro não acharia o lead
-- gravado como "anuncio" — e o relatório voltaria vazio com cara de bug.
--
-- Efeito colateral aceito: filtrar por uma origem deixa de fora o lead com
-- origem em branco. É o que a pergunta pede — quem quer todos não filtra.
-- ============================================================

do $$
begin
  if to_regprocedure('public.crm_report_journey_conversation(date, date, text, int)') is null then
    raise exception 'Aplique a migration 062 antes desta';
  end if;
end $$;

drop function if exists public.crm_report_journey_overview(date, date, text, int);

create or replace function public.crm_report_journey_overview(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  -- Quanto tempo parado já conta como abandono. 7 dias porque a automação
  -- da 050 move em 24h e o remarketing dura dias: abaixo disso o lead
  -- ainda está em atendimento, não largado.
  p_stale_days int default 7,
  -- Origem do lead, comparada sem caixa e sem acento como no resto
  -- do sistema (025/038): "Anúncio" e "anuncio" são a mesma coisa.
  p_origem text default null
)
returns table(
  total_leads                 bigint,
  human_leads                 bigint,
  transfer_rate               numeric,
  avg_hours_to_human          numeric,
  median_hours_to_human       numeric,
  converted                   bigint,
  ia_only_converted           bigint,
  human_converted             bigint,
  abandoned_leads             bigint,
  abandon_rate                numeric,
  advanced_after_human        bigint,
  advance_rate                numeric,
  budget_leads                bigint,
  budget_converted            bigint,
  budget_conversion_rate      numeric,
  avg_hours_budget_to_conv    numeric,
  median_hours_budget_to_conv numeric,
  has_triagem_stage           boolean,
  has_budget_stage            boolean,
  has_loss_stage              boolean,
  stale_days                  int
)
language sql stable security definer set search_path = public, extensions as $$
  with papeis as (
    select
      (select s.id from public.crm_stages s
        where s.organization_id = public.current_org_id()
          and s.journey_role = 'triagem' limit 1) as triagem_id,
      (select s.id from public.crm_stages s
        where s.organization_id = public.current_org_id()
          and s.journey_role = 'orcamento' limit 1) as orcamento_id,
      (select s.id from public.crm_stages s
        where s.organization_id = public.current_org_id()
          and s.journey_role = 'perdido' limit 1) as perdido_id
  ),
  coorte as (
    select c.id, c.created_at, c.stage_id, c.stage_changed_at
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and c.created_at >= public.crm_day_start(p_from)
      and c.created_at < public.crm_day_start(p_to + 1)
      and (p_channel is null or c.channel = p_channel)
      and (p_origem is null or lower(extensions.unaccent(c.origem)) = lower(extensions.unaccent(p_origem)))
  ),
  fatos as (
    select
      co.id,
      co.created_at,
      co.stage_changed_at,
      (co.stage_id is not null and co.stage_id = p.perdido_id) as perdido,
      public.crm_first_human_touch(co.id) as human_at,
      (
        select min(h.created_at)
        from public.crm_stage_history h
        join public.crm_stages s on s.id = h.to_stage_id
        where h.contact_id = co.id and s.is_conversion
      ) as conv_at,
      -- Orçamento pela etapa, quando o papel está configurado. Sem papel,
      -- a coluna fica nula e a tela mostra o aviso em vez de um zero que
      -- pareceria "ninguém pede orçamento".
      case when p.orcamento_id is null then null else (
        select min(h.created_at)
        from public.crm_stage_history h
        where h.contact_id = co.id and h.to_stage_id = p.orcamento_id
      ) end as orcamento_at,
      -- Data real do dinheiro: sold_at é editável, então é ela (não
      -- created_at da venda) que marca quando a conversão aconteceu.
      (select min(v.sold_at) from public.crm_sales v where v.contact_id = co.id) as venda_at
    from coorte co
    cross join papeis p
  ),
  -- Em que altura do funil o lead estava quando o time entrou. É a régua
  -- do "avançou depois do atendimento": sem ela, qualquer movimentação
  -- posterior contaria, inclusive voltar para trás.
  com_pos as (
    select
      f.*,
      (
        select s.position
        from public.crm_stage_history h
        join public.crm_stages s on s.id = h.to_stage_id
        where h.contact_id = f.id
          and f.human_at is not null
          and h.created_at <= f.human_at
        order by h.created_at desc
        limit 1
      ) as pos_no_humano
    from fatos f
  ),
  final as (
    select
      cp.*,
      (
        cp.human_at is not null
        and (
          exists (
            select 1
            from public.crm_stage_history h
            join public.crm_stages s on s.id = h.to_stage_id
            where h.contact_id = cp.id
              and h.created_at > cp.human_at
              and s.position > coalesce(cp.pos_no_humano, -1)
              -- Ir para Perdido tem posição maior que Ganho no funil
              -- semeado (013). Sem excluir os dois papéis de saída, dar o
              -- lead por perdido contaria como avanço.
              and coalesce(s.journey_role, '') not in ('perdido', 'remarketing')
          )
          or exists (
            select 1 from public.crm_sales v
            where v.contact_id = cp.id and v.sold_at > cp.human_at
          )
        )
      ) as avancou,
      -- Só conta o intervalo quando a venda vem DEPOIS do orçamento:
      -- venda lançada com data retroativa produziria horas negativas.
      case
        when cp.orcamento_at is not null
          and coalesce(cp.venda_at, cp.conv_at) > cp.orcamento_at
        then extract(epoch from (coalesce(cp.venda_at, cp.conv_at) - cp.orcamento_at)) / 3600.0
      end as horas_orc_conv
    from com_pos cp
  )
  select
    count(*)::bigint,
    count(human_at)::bigint,
    round(100.0 * count(human_at) / nullif(count(*), 0), 1),
    round(avg(extract(epoch from (human_at - created_at)) / 3600.0)::numeric, 1),
    round(
      (percentile_cont(0.5) within group (
        order by extract(epoch from (human_at - created_at)) / 3600.0
      ))::numeric, 1
    ),
    count(conv_at)::bigint,
    count(*) filter (where conv_at is not null and human_at is null)::bigint,
    count(*) filter (where conv_at is not null and human_at is not null)::bigint,
    -- Abandono: ninguém do time chegou, não converteu e o lead ou está na
    -- etapa de perda ou parou de se mover.
    count(*) filter (
      where human_at is null
        and conv_at is null
        and (perdido or stage_changed_at < now() - make_interval(days => greatest(p_stale_days, 0)))
    )::bigint,
    round(
      100.0 * count(*) filter (
        where human_at is null
          and conv_at is null
          and (perdido or stage_changed_at < now() - make_interval(days => greatest(p_stale_days, 0)))
      ) / nullif(count(*), 0), 1
    ),
    count(*) filter (where avancou)::bigint,
    round(100.0 * count(*) filter (where avancou) / nullif(count(human_at), 0), 1),
    count(orcamento_at)::bigint,
    count(*) filter (where orcamento_at is not null and conv_at is not null)::bigint,
    round(
      100.0 * count(*) filter (where orcamento_at is not null and conv_at is not null)
        / nullif(count(orcamento_at), 0), 1
    ),
    round(avg(horas_orc_conv)::numeric, 1),
    round((percentile_cont(0.5) within group (order by horas_orc_conv))::numeric, 1),
    (select triagem_id is not null from papeis),
    (select orcamento_id is not null from papeis),
    (select perdido_id is not null from papeis),
    greatest(p_stale_days, 0)
  from final;
$$;

comment on function public.crm_report_journey_overview(date, date, text, int, text) is
  'Jornada do lead na coorte da janela: transferência IA → atendente, '
  'abandono antes do primeiro humano, avanço depois dele e tempo entre '
  'orçamento e conversão. "Avançou" é o substituto de "respondeu": o banco '
  'não guarda mensagem, guarda movimentação.';


drop function if exists public.crm_report_journey_stage_flow(date, date, text);

create or replace function public.crm_report_journey_stage_flow(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  -- Origem do lead, comparada sem caixa e sem acento como no resto
  -- do sistema (025/038): "Anúncio" e "anuncio" são a mesma coisa.
  p_origem text default null
)
returns table(
  stage_id          uuid,
  stage_name        text,
  color             text,
  ord               int,
  is_conversion     boolean,
  reached           bigint,
  dropped           bigint,
  drop_rate         numeric,
  avg_hours_to_reach numeric
)
language sql stable security definer set search_path = public, extensions as $$
  with escada as (
    select
      s.id, s.name, s.color, s.is_conversion,
      row_number() over (order by s.is_conversion, s.position, s.created_at)::int as ord
    from public.crm_stages s
    where s.organization_id = public.current_org_id()
      and coalesce(s.journey_role, '') not in ('perdido', 'remarketing')
  ),
  coorte as (
    select c.id, c.created_at
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and c.created_at >= public.crm_day_start(p_from)
      and c.created_at < public.crm_day_start(p_to + 1)
      and (p_channel is null or c.channel = p_channel)
      and (p_origem is null or lower(extensions.unaccent(c.origem)) = lower(extensions.unaccent(p_origem)))
  ),
  pisadas as (
    select
      co.id,
      co.created_at,
      e.ord,
      min(h.created_at) as chegou_em
    from coorte co
    join public.crm_stage_history h on h.contact_id = co.id
    join escada e on e.id = h.to_stage_id
    group by co.id, co.created_at, e.ord
  ),
  alcance as (
    select id, max(ord) as max_ord from pisadas group by id
  ),
  medido as (
    select
      e.*,
      (select count(*) from alcance a where a.max_ord >= e.ord)::bigint as reached,
      (
        select round(avg(extract(epoch from (p.chegou_em - p.created_at)) / 3600.0)::numeric, 1)
        from pisadas p where p.ord = e.ord
      ) as horas
    from escada e
  )
  select
    m.id,
    m.name,
    m.color,
    m.ord,
    m.is_conversion,
    m.reached,
    -- No último degrau não há para onde vazar: quem chegou, chegou.
    (m.reached - coalesce(lead(m.reached) over (order by m.ord), m.reached))::bigint,
    round(
      100.0 * (m.reached - coalesce(lead(m.reached) over (order by m.ord), m.reached))
        / nullif(m.reached, 0), 1
    ),
    m.horas
  from medido m
  order by m.ord;
$$;

comment on function public.crm_report_journey_stage_flow(date, date, text, text) is
  'Degraus do funil na ordem, com quantos leads da coorte alcançaram cada '
  'um e quantos ficaram pelo caminho. Etapas de perda e de remarketing '
  'ficam fora da escada: são destinos laterais, não degraus.';


drop function if exists public.crm_report_journey_by_assignee(date, date, text);

create or replace function public.crm_report_journey_by_assignee(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  -- Origem do lead, comparada sem caixa e sem acento como no resto
  -- do sistema (025/038): "Anúncio" e "anuncio" são a mesma coisa.
  p_origem text default null
)
returns table(
  user_id              uuid,
  user_name            text,
  leads                bigint,
  inferred_leads       bigint,
  converted            bigint,
  conversion_rate      numeric,
  revenue_cents        bigint,
  avg_hours_to_convert numeric
)
language sql stable security definer set search_path = public, extensions as $$
  with coorte as (
    select c.id, c.created_at, c.assigned_to, c.value_cents
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and c.created_at >= public.crm_day_start(p_from)
      and c.created_at < public.crm_day_start(p_to + 1)
      and (p_channel is null or c.channel = p_channel)
      and (p_origem is null or lower(extensions.unaccent(c.origem)) = lower(extensions.unaccent(p_origem)))
  ),
  atribuido as (
    select
      co.id,
      co.created_at,
      co.value_cents,
      co.assigned_to is null as inferido,
      coalesce(
        co.assigned_to,
        (
          select h.changed_by
          from public.crm_stage_history h
          where h.contact_id = co.id and h.changed_by is not null
          order by h.created_at
          limit 1
        ),
        (
          select v.created_by
          from public.crm_sales v
          where v.contact_id = co.id and v.created_by is not null
          order by v.created_at
          limit 1
        )
      ) as atendente,
      (
        select min(h.created_at)
        from public.crm_stage_history h
        join public.crm_stages s on s.id = h.to_stage_id
        where h.contact_id = co.id and s.is_conversion
      ) as conv_at
    from coorte co
  )
  select
    a.atendente,
    coalesce(u.full_name, u.email),
    count(*)::bigint,
    count(*) filter (where a.inferido)::bigint,
    count(a.conv_at)::bigint,
    round(100.0 * count(a.conv_at) / nullif(count(*), 0), 1),
    coalesce(sum(a.value_cents) filter (where a.conv_at is not null), 0)::bigint,
    round(
      (avg(extract(epoch from (a.conv_at - a.created_at)) / 3600.0)
        filter (where a.conv_at is not null))::numeric, 1
    )
  from atribuido a
  left join public.users u on u.id = a.atendente
  group by a.atendente, coalesce(u.full_name, u.email)
  -- Sem atendente vai para o fim: é linha de diagnóstico, não de ranking.
  order by (a.atendente is null), count(a.conv_at) desc, count(*) desc;
$$;

comment on function public.crm_report_journey_by_assignee(date, date, text, text) is
  'Leads e conversões por atendente na coorte da janela. Atribui pelo '
  'responsável do contato e, na falta dele, por quem tocou o lead primeiro '
  '(inferred_leads conta esses).';


drop function if exists public.crm_report_journey_losses(date, date, text, int);

create or replace function public.crm_report_journey_losses(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  p_stale_days int default 7,
  -- Origem do lead, comparada sem caixa e sem acento como no resto
  -- do sistema (025/038): "Anúncio" e "anuncio" são a mesma coisa.
  p_origem text default null
)
returns table(
  motivo        text,
  ord           int,
  leads         bigint,
  share         numeric,
  via_automacao bigint,
  etapa         text,
  avg_days      numeric,
  total_perdas  bigint
)
language sql stable security definer set search_path = public, extensions as $$
  with papeis as (
    select
      (select s.id from public.crm_stages s
        where s.organization_id = public.current_org_id()
          and s.journey_role = 'orcamento' limit 1) as orcamento_id,
      (select s.id from public.crm_stages s
        where s.organization_id = public.current_org_id()
          and s.journey_role = 'remarketing' limit 1) as rmkt_id,
      (select s.id from public.crm_stages s
        where s.organization_id = public.current_org_id()
          and s.journey_role = 'perdido' limit 1) as perdido_id
  ),
  coorte as (
    select c.id, c.created_at, c.stage_id, c.stage_changed_at
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and c.created_at >= public.crm_day_start(p_from)
      and c.created_at < public.crm_day_start(p_to + 1)
      and (p_channel is null or c.channel = p_channel)
      and (p_origem is null or lower(extensions.unaccent(c.origem)) = lower(extensions.unaccent(p_origem)))
  ),
  fatos as (
    select
      co.id,
      co.created_at,
      co.stage_changed_at,
      coalesce(sa.name, 'Fora do funil') as etapa_atual,
      (co.stage_id is not null and co.stage_id = p.perdido_id) as perdido,
      public.crm_first_human_touch(co.id) as human_at,
      exists (
        select 1 from public.crm_stage_history h
        join public.crm_stages s on s.id = h.to_stage_id
        where h.contact_id = co.id and s.is_conversion
      ) as convertido,
      p.orcamento_id is not null and exists (
        select 1 from public.crm_stage_history h
        where h.contact_id = co.id and h.to_stage_id = p.orcamento_id
      ) as teve_orcamento,
      p.rmkt_id is not null and exists (
        select 1 from public.crm_stage_history h
        where h.contact_id = co.id and h.to_stage_id = p.rmkt_id
      ) as passou_rmkt,
      -- Como entrou na etapa de perda: 'system' é o cron da 050, 'ui' é
      -- decisão de alguém do time. A diferença é o motivo.
      (
        select h.source
        from public.crm_stage_history h
        where h.contact_id = co.id
          and p.perdido_id is not null
          and h.to_stage_id = p.perdido_id
        order by h.created_at desc
        limit 1
      ) as perda_source
    from coorte co
    cross join papeis p
    left join public.crm_stages sa on sa.id = co.stage_id
  ),
  perdas as (
    select
      f.*,
      case
        when f.perdido and f.perda_source = 'ui'     then 1
        when f.perdido                               then 2
        when f.passou_rmkt                           then 3
        when f.teve_orcamento                        then 4
        when f.human_at is null                      then 5
        else 6
      end as ord
    from fatos f
    where not f.convertido
      and (
        f.perdido
        or f.stage_changed_at < now() - make_interval(days => greatest(p_stale_days, 0))
      )
  )
  select
    case p.ord
      when 1 then 'Marcado como perdido pelo time'
      when 2 then 'Esfriou e caiu pela automação'
      when 3 then 'Não voltou depois do remarketing'
      when 4 then 'Recebeu orçamento e não respondeu'
      when 5 then 'Abandonou antes de falar com atendente'
      else        'Parado, sem etapa de saída'
    end,
    p.ord,
    count(*)::bigint,
    round(100.0 * count(*) / nullif(sum(count(*)) over (), 0), 1),
    count(*) filter (where p.perda_source = 'system')::bigint,
    -- A etapa mais comum do balde: diz ONDE a perda acontece, sem
    -- multiplicar as linhas por etapa.
    mode() within group (order by p.etapa_atual),
    round(avg(extract(epoch from (now() - p.created_at)) / 86400.0)::numeric, 1),
    sum(count(*)) over ()::bigint
  from perdas p
  group by p.ord
  order by count(*) desc;
$$;

comment on function public.crm_report_journey_losses(date, date, text, int, text) is
  'Motivos de perda deduzidos do rastro do lead (onde parou, se passou por '
  'remarketing, se um humano chegou, e se foi o time ou a automação que o '
  'deu por perdido). Não há campo de motivo no banco — este é o motivo '
  'inferido, e vale para todo o histórico sem ninguém preencher nada.';


drop function if exists public.crm_report_journey_tag_contacts(jsonb, text, text, int);

create or replace function public.crm_report_journey_tag_contacts(
  p_rows jsonb default '[]'::jsonb,
  p_stage text default null,
  p_channel text default null,
  p_limit int default 15,
  -- Origem do lead, comparada sem caixa e sem acento como no resto
  -- do sistema (025/038): "Anúncio" e "anuncio" são a mesma coisa.
  p_origem text default null
)
returns table(
  numero      text,
  contact_id  uuid,
  name        text,
  phone       text,
  channel     text,
  origem      text,
  stage_name  text,
  assignee    text,
  days_idle   numeric,
  converted   boolean,
  total       bigint
)
language sql stable security definer set search_path = public, extensions as $$
  with entrada as (
    select r.n as numero, r.s as stage, r.u as visto_em
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(n text, s text, u text)
    where r.n is not null
      and (p_stage is null or r.s = p_stage)
  ),
  casado as (
    select
      e.numero,
      e.visto_em,
      c.id as contact_id, c.name, c.phone, c.channel, c.origem, c.stage_id, c.assigned_to,
      exists (
        select 1 from public.crm_stage_history h
        join public.crm_stages s on s.id = h.to_stage_id
        where h.contact_id = c.id and s.is_conversion
      ) as convertido
    from entrada e
    left join lateral public.crm_contact_by_phone(public.current_org_id(), e.numero) c on true
  ),
  filtrado as (
    select * from casado
    where (p_channel is null or channel = p_channel)
      and (p_origem is null or
           lower(extensions.unaccent(origem)) = lower(extensions.unaccent(p_origem)))
  )
  select
    f.numero,
    f.contact_id,
    f.name,
    f.phone,
    f.channel,
    f.origem,
    s.name,
    coalesce(u.full_name, u.email),
    round((extract(epoch from (now() - f.visto_em::timestamptz)) / 86400.0)::numeric, 1),
    f.convertido,
    count(*) over ()::bigint
  from filtrado f
  left join public.crm_stages s on s.id = f.stage_id
  left join public.users u on u.id = f.assigned_to
  -- Parado há mais tempo primeiro: é a ponta da fila que esfria.
  order by f.visto_em nulls last
  limit greatest(p_limit, 1);
$$;

comment on function public.crm_report_journey_tag_contacts(jsonb, text, text, int, text) is
  'Leads de uma etapa da jornada, do mais parado para o mais recente. '
  'contact_id nulo = a conversa existe no bot e o contato não existe no '
  'CRM.';


drop function if exists public.crm_report_journey_messages(date, date, text);

create or replace function public.crm_report_journey_messages(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  -- Origem do lead, comparada sem caixa e sem acento como no resto
  -- do sistema (025/038): "Anúncio" e "anuncio" são a mesma coisa.
  p_origem text default null
)
returns table(
  cohort_leads                      bigint,
  -- Leads da coorte com conversa casada por telefone.
  with_messages                     bigint,
  leads_sem_telefone                bigint,
  client_replied                    bigint,
  never_replied                     bigint,
  human_leads                       bigint,
  replied_after_human               bigint,
  reply_after_human_rate            numeric,
  avg_hours_reply_after_human       numeric,
  median_hours_reply_after_human    numeric,
  rmkt_leads                        bigint,
  rmkt_replied                      bigint,
  rmkt_reply_rate                   numeric,
  rmkt_converted                    bigint,
  converted_with_messages           bigint,
  avg_msgs_to_convert               numeric,
  median_msgs_to_convert            numeric,
  avg_client_msgs_to_convert        numeric,
  avg_agent_msgs_to_convert         numeric,
  avg_msgs_per_lead                 numeric,
  median_hours_first_reply          numeric,
  has_rmkt_stage                    boolean,
  total_messages                    bigint
)
language sql stable security definer set search_path = public, extensions as $$
  with papeis as (
    select (
      select s.id from public.crm_stages s
      where s.organization_id = public.current_org_id()
        and s.journey_role = 'remarketing'
      limit 1
    ) as rmkt_id
  ),
  coorte as (
    select c.id, c.created_at, c.phone_key
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and c.created_at >= public.crm_day_start(p_from)
      and c.created_at < public.crm_day_start(p_to + 1)
      and (p_channel is null or c.channel = p_channel)
      and (p_origem is null or lower(extensions.unaccent(c.origem)) = lower(extensions.unaccent(p_origem)))
  ),
  -- Os instantes de corte vêm todos do CRM: é ele que sabe quando o time
  -- entrou, quando o lead caiu no remarketing e quando a venda aconteceu.
  ancoras as (
    select
      co.id,
      co.phone_key,
      co.created_at,
      public.crm_first_human_touch(co.id) as human_at,
      (
        select min(h.created_at)
        from public.crm_stage_history h
        join public.crm_stages s on s.id = h.to_stage_id
        where h.contact_id = co.id and s.is_conversion
      ) as conv_at,
      case when p.rmkt_id is null then null else (
        select min(h.created_at)
        from public.crm_stage_history h
        where h.contact_id = co.id and h.to_stage_id = p.rmkt_id
      ) end as rmkt_at
    from coorte co
    cross join papeis p
  ),
  conversa as (
    select
      a.id,
      a.phone_key,
      count(*) as msgs,
      count(*) filter (where m.sender_type = 'client') as do_cliente,
      min(m.sent_at) filter (where m.sender_type = 'client') as primeira_do_cliente,
      -- Primeira fala do cliente DEPOIS de o time assumir. É a resposta que
      -- a pergunta original pedia, agora com dado em vez de substituto.
      min(m.sent_at) filter (
        where m.sender_type = 'client' and a.human_at is not null and m.sent_at > a.human_at
      ) as resposta_pos_humano,
      min(m.sent_at) filter (
        where m.sender_type = 'client' and a.rmkt_at is not null and m.sent_at > a.rmkt_at
      ) as resposta_pos_rmkt,
      -- Mensagens até a venda: a conversa inteira até a 1ª conversão, das
      -- duas pontas. Sem recorte por created_at do contato de propósito — o
      -- bot grava a conversa antes de o contato existir, e cortar ali
      -- jogaria fora justamente as primeiras mensagens.
      count(*) filter (where a.conv_at is not null and m.sent_at <= a.conv_at) as ate_conversao,
      count(*) filter (
        where a.conv_at is not null and m.sent_at <= a.conv_at and m.sender_type = 'client'
      ) as cliente_ate_conversao,
      count(*) filter (
        where a.conv_at is not null and m.sent_at <= a.conv_at and m.sender_type = 'agent'
      ) as agente_ate_conversao
    from ancoras a
    join public.conversation_messages m
      on public.crm_phone_key(m.number) = a.phone_key
    group by a.id, a.phone_key
  ),
  -- Tempo até a primeira resposta da casa. 'agent' é IA ou time: este
  -- número mede se ALGUÉM respondeu, não quem.
  primeira_resposta as (
    select
      c.id,
      (
        select min(m2.sent_at)
        from public.conversation_messages m2
        where public.crm_phone_key(m2.number) = c.phone_key
          and m2.sender_type = 'agent'
          and m2.sent_at > c.primeira_do_cliente
      ) as respondida_em,
      c.primeira_do_cliente
    from conversa c
    where c.primeira_do_cliente is not null
  ),
  final as (
    select
      a.*,
      c.msgs,
      c.do_cliente,
      c.resposta_pos_humano,
      c.resposta_pos_rmkt,
      c.ate_conversao,
      c.cliente_ate_conversao,
      c.agente_ate_conversao,
      case
        when pr.respondida_em is not null
        then extract(epoch from (pr.respondida_em - pr.primeira_do_cliente)) / 3600.0
      end as horas_primeira_resposta
    from ancoras a
    left join conversa c on c.id = a.id
    left join primeira_resposta pr on pr.id = a.id
  )
  select
    count(*)::bigint,
    count(msgs)::bigint,
    count(*) filter (where phone_key is null)::bigint,
    count(*) filter (where coalesce(do_cliente, 0) > 0)::bigint,
    -- Conversa que existe e em que o cliente nunca falou: a automação
    -- mandou, ninguém respondeu.
    count(*) filter (where msgs is not null and coalesce(do_cliente, 0) = 0)::bigint,
    count(human_at)::bigint,
    count(resposta_pos_humano)::bigint,
    round(100.0 * count(resposta_pos_humano) / nullif(count(human_at), 0), 1),
    round(
      avg(extract(epoch from (resposta_pos_humano - human_at)) / 3600.0)::numeric, 1
    ),
    round(
      (percentile_cont(0.5) within group (
        order by extract(epoch from (resposta_pos_humano - human_at)) / 3600.0
      ))::numeric, 1
    ),
    count(rmkt_at)::bigint,
    count(resposta_pos_rmkt)::bigint,
    round(100.0 * count(resposta_pos_rmkt) / nullif(count(rmkt_at), 0), 1),
    -- Voltou e fechou: a conversão veio DEPOIS de cair no remarketing.
    count(*) filter (where rmkt_at is not null and conv_at > rmkt_at)::bigint,
    count(*) filter (where conv_at is not null and msgs is not null)::bigint,
    round(avg(ate_conversao) filter (where conv_at is not null and msgs is not null), 1),
    round(
      (percentile_cont(0.5) within group (
        order by (case when conv_at is not null and msgs is not null then ate_conversao end)
      ))::numeric, 1
    ),
    round(avg(cliente_ate_conversao) filter (where conv_at is not null and msgs is not null), 1),
    round(avg(agente_ate_conversao) filter (where conv_at is not null and msgs is not null), 1),
    round(avg(msgs) filter (where msgs is not null), 1),
    round((percentile_cont(0.5) within group (order by horas_primeira_resposta))::numeric, 2),
    (select rmkt_id is not null from papeis),
    coalesce(sum(msgs), 0)::bigint
  from final;
$$;

comment on function public.crm_report_journey_messages(date, date, text, text) is
  'Métricas de conversa da coorte: taxa de resposta do lead depois de o time '
  'assumir, mensagens até a venda e retorno depois do remarketing. Casa '
  'conversation_messages com crm_contacts por telefone canônico (044). '
  'sender_type ''agent'' é qualquer saída — IA ou gente; quem marca a hora do '
  'humano é o CRM.';


drop function if exists public.crm_report_journey_conversation(date, date, text, int);

create or replace function public.crm_report_journey_conversation(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  -- Silêncio a partir do qual "ainda não respondemos" vira "não respondemos".
  -- Lead que falou hoje de madrugada não é abandono às 9h.
  p_stale_days int default 7,
  -- Origem do lead, comparada sem caixa e sem acento como no resto
  -- do sistema (025/038): "Anúncio" e "anuncio" são a mesma coisa.
  p_origem text default null
)
returns table(
  cohort_leads             bigint,
  leads_sem_telefone       bigint,
  leads_sem_conversa       bigint,
  -- Denominador honesto de tudo que fala em resposta: só entra quem falou.
  leads_com_fala           bigint,
  answered_leads           bigint,
  answer_rate              numeric,
  unanswered_leads         bigint,
  unanswered_stale         bigint,
  unanswered_rate          numeric,
  avg_hours_first_reply    numeric,
  median_hours_first_reply numeric,
  re_replied_leads         bigint,
  re_reply_rate            numeric,
  advanced_after_reply     bigint,
  advance_after_reply_rate numeric,
  stale_days               int
)
language sql stable security definer set search_path = public, extensions as $$
  with coorte as (
    select c.id, c.created_at, c.phone_key
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and c.created_at >= public.crm_day_start(p_from)
      and c.created_at < public.crm_day_start(p_to + 1)
      and (p_channel is null or c.channel = p_channel)
      and (p_origem is null or lower(extensions.unaccent(c.origem)) = lower(extensions.unaccent(p_origem)))
  ),
  -- A conversa do lead, casada por telefone canônico (044): o 9 extra do
  -- celular não pode separar o cliente da própria conversa.
  conv as (
    select
      co.id,
      count(*) as msgs,
      min(m.sent_at) filter (where m.sender_type = 'client') as primeira_do_cliente,
      max(m.sent_at) filter (where m.sender_type = 'client') as ultima_do_cliente
    from coorte co
    join public.conversation_messages m
      on public.crm_phone_key(m.number) = co.phone_key
    group by co.id
  ),
  base as (
    select
      co.id,
      co.phone_key,
      c.msgs,
      c.primeira_do_cliente,
      c.ultima_do_cliente,
      case when c.primeira_do_cliente is null then null else (
        select min(m2.sent_at)
        from public.conversation_messages m2
        where public.crm_phone_key(m2.number) = co.phone_key
          and m2.sender_type = 'agent'
          and m2.sent_at > c.primeira_do_cliente
      ) end as respondida_em
    from coorte co
    left join conv c on c.id = co.id
  ),
  -- Onde o lead estava no funil quando a resposta saiu. É a régua do
  -- "avançou": sem ela, qualquer movimentação posterior contaria, inclusive
  -- voltar para trás.
  com_pos as (
    select
      b.*,
      (
        select s.position
        from public.crm_stage_history h
        join public.crm_stages s on s.id = h.to_stage_id
        where h.contact_id = b.id
          and b.respondida_em is not null
          and h.created_at <= b.respondida_em
        order by h.created_at desc
        limit 1
      ) as pos_na_resposta
    from base b
  ),
  final as (
    select
      cp.*,
      -- O lead voltou a falar depois de a resposta sair. Como
      -- ultima_do_cliente é o máximo, a comparação já responde sozinha.
      (cp.respondida_em is not null and cp.ultima_do_cliente > cp.respondida_em) as voltou_a_falar,
      (
        cp.respondida_em is not null
        and (
          exists (
            select 1
            from public.crm_stage_history h
            join public.crm_stages s on s.id = h.to_stage_id
            where h.contact_id = cp.id
              and h.created_at > cp.respondida_em
              and s.position > coalesce(cp.pos_na_resposta, -1)
              -- Perdido tem posição maior que Ganho no funil semeado (013):
              -- sem excluir os destinos laterais, dar o lead por perdido
              -- contaria como avanço.
              and coalesce(s.journey_role, '') not in ('perdido', 'remarketing')
          )
          or exists (
            select 1 from public.crm_sales v
            where v.contact_id = cp.id and v.sold_at > cp.respondida_em
          )
        )
      ) as avancou
    from com_pos cp
  )
  select
    count(*)::bigint,
    count(*) filter (where phone_key is null)::bigint,
    count(*) filter (where msgs is null)::bigint,
    count(primeira_do_cliente)::bigint,
    count(respondida_em)::bigint,
    round(100.0 * count(respondida_em) / nullif(count(primeira_do_cliente), 0), 1),
    count(*) filter (where primeira_do_cliente is not null and respondida_em is null)::bigint,
    -- O que conta como "ficou sem resposta": ninguém respondeu E a última
    -- fala dele já esfriou. Conversa de ontem ainda é fila, não perda.
    count(*) filter (
      where primeira_do_cliente is not null
        and respondida_em is null
        and ultima_do_cliente < now() - make_interval(days => greatest(p_stale_days, 0))
    )::bigint,
    round(
      100.0 * count(*) filter (
        where primeira_do_cliente is not null
          and respondida_em is null
          and ultima_do_cliente < now() - make_interval(days => greatest(p_stale_days, 0))
      ) / nullif(count(primeira_do_cliente), 0), 1
    ),
    round(
      avg(extract(epoch from (respondida_em - primeira_do_cliente)) / 3600.0)::numeric, 2
    ),
    round(
      (percentile_cont(0.5) within group (
        order by extract(epoch from (respondida_em - primeira_do_cliente)) / 3600.0
      ))::numeric, 2
    ),
    count(*) filter (where voltou_a_falar)::bigint,
    round(100.0 * count(*) filter (where voltou_a_falar) / nullif(count(respondida_em), 0), 1),
    count(*) filter (where avancou)::bigint,
    round(100.0 * count(*) filter (where avancou) / nullif(count(respondida_em), 0), 1),
    greatest(p_stale_days, 0)
  from final;
$$;

comment on function public.crm_report_journey_conversation(date, date, text, int, text) is
  'Jornada medida pelo relógio da conversa, não por quem escreveu a linha no '
  'CRM: quantos leads receberam resposta, em quanto tempo, quantos voltaram a '
  'falar e quantos andaram no funil depois disso. Substitui as métricas de '
  '"toque humano" da 060, que aqui mediam apenas quem abriu a tela — o '
  'vendedor trabalha no WhatsApp e o n8n escreve por ele. NÃO distingue IA de '
  'vendedor: sender_type ''agent'' é qualquer saída.';


drop function if exists public.crm_report_journey_silent(date, date, text, int);

create or replace function public.crm_report_journey_silent(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  p_limit int default 15,
  -- Origem do lead, comparada sem caixa e sem acento como no resto
  -- do sistema (025/038): "Anúncio" e "anuncio" são a mesma coisa.
  p_origem text default null
)
returns table(
  contact_id     uuid,
  name           text,
  phone          text,
  channel        text,
  origem         text,
  stage_name     text,
  assignee       text,
  last_agent_at  timestamptz,
  last_client_at timestamptz,
  days_silent    numeric,
  msgs           bigint,
  total          bigint
)
language sql stable security definer set search_path = public, extensions as $$
  with coorte as (
    select c.id, c.name, c.phone, c.phone_key, c.channel, c.origem, c.stage_id, c.assigned_to
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and c.created_at >= public.crm_day_start(p_from)
      and c.created_at < public.crm_day_start(p_to + 1)
      and (p_channel is null or c.channel = p_channel)
      and (p_origem is null or lower(extensions.unaccent(c.origem)) = lower(extensions.unaccent(p_origem)))
      and c.phone_key is not null
      -- Já comprou não é silêncio: é cliente. As três portas.
      and not exists (
        select 1
        from public.crm_stage_history h
        join public.crm_stages s on s.id = h.to_stage_id
        where h.contact_id = c.id and s.is_conversion
      )
      and not exists (
        select 1 from public.crm_sales v where v.contact_id = c.id
      )
      and not exists (
        select 1
        from unnest(c.tags) as t
        where regexp_replace(lower(t), '[[:space:]_-]+', '', 'g') like 'comprou%'
      )
  ),
  conversa as (
    select
      co.*,
      count(*) as msgs,
      max(m.sent_at) filter (where m.sender_type = 'client') as last_client_at,
      max(m.sent_at) filter (where m.sender_type = 'agent') as last_agent_at
    from coorte co
    join public.conversation_messages m
      on public.crm_phone_key(m.number) = co.phone_key
    group by co.id, co.name, co.phone, co.phone_key, co.channel, co.origem,
             co.stage_id, co.assigned_to
  )
  select
    c.id,
    c.name,
    c.phone,
    c.channel,
    c.origem,
    s.name,
    coalesce(u.full_name, u.email),
    c.last_agent_at,
    c.last_client_at,
    round((extract(epoch from (now() - coalesce(c.last_client_at, c.last_agent_at))) / 86400.0)::numeric, 1),
    c.msgs::bigint,
    count(*) over ()::bigint
  from conversa c
  left join public.crm_stages s on s.id = c.stage_id
  left join public.users u on u.id = c.assigned_to
  -- A bola está com o lead: falamos e ele não voltou.
  where c.last_agent_at is not null
    and (c.last_client_at is null or c.last_client_at < c.last_agent_at)
  order by coalesce(c.last_client_at, c.last_agent_at)
  limit greatest(p_limit, 1);
$$;

comment on function public.crm_report_journey_silent(date, date, text, int, text) is
  'Leads que NÃO compraram (sem etapa de conversão, sem venda lançada e sem '
  'etiqueta comprou* em crm_contacts.tags) e em que a ÚLTIMA mensagem foi '
  'nossa — do silêncio mais antigo para o mais recente. last_client_at nulo '
  '= nunca falou nada, só '
  'recebeu. Não afirma quem respondeu: a tabela de mensagens não separa IA '
  'de vendedor.';

