-- ============================================================
-- Conversão da Meta atrelada ao anúncio (Click-to-WhatsApp)
--
-- Para a Meta atribuir a conversão ao anúncio/campanha certos, o evento
-- da Conversion API precisa carregar o ctwa_clid (ID do clique no anúncio,
-- que o n8n grava no contato via `ctwaclid`). O crm-worker já lê esse
-- campo do payload do evento e, quando presente, envia como mensageria
-- (action_source=business_messaging + messaging_channel=whatsapp +
-- user_data.ctwa_clid).
--
-- Faltava o gatilho COLOCAR o ctwaclid no payload do evento enfileirado.
-- Esta migration recria crm_track_stage_change acrescentando esse campo —
-- o resto do corpo é idêntico ao de 013.
--
-- Deploy: esta migration ANTES do crm-worker atualizado. Se o worker novo
-- subir antes, ele só não acha o ctwaclid nos eventos antigos e cai no
-- comportamento anterior — sem quebrar nada.
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
