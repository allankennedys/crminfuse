-- ============================================================
-- Jornada, parte 2: as mensagens da conversa
--
-- A 060 disse, com todas as letras, que três métricas não tinham resposta
-- possível: se o lead RESPONDEU depois do atendimento, quantas MENSAGENS
-- foram até a venda, e se ele voltou a falar depois do remarketing. O
-- motivo era simples — não havia tabela de mensagem.
--
-- Agora há: public.conversation_messages, no MESMO banco do CRM. Então
-- nada aqui é integração entre bancos; é JOIN.
--
-- COMO A CONVERSA ENCOSTA NO CRM
--
-- Por telefone canônico (044), a mesma regra do resto do projeto:
-- crm_phone_key() dos dois lados, para o 9 extra do celular não separar o
-- cliente da própria conversa. A tabela de mensagens NÃO tem
-- organization_id — quem entra na conta é sempre o contato, que é filtrado
-- por current_org_id(); conversa cujo número não é contato desta
-- organização simplesmente não participa.
--
-- 'agent' É QUALQUER SAÍDA — IA OU GENTE
--
-- sender_type só distingue 'client' de 'agent', e a IA e o time mandam
-- pelo mesmo número. Então nenhuma métrica daqui pode afirmar "o humano
-- respondeu": quem sabe a hora em que o time entrou é o CRM
-- (crm_first_human_touch, 060), e é ele que fornece o instante de corte.
--
-- A divisão de trabalho ficou:
--   quando algo aconteceu  → CRM (histórico de etapa, venda)
--   se alguém falou        → conversation_messages
--
-- ÍNDICE, PORQUE O JOIN É POR EXPRESSÃO
--
-- Os índices que a tabela já tem são em number e em sent_at. Nenhum serve
-- para casar por telefone canônico: crm_phone_key(number) é outra
-- expressão. Sem o índice abaixo, cada abertura da aba faria varredura
-- completa da tabela de mensagens.
-- ============================================================

do $$
begin
  if to_regprocedure('public.crm_first_human_touch(uuid)') is null then
    raise exception 'Aplique a migration 060 antes desta: crm_first_human_touch() não existe';
  end if;
end $$;

-- Infuse: no banco da PH esta tabela é do robô de atendimento e já existia
-- antes do CRM. Num banco novo ela não existe — cria vazia, com as três
-- colunas que a Jornada lê. Sem robô gravando nela, as métricas de
-- conversa da Jornada ficam zeradas (o resto do relatório funciona).
create table if not exists public.conversation_messages (
  id          bigserial primary key,
  number      text not null,
  sender_type text not null check (sender_type in ('client', 'agent')),
  content     text,
  sent_at     timestamptz not null default now()
);
alter table public.conversation_messages enable row level security;

-- crm_phone_key é immutable (044), então serve de chave de índice. A ordem
-- (chave, sent_at) atende os dois acessos desta migration: achar a conversa
-- de um contato e recortá-la por instante (até a conversão, depois do
-- atendimento humano).
create index if not exists idx_conversation_phone_key_sent
  on public.conversation_messages (public.crm_phone_key(number), sent_at);

comment on index public.idx_conversation_phone_key_sent is
  'Casa a conversa com crm_contacts.phone_key (044) e recorta por instante. '
  'Os índices originais (number, sent_at) não servem: o join é pela '
  'expressão crm_phone_key(number), não pelo número cru.';

-- ------------------------------------------------------------
-- MÉTRICAS DE CONVERSA DA COORTE
--
-- Coorte por data de entrada do lead, igual ao resto da aba Jornada: assim
-- estes números conversam com os da 060 em vez de contarem outra gente.
--
-- O QUE CADA JANELA SIGNIFICA AQUI
--
-- A janela recorta os LEADS, não as mensagens. Uma conversa que começou
-- dentro do período e seguiu depois dele entra inteira — cortar a conversa
-- no fim do mês contaria metade das mensagens de uma venda e daria uma
-- média que não descreve negociação nenhuma.
-- ------------------------------------------------------------
create or replace function public.crm_report_journey_messages(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null
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
language sql stable security definer set search_path = public as $$
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

comment on function public.crm_report_journey_messages(date, date, text) is
  'Métricas de conversa da coorte: taxa de resposta do lead depois de o time '
  'assumir, mensagens até a venda e retorno depois do remarketing. Casa '
  'conversation_messages com crm_contacts por telefone canônico (044). '
  'sender_type ''agent'' é qualquer saída — IA ou gente; quem marca a hora do '
  'humano é o CRM.';

-- ------------------------------------------------------------
-- QUEM O TIME ATENDEU E NÃO RESPONDEU MAIS
--
-- A lista que sai da taxa de resposta. Ordena pelo silêncio mais antigo:
-- é lead que já teve trabalho humano em cima e está esfriando.
-- ------------------------------------------------------------
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
  human_at       timestamptz,
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
      -- Já vendeu não é silêncio: é cliente.
      and not exists (
        select 1 from public.crm_stage_history h
        join public.crm_stages s on s.id = h.to_stage_id
        where h.contact_id = c.id and s.is_conversion
      )
  ),
  atendidos as (
    select co.*, public.crm_first_human_touch(co.id) as human_at
    from coorte co
  ),
  calados as (
    select
      a.*,
      (
        select count(*)
        from public.conversation_messages m
        where public.crm_phone_key(m.number) = a.phone_key
      ) as msgs,
      (
        select max(m.sent_at)
        from public.conversation_messages m
        where public.crm_phone_key(m.number) = a.phone_key
          and m.sender_type = 'client'
      ) as last_client_at
    from atendidos a
    where a.human_at is not null
  )
  select
    c.id,
    c.name,
    c.phone,
    c.channel,
    c.origem,
    s.name,
    coalesce(u.full_name, u.email),
    c.human_at,
    c.last_client_at,
    round((extract(epoch from (now() - coalesce(c.last_client_at, c.human_at))) / 86400.0)::numeric, 1),
    c.msgs::bigint,
    count(*) over ()::bigint
  from calados c
  left join public.crm_stages s on s.id = c.stage_id
  left join public.users u on u.id = c.assigned_to
  -- Nunca respondeu depois do atendimento: ou não falou mais nada, ou a
  -- última fala dele é anterior ao momento em que o time entrou.
  where c.last_client_at is null or c.last_client_at <= c.human_at
  order by coalesce(c.last_client_at, c.human_at)
  limit greatest(p_limit, 1);
$$;

comment on function public.crm_report_journey_silent(date, date, text, int) is
  'Leads que o time atendeu, que não converteram e que não falaram mais nada '
  'depois disso — do silêncio mais antigo para o mais recente.';
