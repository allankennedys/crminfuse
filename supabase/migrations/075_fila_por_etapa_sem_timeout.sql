-- ============================================================
-- A fila por etapa da jornada estourava o statement timeout
--
-- SINTOMA: abrir "Travados no pagamento" (ou qualquer botão da fila de
-- recuperação) devolvia `canceling statement due to statement timeout`, com
-- 93 números na entrada. Noventa e três buscas não podem levar 8 segundos.
--
-- CAUSA 1 — O ÍNDICE DE TELEFONE NÃO PODIA SER USADO
--
-- A 069 criou o índice de identidade do número assim:
--
--   create index idx_crm_contacts_phone_id
--     on crm_contacts(organization_id, (crm_phone_id(phone)))
--     where phone is not null;                        <-- parcial
--
-- e crm_contact_by_phone filtra por `crm_phone_id(c.phone) is not null`.
-- São coisas diferentes: o planejador só usa um índice parcial quando
-- consegue PROVAR, pela cláusula WHERE, que a condição do índice vale. De
-- "crm_phone_id(phone) não é nulo" não se prova "phone não é nulo" — a
-- função não é declarada strict, então poderia devolver valor para entrada
-- nula. Sem a prova, cada busca virava varredura da tabela inteira.
--
-- Uma varredura por número não aparece no webhook, que busca um contato de
-- cada vez. Noventa e três seguidas, dentro da mesma consulta, batem no
-- teto de tempo. É por isso que o bug ficou invisível até esta tela existir.
--
-- Aqui o índice deixa de ser parcial. A cláusula economizava as linhas sem
-- telefone — que numa tabela de contatos de WhatsApp são poucas — e custava
-- a única coisa que o índice tinha para fazer.
--
-- CAUSA 2 — UMA FUNÇÃO POR LINHA ONDE CABIA UM JOIN SÓ
--
-- crm_report_journey_tag_contacts chamava crm_contact_by_phone dentro de um
-- LEFT JOIN LATERAL: uma execução de função, com ORDER BY e LIMIT próprios,
-- para cada número da lista. Mesmo com o índice consertado isso é caro à
-- toa — a pergunta "para estes N números, quais contatos?" é um join, e
-- passa a ser escrita como um.
--
-- O DESEMPATE CONTINUA IDÊNTICO. Quando o mesmo número tem mais de um
-- cadastro, a escolha é a mesma da 069, na mesma ordem: venda registrada,
-- canal desconhecido (o lateral chamava sem canal, e `is not distinct from
-- null` só é verdade para canal nulo — preservado aqui como está, não como
-- deveria ser), origem preenchida e, por fim, o cadastro mais antigo.
-- Trocar esse critério mudaria QUEM aparece na fila, e isso não é assunto
-- desta migration.
-- ============================================================

-- ------------------------------------------------------------
-- 1. O índice que o planejador consegue usar
--
-- Cria o novo antes de derrubar o velho: entre um comando e outro a busca
-- por telefone continua tendo por onde passar.
-- ------------------------------------------------------------
create index if not exists idx_crm_contacts_phone_id_full
  on public.crm_contacts(organization_id, (public.crm_phone_id(phone)));

drop index if exists public.idx_crm_contacts_phone_id;

-- ------------------------------------------------------------
-- 2. A busca por telefone declara o que o índice pede
--
-- `phone is not null` é redundante com a linha de baixo (número nulo não
-- tem identidade), mas é ela que o planejador entende. Mesmo corpo da 069
-- no resto — inclusive o desempate, que é definição de negócio.
-- ------------------------------------------------------------
create or replace function public.crm_contact_by_phone(
  p_org uuid,
  p_phone text,
  p_channel text default null,
  p_strict boolean default false
)
returns setof public.crm_contacts
language sql stable set search_path = public as $$
  select c.*
  from public.crm_contacts c
  where c.organization_id = p_org
    and c.phone is not null
    and public.crm_phone_id(c.phone) is not null
    and public.crm_phone_id(c.phone) = public.crm_phone_id(p_phone)
    and (
      case
        when p_strict then
          public.crm_channel_key(c.channel) is not distinct from public.crm_channel_key(p_channel)
        when public.crm_channel_key(p_channel) is null then true
        else public.crm_channel_key(c.channel) is null
          or public.crm_channel_key(c.channel) = public.crm_channel_key(p_channel)
      end
    )
  order by
    (coalesce(c.sales_count, 0) > 0) desc,
    (public.crm_channel_key(c.channel) is not distinct from public.crm_channel_key(p_channel)) desc,
    (nullif(btrim(coalesce(c.origem, '')), '') is not null) desc,
    c.created_at
  limit 1;
$$;

-- ------------------------------------------------------------
-- 3. A fila por etapa, em um join
--
-- Mesma assinatura da 063 (create or replace substitui no lugar), mesmas
-- colunas, mesma ordem de saída. O que muda é o plano.
-- ------------------------------------------------------------
create or replace function public.crm_report_journey_tag_contacts(
  p_rows jsonb default '[]'::jsonb,
  p_stage text default null,
  p_channel text default null,
  p_limit int default 15,
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
    select
      r.n as numero,
      r.u as visto_em,
      -- Calculada uma vez por número, do lado de fora do join: dentro dele
      -- seria recalculada a cada comparação.
      public.crm_phone_id(r.n) as num_id
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(n text, s text, u text)
    where r.n is not null
      and (p_stage is null or r.s = p_stage)
  ),
  -- Um contato por número. O distinct on + order by é o desempate da 069
  -- escrito em conjunto, no lugar de um limit 1 por linha.
  casado as (
    select distinct on (e.numero)
      e.numero,
      e.visto_em,
      c.id as contact_id, c.name, c.phone, c.channel, c.origem,
      c.stage_id, c.assigned_to
    from entrada e
    left join public.crm_contacts c
      on c.organization_id = public.current_org_id()
     and e.num_id is not null
     and c.phone is not null
     and public.crm_phone_id(c.phone) = e.num_id
    order by
      e.numero,
      (coalesce(c.sales_count, 0) > 0) desc,
      -- Sem canal na pergunta, o cadastro de canal desconhecido vence.
      (public.crm_channel_key(c.channel) is null) desc,
      (nullif(btrim(coalesce(c.origem, '')), '') is not null) desc,
      c.created_at
  ),
  -- Colunas qualificadas: os nomes de saída da função (channel, origem…)
  -- também são visíveis aqui, e um alias tira a dúvida de quem lê.
  filtrado as (
    select k.* from casado k
    where (p_channel is null or k.channel = p_channel)
      and (p_origem is null or
           lower(extensions.unaccent(k.origem)) = lower(extensions.unaccent(p_origem)))
  ),
  -- Quem já converteu, para todos de uma vez. O exists por linha fazia a
  -- mesma pergunta uma vez por contato.
  convertidos as (
    select distinct h.contact_id
    from public.crm_stage_history h
    join public.crm_stages s on s.id = h.to_stage_id
    where s.is_conversion
      and h.contact_id in (select f.contact_id from filtrado f where f.contact_id is not null)
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
    (f.contact_id is not null and exists (
      select 1 from convertidos v where v.contact_id = f.contact_id
    )),
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
  'CRM. Casa por identidade do número num join só (075) — a versão anterior '
  'chamava crm_contact_by_phone por linha e estourava o timeout.';
