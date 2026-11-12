-- ============================================================
-- Automação de etapas: lead parado tempo demais muda de coluna sozinho
--
-- Regras pedidas:
--   • Novo lead ou Orçamento Enviado parados há mais de 24h → Remarketing
--   • Remarketing parado há 30 dias sem movimentação        → Perdido
--
-- POR QUE UMA TABELA DE REGRAS, E NÃO OS NOMES NO CÓDIGO
--
-- As etapas são criadas por organização, com nome livre e editável na tela.
-- SQL comparando 'Orçamento Enviado' quebraria calado no dia em que alguém
-- renomeasse a coluna ou tirasse o acento. Aqui a regra guarda o UUID da
-- etapa: renomear não afeta, e apagar a etapa leva a regra junto (cascade).
-- De quebra, mudar prazo ou destino vira um UPDATE, não uma migration.
--
-- O QUE CONTA COMO "SEM MOVIMENTAÇÃO"
--
-- stage_changed_at: o instante em que o contato entrou na etapa atual,
-- carimbado pelo trigger crm_touch_stage_changed (013). É o mesmo relógio do
-- selo "Nd sem contato" no card e do arquivamento de convertidos (030) —
-- então a tela e a automação nunca discordam sobre há quanto tempo o lead
-- está parado. Mensagem trocada sem mudar de etapa NÃO reseta esse relógio:
-- se um dia a régua tiver de ser "última interação", o campo a criar é outro.
--
-- POR QUE NÃO HÁ EFEITO CASCATA NUMA MESMA EXECUÇÃO
--
-- Mover o contato dispara o trigger que grava stage_changed_at = now(), e
-- now() é constante dentro da transação. Um lead que acabou de cair em
-- Remarketing tem stage_changed_at = now(), então falha em
-- `stage_changed_at < now() - 30 dias` e não segue para Perdido no mesmo
-- ciclo. A ordem em que as regras rodam não importa por isso.
--
-- A PRIMEIRA EXECUÇÃO MEXE NA BASE INTEIRA
--
-- Todo lead que já está parado além do prazo muda de etapa no primeiro
-- disparo — não só os que vencerem daqui em diante. O SELECT no fim deste
-- arquivo mostra quantos contatos cada regra vai mover, ANTES de o cron
-- rodar pela primeira vez. Se o número assustar, desligue e pense:
--
--   update public.crm_stage_automations set enabled = false;
-- ============================================================

-- Esta migration reescreve crm_track_stage_change() em cima da versão da 033.
-- Se a 033 não estiver aplicada, parar aqui é melhor que gravar um trigger
-- que chama uma função inexistente e derruba toda mudança de etapa.
do $$
begin
  if to_regprocedure('public.crm_enqueue_conversion(uuid, text)') is null then
    raise exception 'Aplique a migration 033 antes desta: crm_enqueue_conversion() não existe';
  end if;
end $$;

-- ------------------------------------------------------------
-- As regras
-- ------------------------------------------------------------
create table if not exists public.crm_stage_automations (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  from_stage_id uuid not null references public.crm_stages(id) on delete cascade,
  to_stage_id   uuid not null references public.crm_stages(id) on delete cascade,
  -- Quanto tempo parado na etapa de origem antes de mover.
  after_interval interval not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  -- Regra que aponta para a própria etapa seria um laço que nunca termina.
  constraint crm_automation_sem_laco check (from_stage_id <> to_stage_id),
  constraint crm_automation_prazo_positivo check (after_interval > interval '0')
);

-- Uma regra por etapa de origem: com duas, o destino do contato dependeria
-- da ordem do loop — resultado diferente a cada execução, sem ninguém
-- entender por quê.
create unique index if not exists idx_crm_automation_from
  on public.crm_stage_automations(from_stage_id);

comment on table public.crm_stage_automations is
  'Move contatos parados: quem está em from_stage_id há mais de '
  'after_interval vai para to_stage_id. Aplicada de hora em hora pelo '
  'pg_cron via crm_apply_stage_automations().';

alter table public.crm_stage_automations enable row level security;

drop policy if exists crm_automations_select on public.crm_stage_automations;
drop policy if exists crm_automations_write  on public.crm_stage_automations;

create policy crm_automations_select on public.crm_stage_automations
  for select using (organization_id = public.current_org_id());
create policy crm_automations_write on public.crm_stage_automations
  for all using (
    organization_id = public.current_org_id()
    and public.current_user_role() in ('admin','operator')
  )
  with check (organization_id = public.current_org_id());

-- ------------------------------------------------------------
-- Movimentação automática vira source = 'system' no histórico
--
-- Sem isto o painel do contato mostraria "por automação" (o rótulo de 'api'):
-- o trigger só sabe que não há usuário logado, e quem chama pelo cron não
-- tem sessão. A flag é local à transação — pg_cron roda cada job na sua —,
-- então nenhuma outra escrita herda a marca.
--
-- Corpo idêntico ao da 033, exceto a linha do v_source.
-- ------------------------------------------------------------
create or replace function public.crm_track_stage_change()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_source text;
  v_converts boolean;
  v_was_conversion boolean;
begin
  if tg_op = 'UPDATE' and old.stage_id is not distinct from new.stage_id then
    return null;
  end if;

  if tg_op = 'INSERT' and new.stage_id is null then
    return null;
  end if;

  v_source := case
    when coalesce(current_setting('crm.automation', true), '') = 'on' then 'system'
    when auth.uid() is null then 'api'
    else 'ui'
  end;

  -- Histórico de TODA movimentação, inclusive de quem não veio de anúncio:
  -- é dele que os relatórios de conversão saem (crm_has_converted, 016).
  insert into public.crm_stage_history (
    organization_id, contact_id, from_stage_id, to_stage_id, source, changed_by
  ) values (
    new.organization_id,
    new.id,
    case when tg_op = 'UPDATE' then old.stage_id else null end,
    new.stage_id,
    v_source,
    auth.uid()
  );

  select is_conversion into v_converts
  from public.crm_stages where id = new.stage_id;

  if tg_op = 'UPDATE' then
    select is_conversion into v_was_conversion
    from public.crm_stages where id = old.stage_id;
  else
    v_was_conversion := false;
  end if;

  -- Entrada REAL na etapa de conversão (vindo de etapa que não convertia).
  if coalesce(v_converts, false) and not coalesce(v_was_conversion, false) then
    perform public.crm_enqueue_conversion(new.id, v_source);
  end if;

  return null;
end;
$$;

-- ------------------------------------------------------------
-- Aplica todas as regras de todas as organizações
--
-- Devolve quantos contatos moveu — o pg_cron guarda o retorno em
-- cron.job_run_details, então dá para auditar depois o que cada execução fez.
-- ------------------------------------------------------------
create or replace function public.crm_apply_stage_automations()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_count integer;
  v_total integer := 0;
begin
  -- Roda para TODAS as organizações: é chamada pelo cron, fora de sessão de
  -- usuário, então não filtra por current_org_id().
  perform set_config('crm.automation', 'on', true);

  for r in
    select a.from_stage_id, a.to_stage_id, a.after_interval
    from public.crm_stage_automations a
    join public.crm_stages destino on destino.id = a.to_stage_id
    where a.enabled
      -- Etapa de conversão nunca é destino automático: entrar nela enfileira
      -- compra na Meta (033), e venda não se declara por decurso de prazo.
      and not destino.is_conversion
  loop
    update public.crm_contacts c
    set stage_id = r.to_stage_id
    where c.stage_id = r.from_stage_id
      and c.stage_changed_at < now() - r.after_interval;

    get diagnostics v_count = row_count;
    v_total := v_total + v_count;
  end loop;

  return v_total;
end;
$$;

-- Roda para TODAS as organizações: não é função de usuário. Sem o revoke,
-- qualquer sessão autenticada poderia adiantar o ciclo do sistema inteiro.
revoke all on function public.crm_apply_stage_automations() from public;

comment on function public.crm_apply_stage_automations() is
  'Move os contatos parados além do prazo de cada regra de '
  'crm_stage_automations. Devolve quantos moveu.';

-- ------------------------------------------------------------
-- O que o kanban lê para avisar na coluna
--
-- Card sumindo da coluna sem explicação parece bug. A tela mostra "→ Perdido
-- em 30d" no cabeçalho da etapa, e para isso precisa do prazo como número:
-- interval chega ao PostgREST como texto ('30 days', '24:00:00') e formatar
-- isso no navegador é convite a erro.
-- ------------------------------------------------------------
create or replace function public.crm_stage_automations_list()
returns table(
  from_stage_id uuid,
  to_stage_id   uuid,
  to_stage_name text,
  hours         integer
)
language sql stable security definer set search_path = public as $$
  select a.from_stage_id,
         a.to_stage_id,
         destino.name,
         round(extract(epoch from a.after_interval) / 3600)::integer
  from public.crm_stage_automations a
  join public.crm_stages destino on destino.id = a.to_stage_id
  where a.organization_id = public.current_org_id()
    and a.enabled;
$$;

comment on function public.crm_stage_automations_list() is
  'Regras ativas da organização, com o prazo em horas — alimenta o aviso '
  '"→ etapa em Xh" no cabeçalho das colunas do funil.';

-- De hora em hora, no minuto 5: fora do :00 e do :30, onde já roda o worker
-- de eventos (043). Um lead vence 24h e muda de coluna em até uma hora — a
-- precisão que a regra pede.
select cron.unschedule(jobid)
from cron.job
where jobname = 'ph-groups-crm-stage-automations';

select cron.schedule(
  'ph-groups-crm-stage-automations',
  '5 * * * *',
  $$ select public.crm_apply_stage_automations(); $$
);

-- ------------------------------------------------------------
-- As três regras pedidas, resolvidas pelo NOME da etapa em cada organização
--
-- Comparação sem acento e sem caixa (mesmo tratamento do relatório por
-- origem, 025): "Orçamento Enviado", "orcamento enviado" e "ORÇAMENTO
-- ENVIADO" casam igual. Organização que não tiver as etapas com esses nomes
-- simplesmente não ganha regra — e o SELECT no fim deixa isso visível.
-- ------------------------------------------------------------
with pares as (
  select * from (values
    ('novo lead',         'remarketing', interval '24 hours'),
    ('orcamento enviado', 'remarketing', interval '24 hours'),
    ('remarketing',       'perdido',     interval '30 days')
  ) as t(de, para, prazo)
)
insert into public.crm_stage_automations (organization_id, from_stage_id, to_stage_id, after_interval)
select origem.organization_id, origem.id, destino.id, p.prazo
from pares p
join public.crm_stages origem
  on lower(extensions.unaccent(btrim(origem.name))) = p.de
join public.crm_stages destino
  on destino.organization_id = origem.organization_id
 and lower(extensions.unaccent(btrim(destino.name))) = p.para
on conflict (from_stage_id) do nothing;

-- ------------------------------------------------------------
-- CONFIRA ANTES DO PRIMEIRO DISPARO
--
-- Uma linha por regra criada, com quantos contatos já estão vencidos — ou
-- seja, quantos mudam de coluna no primeiro ciclo. Nenhuma linha = os nomes
-- das etapas não bateram e nada foi automatizado.
-- ------------------------------------------------------------
select
  origem.name  as de,
  destino.name as para,
  a.after_interval as prazo,
  a.enabled,
  (select count(*)
     from public.crm_contacts c
    where c.stage_id = a.from_stage_id
      and c.stage_changed_at < now() - a.after_interval) as move_no_1o_ciclo
from public.crm_stage_automations a
join public.crm_stages origem  on origem.id = a.from_stage_id
join public.crm_stages destino on destino.id = a.to_stage_id
order by a.after_interval;
