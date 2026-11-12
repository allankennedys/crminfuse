-- ============================================================
-- CRM: cards do kanban ordenados por entrada na etapa
--
-- Antes os cards de cada coluna vinham por (position, created_at desc) —
-- ou seja, ordem de cadastro, com a `position` manual na frente. Só que
-- arrastar card NUNCA reordenou dentro da coluna (o drag só troca de
-- etapa), então a `position` virou um resquício sem uso real.
--
-- A regra pedida é "quem entrou na etapa por último fica no topo": quem
-- foi movido para a coluna mais recentemente aparece primeiro. Isso é
-- exatamente stage_changed_at, que o trigger crm_touch_stage_changed já
-- carimba a cada mudança de etapa (013). Comprar = entrar na etapa de
-- conversão, então o último a comprar sobe para o topo de "Ganho".
--
-- created_at desc + id são desempates DETERMINÍSTICOS: sem eles, uma
-- importação em massa (vários stage_changed_at idênticos) daria uma ordem
-- instável entre a 1ª página (crm_board) e o "carregar mais"
-- (listStageContacts), que paginam por offset e PRECISAM concordar na
-- ordenação, senão o offset pula ou repete cards.
-- ============================================================

-- O índice do board acompanhava a ordem antiga (position, created_at).
-- Recriado na nova ordem para o kanban continuar sem sort em disco.
drop index if exists public.idx_crm_contacts_board;
create index idx_crm_contacts_board
  on public.crm_contacts(organization_id, stage_id, stage_changed_at desc, created_at desc)
  where stage_id is not null;

-- Mesma assinatura de 014 (int, text): create or replace substitui no lugar,
-- sem criar sobrecarga. Muda só o ORDER BY da window.
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
             order by c.stage_changed_at desc, c.created_at desc, c.id
           ) as rn
    from public.crm_contacts c
    where c.organization_id = public.current_org_id()
      and c.stage_id is not null
      and (p_channel is null or c.channel = p_channel)
  ) r
  where r.rn <= greatest(p_per_stage, 1);
$$;
