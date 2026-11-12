-- ============================================================
-- Reembolso PARCIAL
--
-- A 101 só sabia "reembolsada ou não": a venda de R$ 500 com R$ 200
-- devolvidos tinha que ser marcada inteira (e o líquido perdia R$ 300 que
-- ficaram no caixa) ou não ser marcada (e os R$ 200 sumiam). Agora a venda
-- guarda QUANTO foi devolvido.
--
--   refunded_at null                    não reembolsada
--   refunded_at dado, refunded_cents null   reembolso TOTAL — é como ficam
--                                           todas as vendas marcadas na 101
--   refunded_at dado, refunded_cents dado   reembolso PARCIAL daquele valor
--
-- Total é null, e não o valor da venda, de propósito: se alguém corrigir o
-- valor da venda depois, o reembolso total continua total sem ninguém
-- lembrar de corrigir os dois.
--
-- O PARCIAL NÃO SEGURA O QUE AINDA NÃO SAIU. A 101 marca como 'skipped' o
-- evento da Meta e a linha da UTMify pendentes porque a compra foi desfeita.
-- No parcial a compra continua de pé — o cliente ficou com parte do pedido —
-- então o Purchase sai normalmente, com o valor cheio da venda. Se um parcial
-- virar total depois, aí sim o que estiver pendente é segurado.
--
-- Todo o resto da 101 vale igual: a venda fica, ninguém é avisado, o bruto
-- conta pela sold_at e o líquido desconta pela refunded_at — só que agora
-- desconta o valor devolvido, não o valor da venda.
--
-- Aplicar pelo SQL Editor, depois da 101 e ANTES do deploy da tela (a tela
-- nova grava refunded_cents). Nunca por db push.
-- ============================================================

alter table public.crm_sales
  add column if not exists refunded_cents bigint;

alter table public.crm_sales
  drop constraint if exists crm_sales_refunded_cents_positivo;
alter table public.crm_sales
  add constraint crm_sales_refunded_cents_positivo
  check (refunded_cents is null or refunded_cents > 0);

comment on column public.crm_sales.refunded_cents is
  'Quanto foi devolvido, quando o reembolso é parcial. null com refunded_at '
  'preenchido = reembolso total. Sempre menor que value_cents ao gravar.';

-- ------------------------------------------------------------
-- Carimbo e trava do que ainda não saiu
--
-- Mesma função da 101, agora também dona do valor: o cliente manda
-- refunded_at (qualquer valor não nulo = reembolsou, null = desfez) e, se
-- for parcial, refunded_cents. Valor igual ou maior que o da venda é
-- reembolso total e vira null.
--
-- Dá para trocar o valor de uma venda já reembolsada (parcial ↔ total ou
-- outro parcial): a data e o autor originais ficam.
-- ------------------------------------------------------------
create or replace function public.crm_sales_refund_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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

    update public.crm_utmify_queue q
    set status = 'skipped',
        error = 'Venda reembolsada antes do envio'
    where q.sale_id = new.id
      and q.status = 'pending';
  end if;

  return new;
end;
$$;

comment on function public.crm_sales_refund_stamp() is
  'Carimba refunded_at/refunded_by pelo servidor, normaliza refunded_cents '
  '(null = total) e, no reembolso total, segura o evento da Meta e o envio à '
  'UTMify que ainda estavam pendentes.';

drop trigger if exists crm_sales_refund_stamp on public.crm_sales;
create trigger crm_sales_refund_stamp
  before update of refunded_at, refunded_cents on public.crm_sales
  for each row
  execute function public.crm_sales_refund_stamp();

-- ------------------------------------------------------------
-- Reembolsos do período (pela data do REEMBOLSO)
--
-- Ganha refund_cents (o que foi devolvido) e partial; value_cents continua
-- sendo o valor da venda. total_cents passa a somar o devolvido. O tipo de
-- retorno muda, então a função sai e volta.
--
-- O least() cobre a venda que teve o valor reduzido depois do reembolso
-- parcial: nunca se desconta mais do que a venda vale.
-- ------------------------------------------------------------
drop function if exists public.crm_report_refunds(date, date, text, int);

create function public.crm_report_refunds(
  p_from date default ((now() at time zone 'America/Sao_Paulo')::date - 29),
  p_to date default (now() at time zone 'America/Sao_Paulo')::date,
  p_channel text default null,
  p_limit int default 200
)
returns table(
  sale_id          uuid,
  contact_id       uuid,
  name             text,
  phone            text,
  channel          text,
  value_cents      bigint,
  refund_cents     bigint,
  partial          boolean,
  sold_at          timestamptz,
  refunded_at      timestamptz,
  refunded_by_name text,
  total_count      bigint,
  total_cents      bigint
)
language sql stable security definer set search_path = public as $$
  with r as (
    select
      v.id as sale_id,
      v.contact_id,
      c.name,
      c.phone,
      c.channel,
      v.value_cents::bigint as value_cents,
      least(coalesce(v.refunded_cents, v.value_cents), v.value_cents)::bigint as refund_cents,
      (v.refunded_cents is not null and v.refunded_cents < v.value_cents) as partial,
      v.sold_at,
      v.refunded_at,
      coalesce(nullif(trim(u.full_name), ''), u.email) as refunded_by_name
    from public.crm_sales v
    join public.crm_contacts c on c.id = v.contact_id
    left join public.users u on u.id = v.refunded_by
    where v.organization_id = public.current_org_id()
      and v.refunded_at is not null
      and v.refunded_at >= public.crm_day_start(p_from)
      and v.refunded_at <  public.crm_day_start(p_to + 1)
      and (p_channel is null or c.channel = p_channel)
  )
  select
    r.*,
    count(*) over ()::bigint,
    (sum(r.refund_cents) over ())::bigint
  from r
  order by r.refunded_at desc, r.sale_id
  limit greatest(p_limit, 1);
$$;

comment on function public.crm_report_refunds(date, date, text, int) is
  'Vendas reembolsadas no período, pela data do reembolso (não da venda). '
  'refund_cents é o que foi devolvido (o valor da venda no total, '
  'refunded_cents no parcial) e é o que total_cents soma. Alimenta o card '
  'Reembolsado e o líquido da aba Vendas.';

-- drop + create zera os privilégios.
revoke all on function public.crm_report_refunds(date, date, text, int) from public, anon;
grant execute on function public.crm_report_refunds(date, date, text, int)
  to authenticated;

-- Conferência: deve listar a coluna e a função.
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'crm_sales'
      and column_name = 'refunded_cents') as coluna_nova,
  to_regprocedure('public.crm_report_refunds(date, date, text, int)') is not null as rpc_ok;
