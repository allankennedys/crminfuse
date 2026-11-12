-- ============================================================
-- Jornada, parte 3: o relógio da conversa substitui o "toque humano"
--
-- POR QUE A 060 PRECISOU SER APOSENTADA NESTE PONTO
--
-- crm_first_human_touch() (060) chama de humano quem move etapa ou lança
-- venda COM SESSÃO ABERTA: changed_by / created_by preenchidos. O trigger
-- da 013 carimba source='ui' quando há auth.uid() e 'api' quando não há.
--
-- Só que aqui o vendedor não mexe no CRM: ele conversa no WhatsApp e o n8n
-- lê a conversa, decide e escreve pela service role. Ou seja, o trabalho do
-- VENDEDOR chega ao banco com o mesmo rastro que a IA agindo sozinha —
-- source='api', changed_by null. Não existe coluna que separe os dois.
--
-- Então "transferência IA → atendente", "abandono antes do atendente" e
-- "avançou depois do atendimento" não mediam atendimento: mediam quem abriu
-- a tela. Um relatório que chama isso de atendimento mente com precisão de
-- uma casa decimal.
--
-- O QUE SUBSTITUI
--
-- A conversa tem hora de verdade. conversation_messages diz quando o lead
-- falou e quando saiu resposta, e isso independe de quem escreveu a linha no
-- CRM. Os cortes passam a ser:
--
--   antes (060)                      agora (062)
--   ---------------------------      ---------------------------------
--   1º toque humano                  1ª resposta depois da fala do lead
--   transferência IA → atendente     leads que receberam resposta
--   abandono antes do atendente      leads que ficaram sem resposta
--   avançou depois do atendimento    avançou depois da 1ª resposta
--
-- O QUE ESTE ARQUIVO NÃO RESOLVE — E É PROPOSITAL
--
-- sender_type separa 'client' de 'agent' e nada mais. IA e vendedor mandam
-- pelo mesmo número, então NENHUMA métrica daqui afirma que foi gente que
-- respondeu. Ela afirma que houve resposta. Separar os dois exige que o n8n
-- passe o autor na escrita — é trabalho do lado de lá, e não dá para
-- reconstruir o histórico depois.
--
-- As funções da 060/061 continuam existindo com as colunas antigas
-- (human_leads, transfer_rate, reply_after_human_rate…). Elas simplesmente
-- deixam de ser lidas pela tela. Não removo coluna de função em produção
-- por um relatório: o custo de um drop errado é maior que o de uma coluna
-- ignorada.
-- ============================================================

do $$
begin
  if to_regclass('public.conversation_messages') is null then
    raise exception 'Tabela public.conversation_messages não existe neste banco';
  end if;
  if to_regprocedure('public.crm_phone_key(text)') is null then
    raise exception 'Aplique a migration 044 antes desta: crm_phone_key() não existe';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. VISÃO GERAL PELO RELÓGIO DA CONVERSA
--
-- Coorte: leads criados na janela, a mesma da 060 — os números das duas
-- funções falam da mesma população e podem ser comparados lado a lado.
--
-- ÂNCORA: `primeira_do_cliente` é a primeira fala do lead, e `respondida_em`
-- é a primeira saída DEPOIS dela. A ordem importa: saída anterior à fala do
-- cliente é disparo (remarketing, template), não resposta — contar isso como
-- atendimento daria 100% de resposta em qualquer base que faça disparo.
-- ------------------------------------------------------------
create or replace function public.crm_report_journey_conversation(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  -- Silêncio a partir do qual "ainda não respondemos" vira "não respondemos".
  -- Lead que falou hoje de madrugada não é abandono às 9h.
  p_stale_days int default 7
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
language sql stable security definer set search_path = public as $$
  with coorte as (
    select c.id, c.created_at, c.phone_key
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and c.created_at >= public.crm_day_start(p_from)
      and c.created_at < public.crm_day_start(p_to + 1)
      and (p_channel is null or c.channel = p_channel)
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

comment on function public.crm_report_journey_conversation(date, date, text, int) is
  'Jornada medida pelo relógio da conversa, não por quem escreveu a linha no '
  'CRM: quantos leads receberam resposta, em quanto tempo, quantos voltaram a '
  'falar e quantos andaram no funil depois disso. Substitui as métricas de '
  '"toque humano" da 060, que aqui mediam apenas quem abriu a tela — o '
  'vendedor trabalha no WhatsApp e o n8n escreve por ele. NÃO distingue IA de '
  'vendedor: sender_type ''agent'' é qualquer saída.';

-- ------------------------------------------------------------
-- 2. A FILA DE QUEM PAROU DE FALAR
--
-- A versão da 061 listava "leads que o time atendeu e calaram", ancorada em
-- crm_first_human_touch — mesmo defeito. A pergunta operacional não precisa
-- saber quem respondeu; precisa saber COM QUEM ESTÁ A BOLA.
--
-- Regra nova: a última mensagem da conversa é NOSSA e o lead não converteu.
-- Falamos por último e ele não voltou. Inclui o lead que nunca falou nada
-- (só recebeu disparo), marcado por last_client_at nulo.
--
-- "NÃO CONVERTEU" TEM TRÊS PORTAS, E TODAS PRECISAM ESTAR FECHADAS
--
--   1. nenhuma passagem por etapa de conversão (crm_stage_history)
--   2. nenhuma venda lançada (crm_sales)
--   3. nenhuma etiqueta de compra em crm_contacts.tags
--
-- A terceira existe porque quem marca a compra costuma ser o n8n, e ele nem
-- sempre move a etapa: a etiqueta chega pelo crm-api (applyTags) e fica só
-- no array. Sem essa porta, cliente que já comprou aparece na fila de
-- recuperação — é o pior erro possível numa lista de "vá cobrar".
--
-- O padrão é o mesmo do bot ('comprou', 'comprou2'…), normalizado como o
-- jornadaService faz: minúscula e sem espaço/hífen/underline. Casa por
-- PREFIXO, não exato: numa lista de cobrança, excluir um lead a mais é
-- barato e incomodar quem já pagou não é.
-- ------------------------------------------------------------
drop function if exists public.crm_report_journey_silent(date, date, text, int);

create or replace function public.crm_report_journey_silent(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  p_limit int default 15
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
language sql stable security definer set search_path = public as $$
  with coorte as (
    select c.id, c.name, c.phone, c.phone_key, c.channel, c.origem, c.stage_id, c.assigned_to
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and c.created_at >= public.crm_day_start(p_from)
      and c.created_at < public.crm_day_start(p_to + 1)
      and (p_channel is null or c.channel = p_channel)
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

comment on function public.crm_report_journey_silent(date, date, text, int) is
  'Leads que NÃO compraram (sem etapa de conversão, sem venda lançada e sem '
  'etiqueta comprou* em crm_contacts.tags) e em que a ÚLTIMA mensagem foi '
  'nossa — do silêncio mais antigo para o mais recente. last_client_at nulo '
  '= nunca falou nada, só '
  'recebeu. Não afirma quem respondeu: a tabela de mensagens não separa IA '
  'de vendedor.';
