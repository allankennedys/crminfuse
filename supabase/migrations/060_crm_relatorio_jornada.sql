-- ============================================================
-- Relatório de Jornada do Cliente
--
-- As abas que já existem respondem "quanto entrou" (Vendas), "quantos
-- fecharam" (Funil), "o cliente volta" (Recompra) e "o anúncio pagou"
-- (Meta ADS). Nenhuma responde a pergunta do meio: ONDE o lead trava
-- entre a primeira mensagem e o dinheiro.
--
-- É isso aqui. Cinco funções, todas coorte por data de ENTRADA do lead —
-- o mesmo recorte da aba Funil, para os números conversarem.
--
-- O QUE O BANCO SABE SOBRE ATENDIMENTO HUMANO
--
-- Não existe tabela de mensagens neste projeto: a conversa acontece no
-- WhatsApp e no bot, fora daqui. O que existe é rastro de AÇÃO de gente:
--
--   crm_stage_history.changed_by  -- um usuário logado moveu o lead
--   crm_sales.created_by          -- um usuário lançou a venda
--
-- Movimento por automação (050) e por API (n8n/IA) não têm changed_by: o
-- trigger só grava usuário quando há sessão. Então "primeiro atendimento
-- humano" = primeiro instante em que alguém do time tocou o lead, e é um
-- dado que o banco tem de verdade — não uma estimativa.
--
-- O QUE O BANCO **NÃO** SABE, E POR ISSO NÃO ESTÁ AQUI
--
--   • Se o lead RESPONDEU (não há evento de mensagem recebida). O que
--     medimos é o substituto honesto: o lead AVANÇOU no funil depois do
--     atendimento humano. Quem quiser a taxa de resposta de verdade
--     precisa gravar as mensagens — hoje elas não existem em lugar nenhum
--     do banco.
--   • Quantas mensagens até converter. Mesmo motivo.
--   • Motivo de perda escrito pelo time: não há campo. O que esta
--     migration devolve é o motivo DEDUZIDO de onde e como o lead parou,
--     que tem a vantagem de valer para o histórico inteiro sem ninguém
--     preencher nada.
--
-- ETAPA COM PAPEL, EM VEZ DE NOME NO SQL
--
-- Mesmo princípio da 050: as etapas são criadas por organização com nome
-- livre, então SQL comparando 'Orçamento Enviado' quebraria calado no dia
-- em que alguém tirasse o acento. journey_role guarda o PAPEL da etapa na
-- jornada; renomear a coluna no kanban não afeta relatório nenhum.
--
-- O backfill no fim do arquivo chuta os papéis pelos nomes atuais UMA vez.
-- Depois disso, quem manda é o seletor no diálogo de etapa.
-- ============================================================

-- A 050 é pré-requisito de fato: o relatório de perdas separa quem caiu
-- pela automação de quem o time marcou como perdido, e sem a 050 a coluna
-- source nunca recebe 'system' nesse caminho.
do $$
begin
  if to_regclass('public.crm_stage_automations') is null then
    raise exception 'Aplique a migration 050 antes desta: crm_stage_automations não existe';
  end if;
end $$;

-- ------------------------------------------------------------
-- PAPEL DA ETAPA NA JORNADA
-- ------------------------------------------------------------
alter table public.crm_stages
  add column if not exists journey_role text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'crm_stages_journey_role_check'
  ) then
    alter table public.crm_stages
      add constraint crm_stages_journey_role_check
      check (journey_role is null or journey_role in ('triagem', 'orcamento', 'remarketing', 'perdido'));
  end if;
end $$;

comment on column public.crm_stages.journey_role is
  'Papel da etapa no relatório de Jornada: triagem (qualificação pela IA), '
  'orcamento, remarketing (trilha de recuperação) ou perdido. NULL = etapa '
  'comum do meio do funil. A etapa de conversão continua marcada por '
  'is_conversion — não é papel de jornada.';

-- Um papel por organização: com duas etapas de "orçamento" o tempo até a
-- conversão dependeria de qual delas o SQL pegasse primeiro.
create unique index if not exists idx_crm_stages_journey_role
  on public.crm_stages(organization_id, journey_role)
  where journey_role is not null;

-- ------------------------------------------------------------
-- PRIMEIRO TOQUE HUMANO
--
-- least() ignora nulos, então basta ter um dos dois rastros. Nulo de volta
-- = ninguém do time tocou este lead: ele nasceu, viveu e (talvez) morreu
-- na mão da automação.
-- ------------------------------------------------------------
create or replace function public.crm_first_human_touch(p_contact uuid)
returns timestamptz
language sql stable security definer set search_path = public as $$
  select least(
    (
      select min(h.created_at)
      from public.crm_stage_history h
      where h.contact_id = p_contact
        and h.changed_by is not null
    ),
    (
      select min(v.created_at)
      from public.crm_sales v
      where v.contact_id = p_contact
        and v.created_by is not null
    )
  );
$$;

comment on function public.crm_first_human_touch(uuid) is
  'Instante em que alguém do time tocou o contato pela primeira vez — '
  'movendo de etapa ou lançando venda com sessão aberta. NULL = só '
  'automação/IA mexeram nele. Não mede mensagem: o banco não guarda '
  'conversa.';

-- ------------------------------------------------------------
-- 1. VISÃO GERAL DA JORNADA
--
-- Coorte: leads criados na janela. Todo número desta função fala da mesma
-- população, então as taxas se somam e se comparam entre si.
-- ------------------------------------------------------------
create or replace function public.crm_report_journey_overview(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  -- Quanto tempo parado já conta como abandono. 7 dias porque a automação
  -- da 050 move em 24h e o remarketing dura dias: abaixo disso o lead
  -- ainda está em atendimento, não largado.
  p_stale_days int default 7
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
language sql stable security definer set search_path = public as $$
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

comment on function public.crm_report_journey_overview(date, date, text, int) is
  'Jornada do lead na coorte da janela: transferência IA → atendente, '
  'abandono antes do primeiro humano, avanço depois dele e tempo entre '
  'orçamento e conversão. "Avançou" é o substituto de "respondeu": o banco '
  'não guarda mensagem, guarda movimentação.';

-- ------------------------------------------------------------
-- 2. CONVERSÃO POR ATENDENTE
--
-- ATRIBUIÇÃO: assigned_to quando existe; senão, quem tocou o lead
-- primeiro. Sem o segundo caminho a tabela ficaria quase toda em "sem
-- atendente" — atribuir responsável é opcional na tela, tocar o lead não.
-- A coluna inferred_leads diz quantos vieram por dedução, para ninguém
-- tomar o número por cadastro.
-- ------------------------------------------------------------
create or replace function public.crm_report_journey_by_assignee(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null
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
language sql stable security definer set search_path = public as $$
  with coorte as (
    select c.id, c.created_at, c.assigned_to, c.value_cents
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and c.created_at >= public.crm_day_start(p_from)
      and c.created_at < public.crm_day_start(p_to + 1)
      and (p_channel is null or c.channel = p_channel)
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

comment on function public.crm_report_journey_by_assignee(date, date, text) is
  'Leads e conversões por atendente na coorte da janela. Atribui pelo '
  'responsável do contato e, na falta dele, por quem tocou o lead primeiro '
  '(inferred_leads conta esses).';

-- ------------------------------------------------------------
-- 3. MOTIVOS DE PERDA (DEDUZIDOS)
--
-- Não existe campo de motivo. O que existe é o rastro: onde o lead estava,
-- se passou pelo remarketing, se um humano chegou nele, e se quem o deu
-- por perdido foi uma pessoa ou o cron da 050. Isso já separa perdas que
-- pedem ações completamente diferentes.
--
-- UNIVERSO: leads da coorte que não converteram E (estão na etapa de perda
-- OU pararam de se mover). Lead novo em atendimento não é perda.
-- ------------------------------------------------------------
create or replace function public.crm_report_journey_losses(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  p_stale_days int default 7
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
language sql stable security definer set search_path = public as $$
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

comment on function public.crm_report_journey_losses(date, date, text, int) is
  'Motivos de perda deduzidos do rastro do lead (onde parou, se passou por '
  'remarketing, se um humano chegou, e se foi o time ou a automação que o '
  'deu por perdido). Não há campo de motivo no banco — este é o motivo '
  'inferido, e vale para todo o histórico sem ninguém preencher nada.';

-- ------------------------------------------------------------
-- 4. VAZAMENTO POR ETAPA DO FUNIL
--
-- A pergunta do usuário: onde o funil perde mais gente.
--
-- A ESCADA — etapas em ordem, com a de conversão sempre por último e SEM
-- as etapas de saída (perdido/remarketing). Elas não são degraus: são
-- destinos laterais, e no funil semeado (013) Perdido tem posição MAIOR
-- que Ganho, então entrariam depois da conversão e inverteriam a leitura.
--
-- ALCANCE — por contato, o degrau mais alto que ele já pisou (histórico,
-- não etapa atual: o arquivamento da 030 tira o convertido da coluna). A
-- série é monotônica por construção, então reached[k] - reached[k+1] é
-- exatamente quanta gente ficou no degrau k.
-- ------------------------------------------------------------
create or replace function public.crm_report_journey_stage_flow(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null
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
language sql stable security definer set search_path = public as $$
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

comment on function public.crm_report_journey_stage_flow(date, date, text) is
  'Degraus do funil na ordem, com quantos leads da coorte alcançaram cada '
  'um e quantos ficaram pelo caminho. Etapas de perda e de remarketing '
  'ficam fora da escada: são destinos laterais, não degraus.';

-- ------------------------------------------------------------
-- 5. ETIQUETAS DA CONVERSA (tabela de OUTRO projeto)
--
-- As etiquetas da jornada (triagem, orçamento, Rmkt, comprouN) vivem em
-- etapas_phcreative, num Supabase separado — o do bot. Não há como fazer
-- JOIN entre dois bancos, então o caminho é o único que existe: a tela lê
-- as etiquetas de lá e manda para cá a lista {número, etapa} já
-- classificada, em jsonb. Aqui a gente casa com o CRM e devolve agregado.
--
-- O CASAMENTO É POR crm_contact_by_phone (044): mesma função que a API do
-- n8n usa, então "o mesmo cliente" quer dizer a mesma coisa nos dois
-- lugares, inclusive na tolerância ao 9 extra do celular.
--
-- `matched` é métrica de qualidade de dado, não enfeite: etiqueta de
-- número que não existe no CRM é lead que a IA atendeu e ninguém
-- cadastrou — some da conversão sem deixar rastro.
-- ------------------------------------------------------------
create or replace function public.crm_report_journey_tags(
  p_rows jsonb default '[]'::jsonb,
  p_channel text default null
)
returns table(
  stage                text,
  leads                bigint,
  matched              bigint,
  converted            bigint,
  conversion_rate      numeric,
  revenue_cents        bigint,
  human_leads          bigint,
  avg_hours_to_convert numeric
)
language sql stable security definer set search_path = public as $$
  with entrada as (
    select r.n as numero, r.s as stage
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(n text, s text, u text)
    where r.n is not null and r.s is not null
  ),
  casado as (
    select e.stage, e.numero, c.id as contact_id, c.channel, c.value_cents, c.created_at
    from entrada e
    left join lateral public.crm_contact_by_phone(public.current_org_id(), e.numero) c on true
  ),
  -- Com filtro de canal só sobra o que casou: o canal é propriedade do
  -- contato do CRM, e etiqueta sem contato não tem canal para comparar.
  filtrado as (
    select * from casado
    where p_channel is null or channel = p_channel
  ),
  fatos as (
    select
      f.*,
      (
        select min(h.created_at)
        from public.crm_stage_history h
        join public.crm_stages s on s.id = h.to_stage_id
        where h.contact_id = f.contact_id and s.is_conversion
      ) as conv_at,
      public.crm_first_human_touch(f.contact_id) as human_at
    from filtrado f
  ),
  -- Dois números do mesmo cliente (com e sem o 9) casam no mesmo contato:
  -- sem esta redução, ele contaria duas conversões e duas receitas.
  por_contato as (
    select
      stage,
      contact_id,
      max(value_cents) as value_cents,
      max(created_at)  as created_at,
      max(conv_at)     as conv_at,
      max(human_at)    as human_at
    from fatos
    where contact_id is not null
    group by stage, contact_id
  ),
  brutos as (
    select stage, count(*)::bigint as leads from filtrado group by stage
  ),
  agregado as (
    select
      stage,
      count(*)::bigint as matched,
      count(conv_at)::bigint as converted,
      coalesce(sum(value_cents) filter (where conv_at is not null), 0)::bigint as revenue,
      count(human_at)::bigint as humanos,
      round(
        (avg(extract(epoch from (conv_at - created_at)) / 3600.0)
          filter (where conv_at is not null))::numeric, 1
      ) as horas
    from por_contato
    group by stage
  )
  select
    b.stage,
    b.leads,
    coalesce(a.matched, 0),
    coalesce(a.converted, 0),
    round(100.0 * coalesce(a.converted, 0) / nullif(a.matched, 0), 1),
    coalesce(a.revenue, 0),
    coalesce(a.humanos, 0),
    a.horas
  from brutos b
  left join agregado a on a.stage = b.stage
  order by b.leads desc;
$$;

comment on function public.crm_report_journey_tags(jsonb, text) is
  'Cruza as etiquetas da conversa (vindas do Supabase do bot, já '
  'classificadas pela tela) com o CRM: por etapa da jornada, quantos leads, '
  'quantos existem no CRM, quantos converteram e quanto renderam.';

-- Quem está parado numa etapa da jornada — a lista para trabalhar, com o
-- número da conversa mesmo quando não há contato no CRM.
create or replace function public.crm_report_journey_tag_contacts(
  p_rows jsonb default '[]'::jsonb,
  p_stage text default null,
  p_channel text default null,
  p_limit int default 15
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
language sql stable security definer set search_path = public as $$
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
    select * from casado where p_channel is null or channel = p_channel
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

comment on function public.crm_report_journey_tag_contacts(jsonb, text, text, int) is
  'Leads de uma etapa da jornada, do mais parado para o mais recente. '
  'contact_id nulo = a conversa existe no bot e o contato não existe no '
  'CRM.';

-- ------------------------------------------------------------
-- BACKFILL DOS PAPÉIS — uma vez, pelos nomes de hoje
--
-- Rodar de novo não muda nada: só preenche etapa com papel nulo, e o
-- distinct on garante uma etapa por papel mesmo quando dois nomes casam
-- com o mesmo padrão ("Novo lead" e "Triagem" disputando 'triagem' —
-- ganha a de menor posição).
-- ------------------------------------------------------------
with candidatas as (
  select
    s.id,
    s.organization_id,
    s.position,
    case
      when lower(extensions.unaccent(s.name)) ~ 'perdid|perda|lost'        then 'perdido'
      when lower(extensions.unaccent(s.name)) ~ 'remarketing|rmkt|retomad' then 'remarketing'
      when lower(extensions.unaccent(s.name)) ~ 'orcament|proposta'        then 'orcamento'
      when lower(extensions.unaccent(s.name)) ~ 'triagem|qualific|novo'    then 'triagem'
    end as papel
  from public.crm_stages s
  where s.journey_role is null
    and not s.is_conversion
),
escolhidas as (
  select distinct on (organization_id, papel) id, papel
  from candidatas
  where papel is not null
  order by organization_id, papel, position, id
)
update public.crm_stages s
set journey_role = e.papel
from escolhidas e
where s.id = e.id
  -- Não atropela papel já atribuído a outra etapa da mesma organização
  -- (o índice único recusaria, e a migration morreria no meio).
  and not exists (
    select 1 from public.crm_stages x
    where x.organization_id = s.organization_id
      and x.journey_role = e.papel
  );

-- Confira o resultado do chute antes de confiar no relatório:
--
--   select name, position, is_conversion, journey_role
--   from public.crm_stages order by organization_id, position;
--
-- Para corrigir à mão (ou pelo seletor no diálogo de etapa):
--
--   update public.crm_stages set journey_role = 'orcamento' where id = '…';
