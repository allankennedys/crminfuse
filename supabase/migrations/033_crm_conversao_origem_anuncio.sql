-- ============================================================
-- Segundo caminho para a Meta: origem marcada como anúncio
--
-- A 032 fechou o envio em ctwa_clid. Falta o caso real de operação: o lead
-- veio de anúncio, mas o clique não foi capturado (automação falhou, contato
-- criado à mão, base antiga). Alguém identifica isso depois, edita o contato
-- para origem "Anúncio" e salva — e a conversão precisa ir para a Meta.
--
-- Sem ctwa_clid não existe atribuição ao anúncio: o evento vai como
-- action_source = 'system_generated', casado por e-mail/telefone/nome. Conta
-- como conversão no dataset, sem afirmar de qual anúncio veio — que é
-- exatamente o que se sabe nesse caso.
--
-- DOIS GATILHOS, UMA REGRA
--
-- O trigger de etapa (013/020/028/032) só dispara quando stage_id muda.
-- Editar apenas a origem de um contato que JÁ converteu não mexe em etapa,
-- então nada aconteceria. Daí o segundo trigger, em update of origem.
--
-- Para os dois não duplicarem nem divergirem, a regra inteira mora em
-- crm_enqueue_conversion(): ela decide se pode enviar, por qual caminho, e
-- se o contato já não tem evento. Os triggers só chamam.
--
-- ORDEM: o trigger de etapa insere primeiro; quando a mesma UPDATE muda
-- etapa e origem juntas, o segundo trigger vê o evento já gravado (mesma
-- transação) e não insere outro.
--
-- APLIQUE DEPOIS DA 032, EM EXECUÇÃO SEPARADA
--
-- O update no fim deste arquivo grava status = 'skipped', valor que a 032
-- acrescentou ao enum. O Postgres recusa usar um valor de enum criado na
-- MESMA transação ("unsafe use of new value of enum type"). Rodando os dois
-- arquivos em execuções distintas — que é como o supabase db push e o SQL
-- Editor fazem —, a 032 já está commitada e não há problema. Não cole os
-- dois juntos numa única execução.
-- ============================================================

-- ------------------------------------------------------------
-- "Esta origem diz anúncio?"
--
-- origem é texto livre vindo de gente e de automação. Compara sem acento e
-- sem caixa (igual ao relatório por origem, 025) e exige palavra inteira:
-- sem isso "Leads" casaria com "ads" e mandaria conversão orgânica para a
-- Meta. Mudou o vocabulário do time? Muda aqui, num lugar só.
-- ------------------------------------------------------------
-- stable, não immutable: unaccent() depende do dicionário instalado e é
-- stable. Declarar immutable deixaria o planejador livre para pré-calcular
-- em contexto onde isso não vale — e mentir no catálogo é o tipo de coisa
-- que só cobra a conta anos depois, num índice.
create or replace function public.crm_origem_is_ad(p_origem text)
returns boolean
language sql stable set search_path = public, extensions as $$
  select lower(extensions.unaccent(coalesce(p_origem, '')))
    ~ '(^|[^[:alnum:]])(anuncio|anuncios|ads|trafego pago|midia paga)([^[:alnum:]]|$)';
$$;

comment on function public.crm_origem_is_ad(text) is
  'true quando o texto da origem declara anúncio/mídia paga. Usada para '
  'decidir se a conversão vai para a Meta sem ctwa_clid.';

-- ------------------------------------------------------------
-- Enfileira a conversão, se for o caso. Fonte única da regra.
--
-- Devolve true se enfileirou — útil para depurar chamando na mão.
-- ------------------------------------------------------------
create or replace function public.crm_enqueue_conversion(p_contact uuid, p_source text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  c public.crm_contacts;
  v_ad_source text;
begin
  select * into c from public.crm_contacts where id = p_contact;
  if not found then
    return false;
  end if;

  -- Como este contato se qualifica como anúncio. 'ctwa' = clique real, com
  -- atribuição ao anúncio. 'origem' = anúncio declarado no cadastro, sem
  -- clique: o worker manda como system_generated.
  if coalesce(c.ctwaclid, '') <> '' then
    v_ad_source := 'ctwa';
  elsif public.crm_origem_is_ad(c.origem) then
    v_ad_source := 'origem';
  else
    -- Não veio de anúncio: converteu, entra nos relatórios, não vai à Meta.
    return false;
  end if;

  -- Uma conversão por contato (028). 'skipped' não conta: é evento que o
  -- worker encerrou sem enviar nada, então não representa compra registrada
  -- na Meta — e é justamente o que fica na fila do contato que só depois foi
  -- marcado como anúncio. Comparação por texto de propósito, para não
  -- depender do valor do enum estar visível nesta transação.
  if exists (
    select 1 from public.crm_events
    where contact_id = p_contact
      and event_type = 'conversion'
      and status::text <> 'skipped'
  ) then
    return false;
  end if;

  insert into public.crm_events (organization_id, contact_id, event_type, payload)
  values (
    c.organization_id,
    c.id,
    'conversion',
    jsonb_build_object(
      'value_cents', c.value_cents,
      'email', c.email,
      'phone', c.phone,
      'name', c.name,
      'ctwaclid', c.ctwaclid,
      'origem', c.origem,
      -- Lido pelo worker para escolher action_source. Sem ele o evento é
      -- tratado como fila antiga e descartado (skipped).
      'ad_source', v_ad_source,
      'source', p_source
    )
  );

  return true;
end;
$$;

-- ------------------------------------------------------------
-- Trigger de etapa: mesma lógica da 032, agora delegando o enfileiramento
-- ------------------------------------------------------------
create or replace function public.crm_track_stage_change()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_source text;
  v_converts boolean;
  v_was_conversion boolean;
begin
  if tg_op = 'UPDATE' and old.stage_id is not distinct from new.stage_id then
    return null;
  end if;

  if tg_op = 'INSERT' and new.stage_id is null then
    return null;
  end if;

  v_source := case when auth.uid() is null then 'api' else 'ui' end;

  -- Histórico de TODA movimentação, inclusive de quem não veio de anúncio:
  -- é dele que os relatórios de conversão saem (crm_has_converted, 016).
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

  -- Entrada REAL na etapa de conversão (vindo de etapa que não convertia).
  if coalesce(v_converts, false) and not coalesce(v_was_conversion, false) then
    perform public.crm_enqueue_conversion(new.id, v_source);
  end if;

  return null;
end;
$$;

-- ------------------------------------------------------------
-- Trigger de origem: contato que já converteu e agora foi marcado como anúncio
--
-- Só para quem JÁ converteu. Marcar a origem de um lead em aberto não é
-- venda: quando ele converter, o trigger de etapa cuida do envio.
--
-- crm_has_converted olha o histórico, não a etapa atual — então funciona
-- também para o convertido que a 030 já tirou do funil depois de 5 dias.
-- ------------------------------------------------------------
create or replace function public.crm_origem_conversion_catchup()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Passou a declarar anúncio agora? Se já declarava antes, o evento (se
  -- devido) já foi enfileirado na ocasião.
  if public.crm_origem_is_ad(old.origem) or not public.crm_origem_is_ad(new.origem) then
    return null;
  end if;

  if not public.crm_has_converted(new.id) then
    return null;
  end if;

  perform public.crm_enqueue_conversion(
    new.id,
    case when auth.uid() is null then 'api' else 'ui' end
  );

  return null;
end;
$$;

create trigger crm_contacts_origem_conversion
  after update of origem on public.crm_contacts
  for each row
  when (old.origem is distinct from new.origem)
  execute function public.crm_origem_conversion_catchup();

-- ------------------------------------------------------------
-- ACERTO DA FILA QUE JÁ EXISTE
--
-- Os eventos enfileirados antes desta regra não têm 'ad_source' no payload,
-- e o worker trata payload sem marca como fila antiga (descarta). Aqui a
-- fila pendente é reclassificada pelo contato, de uma vez:
--
--   • contato que se qualifica por origem ganha a marca e sai normalmente;
--   • o que não se qualifica é encerrado como 'skipped' agora, em vez de
--     ficar pendente até o worker passar.
--
-- Fazer isso no deploy também fecha uma corrida: se alguém marcasse a origem
-- como anúncio ENQUANTO o evento antigo ainda estava pendente, a barreira de
-- "uma conversão por contato" barraria o evento novo, e o antigo seria
-- descartado depois — a conversão se perderia sem ninguém ver.
--
-- Eventos com ctwa_clid não são tocados: continuam válidos e atribuídos.
-- ------------------------------------------------------------
update public.crm_events e
set payload = e.payload || jsonb_build_object('ad_source', 'origem', 'origem', c.origem)
from public.crm_contacts c
where c.id = e.contact_id
  and e.status = 'pending'
  and e.event_type = 'conversion'
  and coalesce(e.payload->>'ctwaclid', '') = ''
  and public.crm_origem_is_ad(c.origem);

update public.crm_events e
set status = 'skipped',
    error = 'Contato não veio de anúncio: conversão não é enviada à Meta'
where e.status = 'pending'
  and e.event_type = 'conversion'
  and coalesce(e.payload->>'ctwaclid', '') = ''
  and coalesce(e.payload->>'ad_source', '') <> 'origem';

comment on function public.crm_enqueue_conversion(uuid, text) is
  'Enfileira a conversão do contato na Meta se ele vier de anúncio — por '
  'ctwa_clid (atribuído) ou por origem declarada (system_generated) — e '
  'ainda não tiver evento enviado. Chamada pelos triggers de etapa e origem.';
