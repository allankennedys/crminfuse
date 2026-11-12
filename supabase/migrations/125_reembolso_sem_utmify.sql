-- ============================================================
-- Conserto da 122: o reembolso ainda cancelava o envio na fila da Utmify,
-- que saiu. Sem isto, marcar uma venda como reembolsada dava erro.
-- ============================================================

CREATE OR REPLACE FUNCTION public.crm_sales_refund_stamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.refunded_at is null then
    new.refunded_by := null;
    new.refunded_cents := null;
    return new;
  end if;

  if new.refunded_cents is not null and new.refunded_cents >= new.value_cents then
    new.refunded_cents := null;
  end if;

  if old.refunded_at is not null then
    -- Já estava reembolsada: não reescreve a data.
    new.refunded_at := old.refunded_at;
    new.refunded_by := old.refunded_by;
  else
    new.refunded_at := now();
    new.refunded_by := auth.uid();
  end if;

  -- Só o total desfaz a compra. Roda ao marcar total e quando um parcial
  -- vira total; total que continua total não tem mais nada pendente.
  if new.refunded_cents is null
     and (old.refunded_at is null or old.refunded_cents is not null) then
    update public.crm_events e
    set status = 'skipped',
        error = 'Venda reembolsada antes de o evento ser enviado'
    where e.sale_id = new.id
      and e.event_type = 'conversion'
      and e.status = 'pending';
  end if;

  return new;
end;
$function$;
