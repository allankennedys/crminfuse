-- ============================================================
-- Tarefas: venda volta a criar cartão, agora no quadro dos heads
--
-- Pedido da operação (26/10/2026): toda venda lançada no CRM volta a virar
-- cartão — desfaz a 098 —, mas não mais no quadro da squad do vendedor (095).
-- Vai sempre para o quadro "Heads - Gustavo e Kevin", na coluna
-- "AGUARDANDO INF CLIENTE", seja quem for o vendedor. Os heads distribuem
-- dali.
--
-- QUADRO E COLUNA PELO NOME
--
-- Os dois já existem e não há flag que os distinga, então são achados pelo
-- nome, comparando só letras e números (sem caixa, espaço ou traço):
-- "Heads – Gustavo e Kevin" e "heads - gustavo  e kevin" casam igual.
-- Renomear o quadro ou a coluna quebra a ligação — por isso os nomes estão
-- nas duas constantes abaixo, e a falha não passa em silêncio:
--
--   • quadro não encontrado (ou mais de um com o nome): não cria o cartão e
--     registra em task_integration_errors;
--   • coluna não encontrada: cria na coluna de entrada (is_inbox) do quadro
--     dos heads — melhor o cartão na coluna errada que cartão nenhum — e
--     registra também, para alguém corrigir o nome.
--
-- Todo o resto da 093/095 continua: after insert, à prova de exceção,
-- lock_timeout de 2s, título "Cliente · N criativos · DD/MM", posição no
-- topo da coluna (t18), pasta do Drive pedida pelo gatilho do cartão (t05).
--
-- task_quadro_da_venda (t18) NÃO sai: Compras e Relatórios ainda a usam
-- para saber de qual squad é a venda. Só o gatilho deixa de usá-la.
--
-- DESLIGAR de novo é uma linha, como na 098:
--
--   drop trigger if exists trg_crm_sales_venda on public.crm_sales;
--
-- Aplicar pelo SQL Editor, depois da 098. Nunca por db push.
-- ============================================================

create or replace function public.task_card_da_venda()
returns trigger
language plpgsql security definer
  set search_path = public
  set lock_timeout = '2s' as $$
declare
  c_quadro constant text := 'Heads - Gustavo e Kevin';
  c_coluna constant text := 'AGUARDANDO INF CLIENTE';
  v_card   uuid;
  v_board  uuid;
  v_list   uuid;
  v_qtd    int;
begin
  if to_regclass('public.task_cards') is null
     or to_regclass('public.task_integration_errors') is null then
    return null;
  end if;

  select count(*), min(b.id::text)::uuid into v_qtd, v_board
    from public.task_boards b
   where b.organization_id = new.organization_id
     and not b.arquivado
     -- O menu mostra o nome; o cabeçalho do quadro, o título. Vale qualquer um.
     and regexp_replace(lower(c_quadro), '[^[:alnum:]]', '', 'g') in (
           regexp_replace(lower(b.nome), '[^[:alnum:]]', '', 'g'),
           regexp_replace(lower(coalesce(b.titulo, '')), '[^[:alnum:]]', '', 'g'));

  if v_qtd <> 1 then
    insert into public.task_integration_errors (origem, referencia, erro, detalhe)
    values ('crm_sales.venda', new.id,
            case when v_qtd = 0 then 'Quadro não encontrado: ' || c_quadro
                 else 'Mais de um quadro com o nome: ' || c_quadro end,
            jsonb_build_object('organization_id', new.organization_id));
    return null;
  end if;

  select l.id into v_list
    from public.task_lists l
   where l.board_id = v_board
     and not l.arquivada
     and regexp_replace(lower(l.titulo), '[^[:alnum:]]', '', 'g')
       = regexp_replace(lower(c_coluna), '[^[:alnum:]]', '', 'g')
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
            'Coluna não encontrada: ' || c_coluna || ' (cartão criado na coluna de entrada)',
            jsonb_build_object('board_id', v_board, 'list_id', v_list));
  end if;

  insert into public.task_cards
         (organization_id, board_id, list_id, titulo, contact_id, sale_id, created_by)
  select new.organization_id, v_board, v_list,
         coalesce(ct.name, 'Cliente sem nome') ||
           case when new.creatives > 0
                then ' · ' || new.creatives || ' criativo' ||
                     case when new.creatives > 1 then 's' else '' end
                else '' end ||
           ' · ' || to_char(coalesce(new.sold_at, now()), 'DD/MM'),
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
  'Cria o cartão de cada venda no quadro "Heads - Gustavo e Kevin", coluna '
  '"AGUARDANDO INF CLIENTE" (106). À prova de exceção.';

-- O drop antes evita dois gatilhos (e dois cartões por venda) se alguém já
-- tiver religado o da 093 à mão.
drop trigger if exists trg_crm_sales_venda on public.crm_sales;
create trigger trg_crm_sales_venda
  after insert on public.crm_sales
  for each row execute function public.task_card_da_venda();

-- ------------------------------------------------------------
-- CONFERIR ANTES DE APLICAR (tem que voltar exatamente 1 linha em cada)
--
--   select id, nome, titulo from public.task_boards
--    where not arquivado
--      and 'headsgustavoekevin' in (regexp_replace(lower(nome), '[^[:alnum:]]', '', 'g'),
--                                   regexp_replace(lower(coalesce(titulo, '')), '[^[:alnum:]]', '', 'g'));
--
--   select l.id, l.titulo from public.task_lists l
--     join public.task_boards b on b.id = l.board_id
--    where not l.arquivada
--      and 'headsgustavoekevin' in (regexp_replace(lower(b.nome), '[^[:alnum:]]', '', 'g'),
--                                   regexp_replace(lower(coalesce(b.titulo, '')), '[^[:alnum:]]', '', 'g'))
--      and regexp_replace(lower(l.titulo), '[^[:alnum:]]', '', 'g') = 'aguardandoinfcliente';
--
-- CONFERIR DEPOIS: lançar uma venda de teste e ver o cartão na coluna, e
--
--   select origem, erro, created_at from public.task_integration_errors
--    order by created_at desc limit 10;
-- ------------------------------------------------------------
