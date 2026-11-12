-- ============================================================
-- Filtro de período no kanban
--
-- O funil já filtrava por canal; agora filtra também por janela de datas.
-- Recorta pela DATA DE ENTRADA do lead (crm_contacts.created_at), que é o
-- mesmo recorte que a aba Funil dos relatórios chama de "entrada" — assim o
-- número de cards no kanban bate com o card "Leads" do relatório quando as
-- duas telas usam o mesmo período.
--
-- POR QUE created_at E NÃO stage_changed_at
--
-- "Movimentou no período" seria o outro recorte plausível, e é tentador num
-- kanban. Mas a rotina de arquivamento (030) e as automações de etapa (050)
-- mexem em stage_changed_at sozinhas, de madrugada: um filtro por essa data
-- mostraria cards entrando e saindo do funil sem ninguém ter tocado neles.
-- A data de entrada é um fato estável do lead.
--
-- JANELA OPCIONAL, E É ISSO QUE MANTÉM O COMPORTAMENTO ATUAL
--
-- p_from/p_to nulos = sem recorte, exatamente como hoje. A tela nasce em
-- "Todo o período", então quem não mexer no seletor não vê diferença
-- nenhuma. Só uma das pontas também vale ("de 01/07 em diante").
--
-- Fuso: crm_day_start (037), São Paulo, com a janela meio-aberta
-- [00:00 de p_from, 00:00 do dia seguinte a p_to) — a mesma convenção de
-- todos os relatórios, para "hoje" pegar o dia inteiro.
--
-- DROP ANTES DE CREATE, E NÃO É OPCIONAL
--
-- Acrescentar parâmetros com default NÃO substitui a função: aridade
-- diferente é função diferente no Postgres. As versões antigas continuariam
-- vivas e uma chamada com 2 argumentos nomeados casaria com as duas — o
-- PostgREST responde "function is not unique" e o kanban para de carregar.
-- Foi o mesmo problema que a 054 teve que consertar em crm_settings_save.
--
-- Aridades históricas derrubadas aqui:
--   crm_board        → 1 (013), 2 (024)
--   crm_stage_stats  → 0 (013), 1 (014)
-- ============================================================

drop function if exists public.crm_board(int);
drop function if exists public.crm_board(int, text);
drop function if exists public.crm_stage_stats();
drop function if exists public.crm_stage_stats(text);

-- ------------------------------------------------------------
-- Primeira página do kanban: os N primeiros contatos de CADA etapa
-- ------------------------------------------------------------
create function public.crm_board(
  p_per_stage int default 20,
  p_channel text default null,
  p_from date default null,
  p_to date default null
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
             order by c.stage_changed_at desc, c.created_at desc, c.id
           ) as rn
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and c.stage_id is not null
      and (p_channel is null or c.channel = p_channel)
      and (p_from is null or c.created_at >= public.crm_day_start(p_from))
      and (p_to   is null or c.created_at <  public.crm_day_start(p_to + 1))
  ) r
  where r.rn <= greatest(p_per_stage, 1);
$$;

comment on function public.crm_board(int, text, date, date) is
  'Primeira página do kanban por etapa. p_from/p_to recortam pela data de '
  'ENTRADA do lead (created_at), no fuso de São Paulo; nulos = sem recorte.';

-- ------------------------------------------------------------
-- Contagem e soma reais por etapa
--
-- Recebe os MESMOS filtros do board de propósito: com um recorte ativo, o
-- cabeçalho da coluna precisa contar só o que passa nele. Se contasse tudo,
-- a coluna diria "120" mostrando 8 cards.
-- ------------------------------------------------------------
create function public.crm_stage_stats(
  p_channel text default null,
  p_from date default null,
  p_to date default null
)
returns table (stage_id uuid, contact_count bigint, total_value_cents bigint)
language sql stable security definer set search_path = public as $$
  select c.stage_id, count(*), coalesce(sum(c.value_cents), 0)
  from public.crm_contacts c
  where c.organization_id = public.current_org_id()
    and c.stage_id is not null
    and (p_channel is null or c.channel = p_channel)
    and (p_from is null or c.created_at >= public.crm_day_start(p_from))
    and (p_to   is null or c.created_at <  public.crm_day_start(p_to + 1))
  group by c.stage_id;
$$;
