-- ============================================================
-- Tarefas: o quadro agora se chama só "HEAD"; a venda cai em "Aguardando inf cliente"
--
-- Substitui o corpo da 112. Mudanças:
--   1. quadro procurado: "HEAD" (antes "Head - Gustavo"). Sem esta migration a
--      venda não cria cartão: a 112 não acha "Head - Gustavo" e só registra erro;
--   2. coluna de destino: a que se chama "Aguardando inf cliente" (comparada sem
--      caixa/acento de pontuação; aceita "Aguardando informações do cliente" etc.,
--      isto é, qualquer título que comece com "aguardandoinf"). Se não existir,
--      cai na primeira coluna (entrada, senão menor posição) e registra aviso em
--      task_integration_errors, sem perder o cartão;
--   3. o Gustavo (gusttah.borges@gmail.com) continua como responsável;
--   4. RECUPERA as vendas do período em que o quadro tinha outro nome: toda
--      venda que a 112 não conseguiu virar cartão ("Quadro não encontrado" em
--      task_integration_errors, ainda não resolvida) ganha o cartão agora, na
--      mesma coluna e com o mesmo responsável. Só vale para venda sem cartão
--      ativo; rodar de novo não duplica nada, pois a falha é marcada como
--      resolvida. Vendas que nunca tiveram cartão por outro motivo (ex.: o
--      período da 098) NÃO entram: só as que deixaram o erro registrado.
--
-- Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

create or replace function public.task_card_da_venda()
returns trigger
language plpgsql security definer
  set search_path = public
  set lock_timeout = '2s' as $$
declare
  c_quadro_gustavo constant text := 'HEAD';
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

  -- Coluna "Aguardando inf cliente" (pelo nome); se não houver, a primeira.
  select l.id into v_list
    from public.task_lists l
   where l.board_id = v_board and not l.arquivada and l.exclusivo_de is null
     and regexp_replace(lower(l.titulo), '[^[:alnum:]]', '', 'g') like 'aguardandoinf%'
   order by l.position
   limit 1;

  if v_list is null then
    select l.id into v_list
      from public.task_lists l
     where l.board_id = v_board and not l.arquivada
     order by l.is_inbox desc, l.position
     limit 1;
    insert into public.task_integration_errors (origem, referencia, erro, detalhe)
    values ('crm_sales.venda', new.id,
            'Coluna "Aguardando inf cliente" não encontrada: cartão foi para a primeira coluna',
            jsonb_build_object('board_id', v_board, 'list_id', v_list));
  end if;

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
  'Cria o cartão de cada venda no quadro "HEAD", coluna "Aguardando inf cliente", '
  'com o Gustavo como membro, qualquer que seja o canal (113). À prova de exceção.';

drop trigger if exists trg_crm_sales_venda on public.crm_sales;
create trigger trg_crm_sales_venda
  after insert on public.crm_sales
  for each row execute function public.task_card_da_venda();

-- ------------------------------------------------------------
-- Recuperação das vendas sem cartão (quadro com nome antigo)
-- ------------------------------------------------------------
do $$
declare
  r         record;
  v_board   uuid;
  v_list    uuid;
  v_head    uuid;
  v_card    uuid;
  v_qtd     int;
  v_criados int := 0;
  v_pulados int := 0;
begin
  for r in
    select s.id, s.organization_id, s.contact_id, s.creatives, s.sold_at,
           s.created_by, ct.name as cliente
      from public.crm_sales s
      join public.crm_contacts ct on ct.id = s.contact_id
     where s.id in (
             select e.referencia
               from public.task_integration_errors e
              where e.origem = 'crm_sales.venda'
                and not e.resolvido
                and e.erro like 'Quadro não encontrado:%')
     order by s.created_at          -- do mais antigo ao mais novo: o novo fica no topo
  loop
    if exists (select 1 from public.task_cards c
                where c.sale_id = r.id and not c.arquivado) then
      v_pulados := v_pulados + 1;
      continue;
    end if;

    select count(*), min(b.id::text)::uuid into v_qtd, v_board
      from public.task_boards b
     where b.organization_id = r.organization_id and not b.arquivado
       and 'head' in (regexp_replace(lower(b.nome), '[^[:alnum:]]', '', 'g'),
                      regexp_replace(lower(coalesce(b.titulo, '')), '[^[:alnum:]]', '', 'g'));
    if v_qtd <> 1 then
      raise exception 'Quadro "HEAD": achei % (precisa ser 1). Nada foi gravado.', v_qtd;
    end if;

    select l.id into v_list
      from public.task_lists l
     where l.board_id = v_board and not l.arquivada and l.exclusivo_de is null
       and regexp_replace(lower(l.titulo), '[^[:alnum:]]', '', 'g') like 'aguardandoinf%'
     order by l.position
     limit 1;
    if v_list is null then
      select l.id into v_list
        from public.task_lists l
       where l.board_id = v_board and not l.arquivada
       order by l.is_inbox desc, l.position
       limit 1;
    end if;
    if v_list is null then
      raise exception 'Quadro "HEAD" sem coluna. Nada foi gravado.';
    end if;

    select count(*), min(u.id::text)::uuid into v_qtd, v_head
      from public.users u
     where u.organization_id = r.organization_id and u.is_active
       and lower(u.email) = 'gusttah.borges@gmail.com';

    insert into public.task_cards
           (organization_id, board_id, list_id, titulo, contact_id, sale_id, created_by)
    values (r.organization_id, v_board, v_list,
            coalesce(r.cliente, 'Cliente sem nome') ||
              case when r.creatives > 0
                   then ' · ' || r.creatives || ' criativo' ||
                        case when r.creatives > 1 then 's' else '' end
                   else '' end,
            r.contact_id, r.id, r.created_by)
    returning id into v_card;

    if v_qtd = 1 then
      insert into public.task_card_members (card_id, user_id, organization_id)
      values (v_card, v_head, r.organization_id)
      on conflict do nothing;
    end if;

    update public.task_integration_errors e
       set resolvido = true
     where e.origem = 'crm_sales.venda' and e.referencia = r.id
       and not e.resolvido and e.erro like 'Quadro não encontrado:%';

    v_criados := v_criados + 1;
    raise notice 'CRIADO: venda % — %', r.id, r.cliente;
  end loop;

  raise notice 'Recuperação: % cartões criados, % vendas puladas (já tinham cartão).', v_criados, v_pulados;
end;
$$;

-- CONFERIR depois:
--   select count(*) from public.task_integration_errors
--    where origem = 'crm_sales.venda' and not resolvido;
