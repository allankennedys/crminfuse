-- ============================================================
-- Venda REEMBOLSADA — a alternativa a excluir
--
-- Até aqui, reembolso era excluir a venda: ela sumia do relatório, o
-- webhook de exclusão (082) avisava o n8n, e não sobrava rastro de quanto
-- foi devolvido. Agora a lixeira do drawer pergunta:
--
--   * Excluir de todos os sistemas — o caminho antigo, intacto (082).
--   * Marcar como reembolso — a venda FICA. Só ganha refunded_at.
--
-- MARCAR NÃO AVISA NINGUÉM, e não por acaso:
--   - o webhook de exclusão (082) é AFTER DELETE — um update não o dispara;
--   - o de alteração (088) só olha value_cents, payment_method, sold_at e
--     canal — refunded_at não está na lista;
--   - a crm_sales_sync_contact (090) roda no update, mas recalcula os mesmos
--     totais e regrava o mesmo valor no evento pendente: nada muda.
--
-- A VENDA CONTINUA CONTANDO no faturamento pela data dela (sold_at), nos
-- totais do contato e na ordem de 1ª venda/recompra. O reembolso é outro
-- fato, com data própria: o relatório de vendas mostra o total bruto e,
-- abaixo, o líquido = bruto do período − reembolsos FEITOS no período
-- (refunded_at), mesmo que a venda seja de outro mês. É assim que o caixa
-- enxerga: o dinheiro saiu no dia do estorno.
--
-- O QUE AINDA NÃO SAIU É SEGURADO: evento da Meta pendente desta venda vira
-- 'skipped' e a linha pendente da UTMify também — mandar um Purchase de
-- compra já devolvida seria pior que não mandar. O que já foi enviado não
-- volta (mesma regra da 072/082).
--
-- Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

alter table public.crm_sales
  add column if not exists refunded_at timestamptz,
  add column if not exists refunded_by uuid references public.users(id) on delete set null;

comment on column public.crm_sales.refunded_at is
  'Quando a venda foi marcada como reembolsada. null = não reembolsada. '
  'A venda continua no faturamento pela sold_at; o líquido do período '
  'desconta pela refunded_at.';

-- O relatório filtra por data do reembolso; poucas linhas terão valor.
create index if not exists idx_crm_sales_refunded_at
  on public.crm_sales (organization_id, refunded_at)
  where refunded_at is not null;

-- ------------------------------------------------------------
-- Carimbo e trava do que ainda não saiu
--
-- A data e o autor são do servidor: o cliente só diz "reembolsou" (manda
-- qualquer valor não nulo) ou "desfez" (manda null). Remarcar uma venda já
-- reembolsada mantém a data original.
-- ------------------------------------------------------------
create or replace function public.crm_sales_refund_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.refunded_at is not distinct from old.refunded_at then
    return new;
  end if;

  if new.refunded_at is null then
    new.refunded_by := null;
    return new;
  end if;

  if old.refunded_at is not null then
    -- Já estava reembolsada: não reescreve a data.
    new.refunded_at := old.refunded_at;
    new.refunded_by := old.refunded_by;
    return new;
  end if;

  new.refunded_at := now();
  new.refunded_by := auth.uid();

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

  return new;
end;
$$;

comment on function public.crm_sales_refund_stamp() is
  'Carimba refunded_at/refunded_by pelo servidor e segura o evento da Meta '
  'e o envio à UTMify que ainda estavam pendentes.';

drop trigger if exists crm_sales_refund_stamp on public.crm_sales;
create trigger crm_sales_refund_stamp
  before update of refunded_at on public.crm_sales
  for each row
  execute function public.crm_sales_refund_stamp();

-- ------------------------------------------------------------
-- Reembolsos do período (pela data do REEMBOLSO)
--
-- Uma linha por venda reembolsada, da mais recente para a mais antiga.
-- total_count/total_cents vêm em toda linha (janela) para o card não
-- depender do limite da lista.
-- ------------------------------------------------------------
create or replace function public.crm_report_refunds(
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
    (sum(r.value_cents) over ())::bigint
  from r
  order by r.refunded_at desc, r.sale_id
  limit greatest(p_limit, 1);
$$;

comment on function public.crm_report_refunds(date, date, text, int) is
  'Vendas reembolsadas no período, pela data do reembolso (não da venda). '
  'Alimenta o card Reembolsado e o líquido da aba Vendas.';

grant execute on function public.crm_report_refunds(date, date, text, int)
  to authenticated;

-- Conferência: deve listar a coluna e a função.
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'crm_sales'
      and column_name in ('refunded_at', 'refunded_by')) as colunas_novas,
  to_regprocedure('public.crm_report_refunds(date, date, text, int)') is not null as rpc_ok;
