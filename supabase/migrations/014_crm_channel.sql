-- ============================================================
-- CRM: canal de origem do contato
--
-- Texto livre indicando de qual WhatsApp (ou outra origem) o contato
-- veio. Aparece no card do kanban, é aceito pela API e serve de filtro
-- do funil.
--
-- Por que texto livre e não uma FK para whatsapp_sessions: o canal pode
-- vir de fora do PH Groups (um bot, uma landing page, outro número que
-- nem está cadastrado aqui). Uma FK obrigaria a cadastrar a origem antes
-- de aceitar o lead, e a automação quebraria justamente na captura.
-- ============================================================

alter table public.crm_contacts
  add column if not exists channel text;

-- Filtrar o kanban por canal: índice cobre o caminho "etapa + canal".
create index if not exists idx_crm_contacts_channel
  on public.crm_contacts(organization_id, channel)
  where channel is not null;

-- ------------------------------------------------------------
-- RPCs do kanban, agora com filtro de canal
--
-- ATENÇÃO: as versões antigas precisam ser removidas explicitamente.
-- `create or replace` com lista de parâmetros diferente cria uma
-- SOBRECARGA, não substitui — ficariam crm_board(int) e
-- crm_board(int,text) convivendo, e o PostgREST não saberia qual chamar.
-- ------------------------------------------------------------
drop function if exists public.crm_board(int);
drop function if exists public.crm_stage_stats();

-- Os N primeiros contatos de cada etapa, opcionalmente de um canal só.
create or replace function public.crm_board(
  p_per_stage int default 20,
  p_channel text default null
)
returns setof public.crm_contacts
language sql stable security definer set search_path = public as $$
  -- Ranqueia a LINHA INTEIRA como composto (`c`) e expande com (r.c).*
  -- só no fim: `select *, row_number()` acrescentaria a coluna rn ao
  -- resultado e quebraria o tipo de retorno declarado.
  select (r.c).*
  from (
    select c,
           row_number() over (
             partition by c.stage_id
             order by c.position, c.created_at desc
           ) as rn
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and c.stage_id is not null
      and (p_channel is null or c.channel = p_channel)
  ) r
  where r.rn <= greatest(p_per_stage, 1);
$$;

-- Contagem e soma por etapa. Respeita o mesmo filtro de canal, senão o
-- cabeçalho da coluna mostraria 3.000 enquanto a lista filtrada tem 5.
create or replace function public.crm_stage_stats(p_channel text default null)
returns table (stage_id uuid, contact_count bigint, total_value_cents bigint)
language sql stable security definer set search_path = public as $$
  select c.stage_id, count(*), coalesce(sum(c.value_cents), 0)
  from public.crm_contacts c
  where c.organization_id = public.current_org_id()
    and c.stage_id is not null
    and (p_channel is null or c.channel = p_channel)
  group by c.stage_id;
$$;

-- Canais em uso, para montar o seletor de filtro sem varrer a tabela
-- inteira no cliente.
create or replace function public.crm_channels()
returns table (channel text, contact_count bigint)
language sql stable security definer set search_path = public as $$
  select c.channel, count(*)
  from public.crm_contacts c
  where c.organization_id = public.current_org_id()
    and c.channel is not null
    and c.channel <> ''
  group by c.channel
  order by count(*) desc, c.channel;
$$;
