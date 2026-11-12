-- ============================================================
-- Tarefas: cada venda vai para o quadro do head da squad
--
-- Pedido da operação: o quadro único "Heads - Gustavo e Kevin" vira dois,
-- "Head - Gustavo" e "Head - Kevin" (mesmos membros e permissões). A venda
-- do Pedro vai para o do Kevin; a da PH (todo o resto) vai para o do Gustavo.
-- O cartão nasce na primeira coluna do quadro e já com o head como membro
-- (responsável). Substitui o corpo da 106; o gatilho continua o mesmo.
--
-- QUEM É O DONO DA VENDA
--
-- A venda não guarda vendedor: o dono é o canal do cliente
-- (crm_contacts.channel), como na t18 das Tarefas. Canal que contém "pedro"
-- (crm_channel_key, sem caixa nem espaço nas pontas) → Kevin; qualquer outro,
-- ou sem canal → Gustavo.
--
-- QUADRO, COLUNA E HEAD PELO NOME
--
-- Mesma ideia da 106: nomes nas constantes, comparados só por letras e
-- números ("Head – Gustavo" casa com "head - gustavo"). O head é a pessoa
-- ativa da organização cujo full_name começa com o nome dele; se não achar
-- exatamente uma, o cartão é criado sem membro e a falha é registrada.
--
--   • quadro não encontrado (ou mais de um): não cria o cartão e registra;
--   • coluna "primeira" = a de entrada (is_inbox), senão a de menor posição,
--     ignorando as arquivadas. Não há nome de coluna para quebrar.
--
-- Atenção: a 106 criava na coluna "AGUARDANDO INF CLIENTE". Agora é a
-- PRIMEIRA coluna do quadro, como pedido. Se a primeira dos novos quadros
-- não for essa, o cartão cai onde está a primeira.
--
-- Todo o resto continua: after insert, à prova de exceção, lock_timeout de
-- 2s, título "Cliente · N criativos" (sem data), topo da coluna (t18).
-- task_quadro_da_venda NÃO sai: Compras e Relatórios ainda a usam.
--
-- DESLIGAR: drop trigger if exists trg_crm_sales_venda on public.crm_sales;
--
-- Aplicar pelo SQL Editor, depois de criar os dois quadros e tirar o antigo
-- (ou arquivá-lo). Nunca por db push.
-- ============================================================

create or replace function public.task_card_da_venda()
returns trigger
language plpgsql security definer
  set search_path = public
  set lock_timeout = '2s' as $$
declare
  c_termo_kevin constant text := 'pedro';
  c_quadro_kevin constant text := 'Head - Kevin';
  c_quadro_gustavo constant text := 'Head - Gustavo';
  c_nome_kevin constant text := 'kevin';
  c_nome_gustavo constant text := 'gustavo';

  v_quadro text;
  v_nome   text;
  v_canal  text;
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

  select public.crm_channel_key(ct.channel) into v_canal
    from public.crm_contacts ct
   where ct.id = new.contact_id;

  if coalesce(v_canal, '') like '%' || c_termo_kevin || '%' then
    v_quadro := c_quadro_kevin;    v_nome := c_nome_kevin;
  else
    v_quadro := c_quadro_gustavo;  v_nome := c_nome_gustavo;
  end if;

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
  'Cria o cartão de cada venda no quadro do head: canal com "pedro" → '
  '"Head - Kevin", o resto → "Head - Gustavo" (110). Primeira coluna, head '
  'como membro. À prova de exceção.';

drop trigger if exists trg_crm_sales_venda on public.crm_sales;
create trigger trg_crm_sales_venda
  after insert on public.crm_sales
  for each row execute function public.task_card_da_venda();

-- ------------------------------------------------------------
-- CONFERIR ANTES DE APLICAR (cada um tem que voltar exatamente 1 linha)
--
--   select id, nome, titulo from public.task_boards
--    where not arquivado and 'headkevin' in
--          (regexp_replace(lower(nome), '[^[:alnum:]]', '', 'g'),
--           regexp_replace(lower(coalesce(titulo, '')), '[^[:alnum:]]', '', 'g'));
--   (idem com 'headgustavo')
--
--   select id, full_name, email from public.users
--    where is_active and lower(full_name) like 'kevin%';   -- e 'gustavo%'
--
-- CONFERIR DEPOIS: uma venda de teste de cada canal e
--
--   select origem, erro, created_at from public.task_integration_errors
--    order by created_at desc limit 10;
-- ------------------------------------------------------------
