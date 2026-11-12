-- ============================================================
-- Mais de uma conta de anúncios por organização
--
-- A 052 nasceu com UMA conta: `crm_settings.meta_ad_account_id`, um texto
-- só. A operação usa três, e com um campo só o relatório mostrava o gasto
-- de uma delas ao lado da receita de TODAS — o ROI saía inflado em três
-- vezes sem nada na tela denunciando isso. É o pior tipo de erro de
-- relatório: o número é plausível.
--
-- POR QUE UMA TABELA E NÃO UMA LISTA NO MESMO CAMPO
--
-- Cada conta pode precisar do PRÓPRIO token: contas em Business Managers
-- diferentes não são alcançadas pelo mesmo usuário de sistema, e forçar um
-- token único obrigaria a operação a juntar as três num BM só para ver o
-- relatório. Com uma linha por conta, o token é opcional em cada uma e cai
-- na cascata de sempre (token da conta → meta_ads_token → meta_access_token),
-- então quem tem tudo no mesmo BM continua preenchendo nada.
--
-- `label` existe porque o nome que a Meta devolve é o do Gerenciador
-- ("Conta publicitária de Fulano"), que em três contas parecidas não
-- distingue nada. O rótulo local ganha da Meta na tela.
--
-- O QUE CONTINUA VALENDO
--
-- meta_ad_account_id NÃO sai da crm_settings. Ele vira espelho da primeira
-- conta da lista, mantido pelas RPCs daqui, por dois motivos:
--
--   1. ordem de deploy — migration entra antes da Edge Function nova, e
--      entre uma coisa e outra a função velha continua lendo o campo e
--      achando uma conta válida em vez de erro de "não configurada";
--   2. a Edge Function nova usa o campo como fallback quando a tabela está
--      vazia, o que cobre qualquer org que nunca abra a tela nova.
--
-- A METADE CRM NÃO SE DIVIDE POR CONTA
--
-- Nenhuma função de relatório muda aqui, e isso é uma decisão, não um
-- esquecimento: o CRM não sabe de qual conta veio o lead. ctwa_clid é
-- opaco na API, e a origem é um rótulo escrito pela operação — nada nos
-- contatos aponta para uma conta de anúncios. Logo, receita, ticket e LTV
-- só existem para o conjunto. Filtrar uma conta na tela filtra o lado da
-- META apenas, e é por isso que a tela esconde ROI, CAC e CPL quando a
-- seleção não é "todas": dividir a receita da org inteira pelo gasto de uma
-- conta daria um número inventado.
-- ============================================================

-- ------------------------------------------------------------
-- NORMALIZAÇÃO
--
-- A mesma regra do normalizeAccount da Edge Function, agora no banco: sem
-- ela "act_123", "123" e "ACT_123" seriam três linhas diferentes e o
-- relatório consultaria a mesma conta três vezes, somando o gasto dela em
-- triplicado. É o índice único que precisa dessa forma canônica.
--
-- immutable: só depende do argumento, o que permite usá-la no índice.
-- ------------------------------------------------------------
create or replace function public.crm_normalize_ad_account(p_id text)
returns text
language sql immutable as $$
  select case
    when coalesce(regexp_replace(coalesce(p_id, ''), '\D', '', 'g'), '') = '' then null
    else 'act_' || regexp_replace(p_id, '\D', '', 'g')
  end;
$$;

comment on function public.crm_normalize_ad_account(text) is
  'act_<dígitos> a partir de qualquer grafia que o usuário cole. Nulo quando '
  'não sobra dígito nenhum. Espelha normalizeAccount da Edge Function meta-ads.';

-- ------------------------------------------------------------
-- TABELA
-- ------------------------------------------------------------
create table if not exists public.crm_ad_accounts (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Sempre na forma canônica: quem grava é a RPC, que normaliza antes.
  account_id text not null,
  -- Apelido da operação ("Principal", "Criativos", "Teste"). Nulo = usa o
  -- nome que a Meta devolver.
  label text,
  -- Token só desta conta. Nulo cai em meta_ads_token e depois em
  -- meta_access_token — a mesma cascata que a 052 já usava.
  access_token text,
  -- Ordem na tela e, principalmente, quem é a "primeira" conta espelhada em
  -- crm_settings.meta_ad_account_id.
  --
  -- NÃO se chama `position`: é palavra-chave do SQL padrão (POSITION(x IN y))
  -- e o parser recusa `position int` num `returns table`. Como coluna de
  -- tabela ela até passa — crm_stages tem uma —, mas aqui a lista sai por
  -- RPC, e o nome precisa valer nos dois lugares.
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A mesma conta duas vezes na org somaria o gasto dela em dobro.
  unique (organization_id, account_id)
);

create index if not exists idx_crm_ad_accounts_org
  on public.crm_ad_accounts(organization_id, sort_order, created_at);

comment on table public.crm_ad_accounts is
  'Contas de anúncios lidas pelo relatório de Meta ADS. Uma linha por conta, '
  'com token próprio opcional. RLS ligada e sem policy: tem token dentro, '
  'todo acesso passa pelas RPCs (mesmo desenho de crm_settings).';

-- ------------------------------------------------------------
-- IMPORTAÇÃO DO QUE JÁ ESTAVA CONFIGURADO
--
-- Sem isto toda org perderia a conta única no dia do deploy e o relatório
-- amanheceria dizendo "não configurada".
-- ------------------------------------------------------------
insert into public.crm_ad_accounts (organization_id, account_id, sort_order)
select s.organization_id,
       public.crm_normalize_ad_account(s.meta_ad_account_id),
       0
from public.crm_settings s
where public.crm_normalize_ad_account(s.meta_ad_account_id) is not null
on conflict (organization_id, account_id) do nothing;

-- ------------------------------------------------------------
-- RLS: ligada, sem policy — igual a crm_settings (013).
-- ------------------------------------------------------------
alter table public.crm_ad_accounts enable row level security;

-- ------------------------------------------------------------
-- LISTA
--
-- Devolve has_token, nunca o token: mesma regra do crm_settings_get. Aberta
-- a qualquer membro da org porque o relatório precisa dos rótulos para
-- montar o seletor — só a escrita é de admin.
-- ------------------------------------------------------------
create or replace function public.crm_ad_accounts_list()
returns table(
  id         uuid,
  account_id text,
  label      text,
  has_token  boolean,
  sort_order int
)
language sql stable security definer set search_path = public as $$
  select a.id, a.account_id, a.label,
         coalesce(a.access_token, '') <> '',
         a.sort_order
  from public.crm_ad_accounts a
  where a.organization_id = public.current_org_id()
  order by a.sort_order, a.created_at;
$$;

-- ------------------------------------------------------------
-- ESPELHO EM crm_settings
--
-- Mantém meta_ad_account_id apontando para a primeira conta da lista (ou
-- nulo, quando não sobrou nenhuma). Ver o cabeçalho: é o que segura a
-- janela entre a migration e o deploy da Edge Function nova.
-- ------------------------------------------------------------
create or replace function public.crm_ad_accounts_sync_legacy(p_org uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_first text;
begin
  select a.account_id into v_first
  from public.crm_ad_accounts a
  where a.organization_id = p_org
  order by a.sort_order, a.created_at
  limit 1;

  update public.crm_settings
     set meta_ad_account_id = v_first, updated_at = now()
   where organization_id = p_org;
end;
$$;

-- ------------------------------------------------------------
-- GRAVAR (inserir ou editar)
--
-- p_id nulo = conta nova. As regras de nulo do token são as MESMAS dos
-- outros campos secretos do projeto, pelo motivo de sempre — a tela nunca
-- recebe o token, então campo em branco não pode significar "apague":
--
--   null → não mexe no que está salvo
--   ''   → apaga
--
-- Conflito de account_id não vira erro de constraint solto na cara do
-- usuário: a checagem antes do insert devolve uma mensagem que diz o que
-- fazer.
-- ------------------------------------------------------------
create or replace function public.crm_ad_account_save(
  p_id      uuid default null,
  p_account text default null,
  p_label   text default null,
  p_token   text default null
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
  v_account text := public.crm_normalize_ad_account(p_account);
  v_id uuid;
begin
  -- Mesma regra da 054: conta de anúncios decide de onde vem o número do
  -- custo, e o token dela alcança o Gerenciador inteiro.
  if public.current_user_role() <> 'admin' then
    raise exception 'Apenas administradores podem alterar as contas de anúncios';
  end if;

  if v_account is null then
    raise exception 'Informe o ID da conta de anúncios (act_XXXXXXXX)';
  end if;

  if exists (
    select 1 from public.crm_ad_accounts a
    where a.organization_id = v_org
      and a.account_id = v_account
      and (p_id is null or a.id <> p_id)
  ) then
    raise exception 'Esta conta de anúncios já está na lista';
  end if;

  if p_id is null then
    insert into public.crm_ad_accounts (
      organization_id, account_id, label, access_token, sort_order
    )
    values (
      v_org, v_account, nullif(btrim(coalesce(p_label, '')), ''), nullif(p_token, ''),
      coalesce(
        (select max(a.sort_order) + 1 from public.crm_ad_accounts a
          where a.organization_id = v_org),
        0
      )
    )
    returning id into v_id;
  else
    update public.crm_ad_accounts a
       set account_id   = v_account,
           label        = nullif(btrim(coalesce(p_label, '')), ''),
           access_token = case
             when p_token is null then a.access_token
             else nullif(p_token, '')
           end,
           updated_at   = now()
     where a.id = p_id
       and a.organization_id = v_org
    returning a.id into v_id;

    if v_id is null then
      raise exception 'Conta de anúncios não encontrada';
    end if;
  end if;

  perform public.crm_ad_accounts_sync_legacy(v_org);
  return v_id;
end;
$$;

-- ------------------------------------------------------------
-- REMOVER
-- ------------------------------------------------------------
create or replace function public.crm_ad_account_delete(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
begin
  if public.current_user_role() <> 'admin' then
    raise exception 'Apenas administradores podem alterar as contas de anúncios';
  end if;

  delete from public.crm_ad_accounts a
   where a.id = p_id and a.organization_id = v_org;

  perform public.crm_ad_accounts_sync_legacy(v_org);
end;
$$;

comment on function public.crm_ad_account_save(uuid, text, text, text) is
  'Insere ou edita uma conta de anúncios da org. Token nulo mantém o salvo, '
  'string vazia apaga — a tela nunca recebe o token de volta.';
