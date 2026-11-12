-- ============================================================
-- Portfólio passa a ter tabela própria
--
-- Até aqui o degrau do Portfólio na aba Jornada vinha da ETIQUETA da
-- conversa (083), que vive no Supabase do bot: sem data, digitada por gente
-- ("portifólio"), lida pelo navegador e mandada para cá como lista de
-- números. A partir desta migration quem diz que o cliente entrou no
-- portfólio é crm_portfolio_entries, preenchida pelo n8n pela crm-api
-- (action "portfolio").
--
-- A ETIQUETA DEIXA DE CONTAR EM QUALQUER PERÍODO. Decisão de 11/09/2026:
-- período anterior à tabela mostra o degrau zerado, em vez de misturar duas
-- fontes que medem coisas diferentes (a etiqueta nem data tem).
--
-- UMA LINHA POR CLIENTE, A PRIMEIRA
--
-- "Entrou no portfólio" é um marco, não um evento que se repete. O n8n
-- reenvia em timeout, e o portfólio pode ser mandado de novo — nenhum dos
-- dois pode contar duas vezes nem empurrar a data para frente. O índice
-- único por telefone faz o banco ignorar o repetido, e a crm-api devolve o
-- registro que já existia.
--
-- POR TELEFONE, NÃO POR CONTATO
--
-- A etiqueta sempre foi por número (a tabela do bot tem uma linha por
-- WhatsApp), e o funil casa o degrau com os contatos por telefone (083). A
-- chave aqui é a mesma: phone_id é crm_phone_id (069), que reconhece o
-- número com ou sem o 55 e com ou sem o 9. contact_id fica gravado quando a
-- crm-api acha o cadastro, para consulta — não é ele que decide o degrau,
-- porque o portfólio pode ir para quem ainda nem tem cadastro no CRM.
--
-- ORDEM DE DEPLOY: esta migration → crm-api → frontend. Sem a tabela, a
-- action nova da crm-api responde erro; sem a crm-api, o n8n não tem onde
-- registrar; o frontend lê a tabela e mostra o degrau zerado enquanto ela
-- estiver vazia. Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

create table if not exists public.crm_portfolio_entries (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Apagar o contato não apaga o marco: o número continua tendo recebido o
  -- portfólio, e é pelo número que o funil conta.
  contact_id      uuid references public.crm_contacts(id) on delete set null,
  -- Só dígitos, como o n8n mandou.
  phone           text not null check (phone ~ '^[0-9]{8,}$'),
  phone_id        text generated always as (public.crm_phone_id(phone)) stored,
  channel         text,
  -- Quando o cliente entrou no portfólio. O n8n pode mandar a hora certa
  -- (enteredAt); sem ela, vale a hora do registro.
  entered_at      timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

comment on table public.crm_portfolio_entries is
  'Quem entrou no portfólio, e quando. Uma linha por telefone por '
  'organização: a primeira vale. Preenchida pela crm-api (action '
  '"portfolio"); é daqui que sai o degrau do Portfólio na aba Jornada (091).';

create unique index if not exists idx_crm_portfolio_entries_phone
  on public.crm_portfolio_entries (organization_id, phone_id);

-- A aba Jornada lê "quem entrou desde o início do período".
create index if not exists idx_crm_portfolio_entries_entered
  on public.crm_portfolio_entries (organization_id, entered_at);

-- Leitura para quem vê relatório; escrita só pela crm-api, que roda com a
-- service role e passa por cima da RLS. Sem policy de insert, update ou
-- delete, de propósito: o marco não se edita pela tela.
alter table public.crm_portfolio_entries enable row level security;

drop policy if exists crm_portfolio_entries_select on public.crm_portfolio_entries;
create policy crm_portfolio_entries_select on public.crm_portfolio_entries
  for select using (
    organization_id = public.current_org_id()
    and public.current_user_can('crm.relatorios.ver')
  );

-- ------------------------------------------------------------
-- Registro, pela crm-api
--
-- Gravar e, se já existia, devolver o que existia — numa chamada só. Feito
-- no banco para a regra de "mesmo telefone" continuar morando só aqui
-- (crm_phone_id), como a crm-api já faz com o contato.
--
-- Os nomes de saída não repetem os da tabela: em plpgsql a coluna de saída
-- vira variável, e `entered_at` dos dois lados daria referência ambígua.
-- ------------------------------------------------------------
create or replace function public.crm_portfolio_register(
  p_org        uuid,
  p_phone      text,
  p_channel    text,
  p_contact    uuid,
  p_entered_at timestamptz
)
returns table(entry_id uuid, entry_at timestamptz, created boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_at timestamptz;
begin
  insert into public.crm_portfolio_entries (
    organization_id, contact_id, phone, channel, entered_at
  ) values (
    p_org,
    p_contact,
    regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'),
    nullif(btrim(coalesce(p_channel, '')), ''),
    coalesce(p_entered_at, now())
  )
  on conflict (organization_id, phone_id) do nothing
  returning id, entered_at into v_id, v_at;

  if v_id is not null then
    return query select v_id, v_at, true;
    return;
  end if;

  -- Já estava: o registro de antes, com a data de antes.
  return query
    select e.id, e.entered_at, false
    from public.crm_portfolio_entries e
    where e.organization_id = p_org
      and e.phone_id = public.crm_phone_id(p_phone);
end;
$$;

comment on function public.crm_portfolio_register(uuid, text, text, uuid, timestamptz) is
  'Registra que o telefone entrou no portfólio. Repetido não grava de novo '
  'nem mexe na data: devolve o registro que já existia, com created = false.';

revoke all on function public.crm_portfolio_register(uuid, text, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.crm_portfolio_register(uuid, text, text, uuid, timestamptz)
  to service_role;
