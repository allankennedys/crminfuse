-- ============================================================
-- Evento ainda na fila acompanha a correção do valor
--
-- O valor que a Meta recebe é congelado no payload no momento em que o
-- evento é enfileirado. Entre a conversão e a entrega existe uma janela (o
-- pg_cron chama o worker de tempos em tempos) — e é justamente nela que
-- alguém percebe que lançou R$ 74,01 no lugar de R$ 301,50.
--
-- Regra: corrigir a venda atualiza o payload do evento que AINDA NÃO SAIU.
--
--   status = 'pending'  → payload atualizado, a Meta recebe o valor certo
--   status = 'sent'     → intocado. Já foi; a Conversions API não tem
--                         endpoint para corrigir evento, e reenviar criaria
--                         uma segunda compra em vez de consertar a primeira
--   'failed'/'skipped'  → intocados: são terminais, não vão sair
--
-- Isto NÃO enfileira nada. Editar venda continua sem gerar evento novo —
-- só ajusta o que está esperando na fila.
--
-- Vale para os três caminhos (editar, excluir e lançar venda anterior),
-- porque todos passam pela mesma trigger de sincronia: ela já recalcula
-- qual é a primeira venda do contato, e o valor do evento é o dessa
-- primeira.
-- ============================================================

create or replace function public.crm_sales_sync_contact()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_contact uuid;
  v_count int;
  v_total bigint;
  v_first bigint;
  v_stage uuid;
begin
  -- Em DELETE o registro NEW não existe: nunca o referencie aqui.
  if tg_op = 'DELETE' then
    v_contact := old.contact_id;
  else
    v_contact := new.contact_id;
  end if;

  select count(*), coalesce(sum(value_cents), 0)
    into v_count, v_total
  from public.crm_sales where contact_id = v_contact;

  -- Valor do contato = valor da primeira venda. Se a primeira for excluída,
  -- a segunda assume o posto e o valor acompanha; sem nenhuma venda, zera.
  select value_cents into v_first
  from public.crm_sales
  where contact_id = v_contact
  order by sold_at, created_at, id
  limit 1;

  -- Primeira venda do cliente: leva o contato para a etapa de conversão. O
  -- trigger crm_contacts_stage_change cuida do histórico e do evento na
  -- Meta (e a 028/033 garantem um evento por contato, nunca dois).
  --
  -- Só no INSERT que criou a 1ª linha. Recompra não mexe na etapa, e
  -- editar/excluir venda também não — quem já converteu, converteu.
  if tg_op = 'INSERT' and v_count = 1 then
    select s.id into v_stage
    from public.crm_stages s
    where s.organization_id = new.organization_id and s.is_conversion;
  end if;

  update public.crm_contacts c set
    sales_count = v_count,
    sales_total_cents = v_total,
    value_cents = coalesce(v_first, 0),
    -- v_stage nulo (recompra, edição, exclusão, ou org sem etapa de
    -- conversão configurada) mantém o contato onde está.
    stage_id = coalesce(v_stage, c.stage_id)
  where c.id = v_contact;

  -- Conversão ainda na fila: leva o valor corrigido junto. Depois de
  -- enviada não há o que fazer — ver cabeçalho.
  update public.crm_events e
  set payload = jsonb_set(e.payload, '{value_cents}', to_jsonb(coalesce(v_first, 0)))
  where e.contact_id = v_contact
    and e.event_type = 'conversion'
    and e.status = 'pending';

  return null;
end;
$$;

comment on function public.crm_sales_sync_contact() is
  'Mantém os totais do contato a partir das vendas, move o contato na 1ª '
  'venda e atualiza o valor do evento de conversão que ainda estiver '
  'pendente na fila da Meta.';
