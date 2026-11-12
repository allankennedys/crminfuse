-- ============================================================
-- Tarefas: a venda vai para o quadro do vendedor
--
-- Até a 093, toda venda virava cartão no espaço padrão (The Witchers).
-- Decisão da operação em 14/09/2026: venda do Pedro vai para o The Boys, a
-- do Paulo para o The Witchers.
--
-- O dono da venda é o canal do cadastro dela (080/089). Qual canal vai para
-- qual quadro NÃO mora aqui: é a tabela task_canal_quadro, e a escolha é
-- task_quadro_da_venda() — as duas na t18 do repo de tarefas. Este arquivo
-- só troca "o espaço padrão" por essa função. Sem regra que case, o
-- resultado é o espaço padrão, igual a antes.
--
-- Todo o resto da 093 fica como estava: after insert, à prova de exceção,
-- lock_timeout de 2s, falha vira linha em task_integration_errors.
--
-- APLICAR DEPOIS da t18. Se aplicar antes, não quebra a venda: a guarda de
-- to_regprocedure faz o gatilho seguir com o espaço padrão.
--
-- Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

create or replace function public.task_card_da_venda()
returns trigger
language plpgsql security definer
  set search_path = public
  set lock_timeout = '2s' as $$
declare
  v_card  uuid;
  v_board uuid;
begin
  if to_regclass('public.task_cards') is null
     or to_regclass('public.task_integration_errors') is null then
    return null;
  end if;

  if to_regprocedure('public.task_quadro_da_venda(uuid, uuid)') is not null then
    v_board := public.task_quadro_da_venda(new.organization_id, new.contact_id);
  else
    select b.id into v_board from public.task_boards b
     where b.organization_id = new.organization_id and b.is_default and not b.arquivado
     limit 1;
  end if;

  -- Na coluna de entrada (is_inbox) do quadro escolhido. A posição no topo é
  -- do gatilho de insert em task_cards (t18).
  insert into public.task_cards
         (organization_id, board_id, list_id, titulo, contact_id, sale_id, created_by)
  select new.organization_id, b.id, l.id,
         coalesce(ct.name, 'Cliente sem nome') ||
           case when new.creatives > 0
                then ' · ' || new.creatives || ' criativo' ||
                     case when new.creatives > 1 then 's' else '' end
                else '' end ||
           ' · ' || to_char(coalesce(new.sold_at, now()), 'DD/MM'),
         new.contact_id, new.id, new.created_by
    from public.task_boards b
    join public.task_lists  l  on l.board_id = b.id and l.is_inbox and not l.arquivada
    join public.crm_contacts ct on ct.id = new.contact_id
   where b.id = v_board
   limit 1
  returning id into v_card;

  if v_card is null then
    insert into public.task_integration_errors (origem, referencia, erro, detalhe)
    values ('crm_sales.venda', new.id,
            'Nenhum quadro com coluna de entrada (is_inbox) para esta venda',
            jsonb_build_object('organization_id', new.organization_id, 'board_id', v_board));
    return null;
  end if;

  return null;

exception when others then
  begin
    insert into public.task_integration_errors (origem, referencia, erro, detalhe)
    values ('crm_sales.venda', new.id, sqlerrm,
            jsonb_build_object('contact_id', new.contact_id, 'card_id', v_card, 'board_id', v_board));
  exception when others then
    raise warning 'tarefas: falha ao registrar falha da venda %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

comment on function public.task_card_da_venda() is
  'Cria o cartão de produção a cada venda, no quadro do vendedor '
  '(task_quadro_da_venda, t18). À prova de exceção.';

-- O gatilho da 093 já aponta para esta função pelo nome; nada a recriar.
