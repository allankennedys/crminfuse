-- ============================================================
-- Uma conversão por contato: fecha a reentrada na etapa
--
-- A regra de 013/020 só bloqueava conversão vinda de OUTRA etapa que já
-- convertia. Sair da etapa de conversão e voltar passava pelo filtro e
-- enfileirava um segundo evento, com event_id novo — a dedupe da Meta é
-- por event_id, então ela contaria DUAS compras.
--
-- Não é teórico: em produção o contato "Juliana" gerou os eventos
-- 2a2fb927 (24/07) e ad0f249b (27/07) com o MESMO ctwa_clid e o MESMO
-- valor (R$ 300,00). Os dois só não viraram receita dobrada porque o ramo
-- CTWA estava quebrado (ver 026). Consertado o CTWA, o bug passa a valer
-- dinheiro — daí esta migration ir junto.
--
-- Regra nova: só enfileira se o contato NUNCA gerou conversão. O modelo
-- tem um único value_cents por contato, então recompra não é representável
-- hoje; se um dia for, o certo é um evento por venda, não por etapa.
-- ============================================================

create or replace function public.crm_track_stage_change()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_source text;
  v_converts boolean;
  v_was_conversion boolean;
begin
  -- Nada mudou de etapa: não gera histórico nem evento. É isto que evita
  -- eventos duplicados quando o contato é salvo de novo na mesma etapa.
  if tg_op = 'UPDATE' and old.stage_id is not distinct from new.stage_id then
    return null;
  end if;

  -- Contato criado JÁ fora do funil (importação da base pré-implementação):
  -- não é movimentação, não gera histórico. Sem isto, importar 20 mil
  -- contatos criaria 20 mil linhas de histórico sem significado nenhum.
  if tg_op = 'INSERT' and new.stage_id is null then
    return null;
  end if;

  -- Tem usuário autenticado = veio da tela; sem usuário = service role,
  -- ou seja, a Edge Function chamada por uma automação externa.
  v_source := case when auth.uid() is null then 'api' else 'ui' end;

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

  -- Enfileira só na entrada REAL na etapa de conversão: vindo de uma etapa
  -- que não convertia. Reentrar na mesma etapa não gera evento novo.
  if coalesce(v_converts, false) and not coalesce(v_was_conversion, false) then

    -- Barreira nova: o contato já converteu alguma vez? Então sair da
    -- etapa e voltar não vale uma segunda compra. Conta qualquer status
    -- (pending/sent/failed) de propósito — um evento que falhou pode ser
    -- reenfileirado, e aí o segundo viraria duplicata de verdade.
    if exists (
      select 1 from public.crm_events
      where contact_id = new.id and event_type = 'conversion'
    ) then
      return null;
    end if;

    insert into public.crm_events (organization_id, contact_id, event_type, payload)
    values (
      new.organization_id,
      new.id,
      'conversion',
      jsonb_build_object(
        'value_cents', new.value_cents,
        'email', new.email,
        'phone', new.phone,
        'name', new.name,
        -- ID do clique no anúncio: leva a atribuição ao anúncio/campanha
        -- na Meta. Null quando o lead não veio de Click-to-WhatsApp.
        'ctwaclid', new.ctwaclid,
        'source', v_source
      )
    );
  end if;

  return null;
end;
$$;

-- Suporta o `exists` acima. Sem ele, toda mudança de etapa varreria
-- crm_events inteira.
create index if not exists idx_crm_events_contact_conversion
  on public.crm_events(contact_id)
  where event_type = 'conversion';
