-- ============================================================
-- Ligar e desligar uma conta de anúncios sem deploy
--
-- O relatório de campanhas de 2 em 2 horas (086 + Edge Function
-- `ads-campaigns`) só lê as contas marcadas como ativas. O pedido foi
-- explícito: "precisa ser fácil ligar/desligar cada conta sem mexer no
-- código". Isto é a chave de luz.
--
-- POR QUE UMA COLUNA E NÃO REMOVER A CONTA DA LISTA
--
-- Remover apaga o rótulo e o token próprio junto. Quem desliga uma conta por
-- duas semanas — conta sazonal, conta em teste, a "04" que ficou de fora —
-- teria que recadastrar credencial para religar, e é exatamente aí que
-- alguém cola o token errado. Uma coluna guarda a configuração inteira e o
-- religar é um clique.
--
-- ISTO NÃO MUDA A ABA META ADS, E ISSO É DECISÃO
--
-- A tela de Meta ADS continua somando TODAS as contas cadastradas. O toggle
-- nasceu para escolher quem entra no relatório do WhatsApp; deixá-lo mexer
-- também no relatório histórico significaria que desligar uma conta encolhe
-- o denominador do ROI daquela tela — em silêncio, com o número continuando
-- plausível. É o mesmo perigo que o cabeçalho da 058 descreve, e a defesa é
-- a mesma: uma coisa de cada vez, cada uma dizendo o que faz.
--
-- DEFAULT TRUE, E NÃO FALSE
--
-- As contas que já existem estavam sendo lidas. Entrar com `false` faria o
-- primeiro relatório sair vazio, às 10h, sem ninguém entendendo por quê — e
-- "vazio" é indistinguível de "não gastou nada ainda" àquela hora.
--
-- ORDEM DE DEPLOY: esta migration ANTES da Edge Function `ads-campaigns` E
-- ANTES do frontend. Não é preferência, é requisito, e o motivo é o mesmo dos
-- dois lados: a coluna aparece na consulta de quem lê.
--
--   * a função pede `is_active` no select. Sem a coluna, o PostgREST recusa a
--     consulta inteira (42703) — não devolve as outras colunas sem essa. A
--     função checa esse erro e PARA, com a dica apontando para esta migration.
--     Ela para de propósito: sem a checagem, a lista de contas chegaria vazia,
--     o código cairia no fallback de conta única do `meta_ad_account_id`, e o
--     WhatsApp receberia o relatório de UMA conta com cara de ser o das três;
--   * a tela chama `crm_ad_account_save` com `p_active`. Sem a assinatura
--     nova, a RPC não existe e o primeiro clique em Salvar dá erro.
--
-- Aplicada esta migration primeiro, não existe janela nenhuma: a coluna entra
-- com default true, as contas que já estavam sendo lidas continuam sendo, e
-- quem ainda não subiu (função velha, tela velha) simplesmente ignora a coluna
-- nova.
--
-- Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

alter table public.crm_ad_accounts
  add column if not exists is_active boolean not null default true;

comment on column public.crm_ad_accounts.is_active is
  'Entra no relatório automático de campanhas (ads-campaigns). Contas '
  'desligadas continuam cadastradas, com rótulo e token, e continuam '
  'somando na aba Meta ADS.';

-- ------------------------------------------------------------
-- LISTA — agora com is_active
--
-- `create or replace` não muda o tipo de retorno de uma função que devolve
-- table: o Postgres recusa com "cannot change return type". Por isso o drop
-- explícito, e não por gosto de recriar.
-- ------------------------------------------------------------
drop function if exists public.crm_ad_accounts_list();

create or replace function public.crm_ad_accounts_list()
returns table(
  id         uuid,
  account_id text,
  label      text,
  has_token  boolean,
  sort_order int,
  is_active  boolean
)
language sql stable security definer set search_path = public as $$
  select a.id, a.account_id, a.label,
         coalesce(a.access_token, '') <> '',
         a.sort_order,
         a.is_active
  from public.crm_ad_accounts a
  where a.organization_id = public.current_org_id()
  order by a.sort_order, a.created_at;
$$;

-- ------------------------------------------------------------
-- ESPELHO EM crm_settings — a conta desligada perde a vez
--
-- meta_ad_account_id aponta para a "primeira" conta e é o fallback de quem
-- lê a configuração antiga (ver 058). Apontar para uma conta que a operação
-- acabou de desligar seria ressuscitá-la pela porta dos fundos, então conta
-- ativa vem primeiro na ordenação. Desligou TODAS? O espelho volta a apontar
-- para a primeira da lista, porque um espelho nulo significa "nenhuma conta
-- cadastrada", que é outra coisa.
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
  order by a.is_active desc, a.sort_order, a.created_at
  limit 1;

  update public.crm_settings
     set meta_ad_account_id = v_first, updated_at = now()
   where organization_id = p_org;
end;
$$;

-- ------------------------------------------------------------
-- GRAVAR — com p_active
--
-- O drop é obrigatório: `create or replace` com uma assinatura diferente
-- CRIA UMA SOBRECARGA em vez de substituir, e aí a chamada da tela (que passa
-- os argumentos por nome) fica ambígua e falha em runtime — um erro que só
-- aparece no primeiro save depois do deploy.
--
-- p_active nulo = não mexe, a mesma regra do token e pelo mesmo motivo: o
-- formulário de edição não manda o campo quando não é ele que está sendo
-- alterado, e "ausente" não pode significar "desligue".
-- ------------------------------------------------------------
drop function if exists public.crm_ad_account_save(uuid, text, text, text);

create or replace function public.crm_ad_account_save(
  p_id      uuid default null,
  p_account text default null,
  p_label   text default null,
  p_token   text default null,
  p_active  boolean default null
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
      organization_id, account_id, label, access_token, sort_order, is_active
    )
    values (
      v_org, v_account, nullif(btrim(coalesce(p_label, '')), ''), nullif(p_token, ''),
      coalesce(
        (select max(a.sort_order) + 1 from public.crm_ad_accounts a
          where a.organization_id = v_org),
        0
      ),
      -- Conta nova nasce ativa: quem acabou de cadastrar quer vê-la no
      -- relatório, senão não teria cadastrado.
      coalesce(p_active, true)
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
           is_active    = coalesce(p_active, a.is_active),
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

comment on function public.crm_ad_account_save(uuid, text, text, text, boolean) is
  'Insere ou edita uma conta de anúncios da org. Token e is_active nulos '
  'mantêm o que está salvo; token vazio apaga — a tela nunca recebe o token '
  'de volta.';
