-- ============================================================
-- Tarefas: o quadro Head - Kevin foi excluído; TODA venda vai para o Head - Gustavo
--
-- Substitui o corpo da 110. Antes: canal com "pedro" -> Head - Kevin, resto ->
-- Head - Gustavo. Agora: qualquer canal -> Head - Gustavo, com o Gustavo
-- (gusttah.borges@gmail.com) como responsável. O resto é igual à 110
-- (primeira coluna do quadro, título "Cliente · N criativos", à prova de exceção).
--
-- Sem esta migration, a venda do Pedro NÃO cria cartão (a 110 procura o quadro
-- "Head - Kevin" pelo nome, não acha e só registra erro).
--
-- Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

create or replace function public.task_card_da_venda()
returns trigger
language plpgsql security definer
  set search_path = public
  set lock_timeout = '2s' as $$
declare
  c_quadro_gustavo constant text := 'Head - Gustavo';
  c_nome_gustavo constant text := 'gustavo';

  v_quadro text;
  v_nome   text;
  v_card   uuid;
  v_board  uuid;
  v_list   uuid;
  v_head   uuid;
  v_qtd    int;
begin
  if to_regclass('public.task_cards') is null
     or to_regclass('public.task_integration_errors') is null then
    return null;
  end if;

  -- Toda venda, de qualquer canal (inclusive "pedro"), vai para o Head - Gustavo.
  v_quadro := c_quadro_gustavo;  v_nome := c_nome_gustavo;

  select count(*), min(b.id::text)::uuid into v_qtd, v_board
    from public.task_boards b
   where b.organization_id = new.organization_id
     and not b.arquivado
     and regexp_replace(lower(v_quadro), '[^[:alnum:]]', '', 'g') in (
           regexp_replace(lower(b.nome), '[^[:alnum:]]', '', 'g'),
           regexp_replace(lower(coalesce(b.titulo, '')), '[^[:alnum:]]', '', 'g'));

  if v_qtd <> 1 then
    insert into public.task_integration_errors (origem, referencia, erro, detalhe)
    values ('crm_sales.venda', new.id,
            case when v_qtd = 0 then 'Quadro não encontrado: ' || v_quadro
                 else 'Mais de um quadro com o nome: ' || v_quadro end,
            jsonb_build_object('organization_id', new.organization_id));
    return null;
  end if;

  -- Primeira coluna: a de entrada, senão a de menor posição.
  select l.id into v_list
    from public.task_lists l
   where l.board_id = v_board and not l.arquivada
   order by l.is_inbox desc, l.position
   limit 1;

  insert into public.task_cards
         (organization_id, board_id, list_id, titulo, contact_id, sale_id, created_by)
  select new.organization_id, v_board, v_list,
         coalesce(ct.name, 'Cliente sem nome') ||
           case when new.creatives > 0
                then ' · ' || new.creatives || ' criativo' ||
                     case when new.creatives > 1 then 's' else '' end
                else '' end,
         new.contact_id, new.id, new.created_by
    from public.crm_contacts ct
   where ct.id = new.contact_id
     and v_list is not null
  returning id into v_card;

  if v_card is null then
    insert into public.task_integration_errors (origem, referencia, erro, detalhe)
    values ('crm_sales.venda', new.id,
            'Cartão não criado: quadro sem coluna ou venda sem contato',
            jsonb_build_object('board_id', v_board, 'list_id', v_list, 'contact_id', new.contact_id));
    return null;
  end if;

  -- O head vira responsável. Falha aqui não desfaz o cartão.
  select count(*), min(u.id::text)::uuid into v_qtd, v_head
    from public.users u
   where u.organization_id = new.organization_id
     and u.is_active
     and (case when v_nome = 'gustavo' then lower(u.email) = 'gusttah.borges@gmail.com'
            else regexp_replace(lower(coalesce(u.full_name, '')), '[^[:alnum:]]', '', 'g') like v_nome || '%' end);

  if v_qtd = 1 then
    insert into public.task_card_members (card_id, user_id, organization_id)
    values (v_card, v_head, new.organization_id)
    on conflict do nothing;
  else
    insert into public.task_integration_errors (origem, referencia, erro, detalhe)
    values ('crm_sales.venda', new.id,
            'Head não encontrado (ou mais de um): ' || v_nome || ' (cartão criado sem membro)',
            jsonb_build_object('card_id', v_card, 'board_id', v_board, 'achados', v_qtd));
  end if;

  return null;

exception when others then
  -- A VENDA JÁ ESTÁ GRAVADA. Falha aqui vira log, nunca rollback (093).
  begin
    insert into public.task_integration_errors (origem, referencia, erro, detalhe)
    values ('crm_sales.venda', new.id, sqlerrm,
            jsonb_build_object('contact_id', new.contact_id, 'card_id', v_card,
                               'board_id', v_board, 'list_id', v_list));
  exception when others then
    raise warning 'tarefas: falha ao registrar falha da venda %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

comment on function public.task_card_da_venda() is
  'Cria o cartão de cada venda no quadro "Head - Gustavo", com o Gustavo como '
  'membro, qualquer que seja o canal (112). À prova de exceção.';

drop trigger if exists trg_crm_sales_venda on public.crm_sales;
create trigger trg_crm_sales_venda
  after insert on public.crm_sales
  for each row execute function public.task_card_da_venda();
