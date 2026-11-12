-- ============================================================
-- Campanhas fora do relatório de Meta ADS
--
-- A conta de anúncios não veicula só aquisição. Campanha de RECRUTAMENTO
-- roda na mesma conta, gasta do mesmo cartão e não produz um único lead no
-- CRM — e o relatório contava esse gasto contra a receita de vendas. O
-- efeito é o oposto do que se costuma temer numa exclusão: o ROI mostrado
-- estava MENOR que o real, porque o denominador carregava despesa de outra
-- área.
--
-- POR QUE ISSO É CONFIGURAÇÃO DA ORGANIZAÇÃO, E NÃO UM FILTRO DA TELA
--
-- Se cada pessoa pudesse ligar e desligar no próprio navegador, duas
-- pessoas abririam o mesmo relatório, no mesmo período, e leriam ROIs
-- diferentes — sem nada na tela explicando a divergência. "Quanto rendeu a
-- mídia" precisa ter UMA resposta por organização. Por isso mora no banco,
-- é escrita só por admin (mesma regra das credenciais da Meta, 054) e a
-- tela anuncia em cima o que está fora.
--
-- QUANDO EXCLUIR É HONESTO
--
-- Só quando a campanha NÃO gera lead no CRM: recrutamento, institucional,
-- outra linha de produto. Se ela traz lead, as vendas dele continuam no
-- caixa e tirar só o custo infla o retorno — é exatamente o erro que a
-- seleção parcial de contas (058) evita escondendo o ROI. A diferença aqui
-- é que a receita da campanha excluída é comprovadamente zero, então tirar
-- os dois lados aproxima o número da verdade em vez de afastá-lo.
--
-- O NOME FICA GRAVADO JUNTO
--
-- campaign_name é redundante com a Meta e está aqui de propósito: campanha
-- pausada há três meses não aparece mais na janela consultada, e sem o nome
-- salvo a tela listaria "campanha 23851..." sem dizer o que é. O id é a
-- chave; o nome é para humano ler.
-- ============================================================

create table if not exists public.crm_ad_excluded_campaigns (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Id da campanha na Meta. Único no mundo, não só na conta — por isso o
  -- filtro não precisa saber de qual conta ela veio.
  campaign_id text not null,
  campaign_name text,
  -- Só para exibição: de qual conta ela era quando foi excluída.
  account_id text,
  -- "Recrutamento", "institucional". O motivo importa: daqui a um ano
  -- ninguém lembra por que aquele id está na lista.
  note text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, campaign_id)
);

create index if not exists idx_crm_excluded_campaigns_org
  on public.crm_ad_excluded_campaigns(organization_id);

comment on table public.crm_ad_excluded_campaigns is
  'Campanhas cujo gasto NÃO entra no relatório de Meta ADS — recrutamento e '
  'afins, que não geram lead no CRM. Configuração da org, não filtro de tela: '
  'todo mundo tem que ler o mesmo ROI.';

-- ------------------------------------------------------------
-- RLS
--
-- Diferente de crm_settings e crm_ad_accounts, aqui não há segredo nenhum:
-- é uma lista de ids de campanha. Leitura direta pela tela, escrita só por
-- RPC — o que a RPC protege é a REGRA (só admin), não o dado.
-- ------------------------------------------------------------
alter table public.crm_ad_excluded_campaigns enable row level security;

create policy crm_excluded_campaigns_select on public.crm_ad_excluded_campaigns
  for select using (organization_id = public.current_org_id());

-- ------------------------------------------------------------
-- EXCLUIR / VOLTAR A INCLUIR
--
-- Reexcluir a mesma campanha não é erro: a tela pode ficar aberta em duas
-- abas, e o segundo clique deve terminar no mesmo estado do primeiro. O
-- nome e a nota, porém, são atualizados — a campanha pode ter sido
-- renomeada na Meta desde então.
-- ------------------------------------------------------------
create or replace function public.crm_campaign_exclude(
  p_campaign_id   text,
  p_campaign_name text default null,
  p_account_id    text default null,
  p_note          text default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := public.current_org_id();
begin
  if public.current_user_role() <> 'admin' then
    raise exception 'Apenas administradores podem tirar campanhas do relatório';
  end if;

  if coalesce(btrim(p_campaign_id), '') = '' then
    raise exception 'Informe a campanha';
  end if;

  insert into public.crm_ad_excluded_campaigns (
    organization_id, campaign_id, campaign_name, account_id, note, created_by
  )
  values (
    v_org, btrim(p_campaign_id),
    nullif(btrim(coalesce(p_campaign_name, '')), ''),
    nullif(btrim(coalesce(p_account_id, '')), ''),
    nullif(btrim(coalesce(p_note, '')), ''),
    auth.uid()
  )
  on conflict (organization_id, campaign_id) do update set
    campaign_name = coalesce(
      nullif(btrim(coalesce(excluded.campaign_name, '')), ''),
      crm_ad_excluded_campaigns.campaign_name
    ),
    account_id = coalesce(excluded.account_id, crm_ad_excluded_campaigns.account_id),
    note = coalesce(excluded.note, crm_ad_excluded_campaigns.note);
end;
$$;

create or replace function public.crm_campaign_include(p_campaign_id text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.current_user_role() <> 'admin' then
    raise exception 'Apenas administradores podem alterar o relatório';
  end if;

  delete from public.crm_ad_excluded_campaigns c
   where c.organization_id = public.current_org_id()
     and c.campaign_id = btrim(p_campaign_id);
end;
$$;

comment on function public.crm_campaign_exclude(text, text, text, text) is
  'Tira uma campanha dos totais de Meta ADS. Use só em campanha que não gera '
  'lead no CRM (recrutamento, institucional) — tirar o custo de campanha que '
  'traz lead infla o ROI, porque a receita dela continua no caixa.';
