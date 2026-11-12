-- ============================================================
-- Tarefas: sobe os cartões das vendas de HOJE para o quadro de cada head
--
-- Uso único, depois da 110 e depois de criar "Head - Gustavo" e
-- "Head - Kevin". Mesma regra da 110: canal com "pedro" → Kevin, o resto →
-- Gustavo; primeira coluna do quadro; head como membro; mesmo título.
--
-- "Hoje" = vendas lançadas (created_at) no dia de hoje em São Paulo.
--
-- SÓ CRIA PARA VENDA SEM CARTÃO. Venda que já tem cartão não arquivado (por
-- exemplo o que o gatilho da 106 criou hoje no quadro antigo) é pulada e
-- listada no NOTICE, para você decidir: mover à mão ou arquivar. Rodar duas
-- vezes não duplica nada.
--
-- COMEÇA EM SIMULAÇÃO: v_aplicar = false só mostra, com NOTICE, o que
-- criaria. Confira e troque para true.
--
-- Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

do $$
declare
  v_aplicar boolean := true;      -- <<< troque para true para gravar

  r        record;
  v_quadro text;
  v_nome   text;
  v_board  uuid;
  v_list   uuid;
  v_head   uuid;
  v_card   uuid;
  v_qtd    int;
  v_criados int := 0;
  v_pulados int := 0;
begin
  for r in
    select s.id, s.organization_id, s.contact_id, s.creatives, s.sold_at,
           s.created_by, ct.name as cliente,
           public.crm_channel_key(ct.channel) as canal
      from public.crm_sales s
      join public.crm_contacts ct on ct.id = s.contact_id
     where (s.created_at at time zone 'America/Sao_Paulo')::date
         = (now() at time zone 'America/Sao_Paulo')::date
     order by s.created_at
  loop
    if exists (select 1 from public.task_cards c
                where c.sale_id = r.id and not c.arquivado) then
      v_pulados := v_pulados + 1;
      raise notice 'PULADA (já tem cartão): venda % — %', r.id, r.cliente;
      continue;
    end if;

    if coalesce(r.canal, '') like '%pedro%' then
      v_quadro := 'Head - Kevin';    v_nome := 'kevin';
    else
      v_quadro := 'Head - Gustavo';  v_nome := 'gustavo';
    end if;

    select count(*), min(b.id::text)::uuid into v_qtd, v_board
      from public.task_boards b
     where b.organization_id = r.organization_id and not b.arquivado
       and regexp_replace(lower(v_quadro), '[^[:alnum:]]', '', 'g') in (
             regexp_replace(lower(b.nome), '[^[:alnum:]]', '', 'g'),
             regexp_replace(lower(coalesce(b.titulo, '')), '[^[:alnum:]]', '', 'g'));
    if v_qtd <> 1 then
      raise exception 'Quadro "%": achei % (precisa ser 1). Nada foi gravado.', v_quadro, v_qtd;
    end if;

    select l.id into v_list
      from public.task_lists l
     where l.board_id = v_board and not l.arquivada
     order by l.is_inbox desc, l.position
     limit 1;
    if v_list is null then
      raise exception 'Quadro "%" sem coluna. Nada foi gravado.', v_quadro;
    end if;

    select count(*), min(u.id::text)::uuid into v_qtd, v_head
      from public.users u
     where u.organization_id = r.organization_id and u.is_active
       and (case when v_nome = 'gustavo' then lower(u.email) = 'gusttah.borges@gmail.com'
            else regexp_replace(lower(coalesce(u.full_name, '')), '[^[:alnum:]]', '', 'g') like v_nome || '%' end);
    if v_qtd <> 1 then
      raise exception 'Head "%": achei % usuários ativos (precisa ser 1). Nada foi gravado.', v_nome, v_qtd;
    end if;

    raise notice '% → % : % (% criativos)', case when v_aplicar then 'CRIA' else 'CRIARIA' end,
                 v_quadro, r.cliente, coalesce(r.creatives, 0);

    if v_aplicar then
      insert into public.task_cards
             (organization_id, board_id, list_id, titulo, contact_id, sale_id, created_by)
      values (r.organization_id, v_board, v_list,
              coalesce(r.cliente, 'Cliente sem nome') ||
                case when r.creatives > 0
                     then ' · ' || r.creatives || ' criativo' ||
                          case when r.creatives > 1 then 's' else '' end
                     else '' end ||
                ' · ' || to_char(coalesce(r.sold_at, now()), 'DD/MM'),
              r.contact_id, r.id, r.created_by)
      returning id into v_card;

      insert into public.task_card_members (card_id, user_id, organization_id)
      values (v_card, v_head, r.organization_id)
      on conflict do nothing;
    end if;
    v_criados := v_criados + 1;
  end loop;

  raise notice '% cartões %, % vendas puladas.', v_criados,
               case when v_aplicar then 'criados' else 'seriam criados (simulação)' end, v_pulados;
end;
$$;
