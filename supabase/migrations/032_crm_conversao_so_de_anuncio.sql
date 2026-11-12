-- ============================================================
-- Só conversão de anúncio vai para a Meta
--
-- Até aqui QUALQUER entrada na etapa de conversão enfileirava um evento.
-- Sem ctwa_clid o worker mandava com action_source = 'system_generated':
-- o Purchase entra no dataset do pixel, soma no total de conversões do
-- Gerenciador e não pode ser atribuído a anúncio nenhum. Resultado prático:
-- venda de indicação, orgânico e base antiga inflando o número que a
-- operação usa para ler CPA/ROAS da mídia paga.
--
-- Regra nova: o evento só é enfileirado se o contato tiver ctwa_clid, isto
-- é, se a conversa nasceu de um clique em anúncio Click-to-WhatsApp. É o
-- único identificador que a Meta usa para ligar a conversão ao anúncio; sem
-- ele não existe atribuição possível, só volume.
--
-- O QUE NÃO MUDA
--
-- O histórico continua sendo gravado para todo mundo, e os relatórios do
-- CRM leem crm_stage_history (via crm_has_converted, 016) — não a fila.
-- Conversão de indicação segue contando como conversão na taxa, na receita
-- e no relatório de vendas. O filtro é só sobre o que sai para a Meta.
--
-- POR QUE ctwa_clid E NÃO origem/source_id
--
-- origem é texto livre digitado/preenchido por automação ("Instagram Ads",
-- "anuncio", "Indicação") e source_id pode ser campanha, anúncio OU
-- formulário. Nenhum dos dois prova clique em anúncio nem serve de
-- identificador para a Meta. ctwa_clid prova, e é justamente o que ela
-- valida contra a Página (subcode 2804072).
-- ============================================================

-- Encerramento limpo para o evento que não deve sair. 'failed' seria mentira
-- (não falhou nada) e deixaria erro vermelho na fila; o worker usa este
-- status para os eventos que já estavam enfileirados antes desta regra.
alter type public.crm_event_status add value if not exists 'skipped';

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
  -- não é movimentação, não gera histórico.
  if tg_op = 'INSERT' and new.stage_id is null then
    return null;
  end if;

  -- Tem usuário autenticado = veio da tela; sem usuário = service role,
  -- ou seja, a Edge Function chamada por uma automação externa.
  v_source := case when auth.uid() is null then 'api' else 'ui' end;

  -- O histórico é de TODA movimentação, inclusive de quem não veio de
  -- anúncio: é dele que os relatórios de conversão saem.
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

    -- Não veio de anúncio: converteu, entra no relatório, mas não vai para
    -- a Meta. Checado antes da barreira de duplicata porque é mais barato e
    -- porque é a regra mais forte — nem com evento nenhum ele deve sair.
    if coalesce(new.ctwaclid, '') = '' then
      return null;
    end if;

    -- Uma conversão por contato (028): sair da etapa e voltar não vale uma
    -- segunda compra. Conta qualquer status de propósito — um evento que
    -- falhou pode ser reenfileirado, e aí o segundo viraria duplicata.
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
        'ctwaclid', new.ctwaclid,
        'source', v_source
      )
    );
  end if;

  return null;
end;
$$;

comment on function public.crm_track_stage_change() is
  'Grava o histórico de toda mudança de etapa e enfileira a conversão na '
  'Meta apenas para contato vindo de anúncio (com ctwa_clid), uma vez por '
  'contato.';
