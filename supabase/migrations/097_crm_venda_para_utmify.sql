-- ============================================================
-- Venda de anúncio vai para a UTMify, 10 minutos depois de lançada
--
-- Toda venda nova entra numa fila com hora marcada (lançamento + 10 min). A
-- Edge Function utmify-worker pega o que venceu, monta o pedido e envia.
--
-- POR QUE 10 MINUTOS E NÃO NA HORA
--
-- É a janela de conserto: valor digitado errado, venda lançada no cadastro
-- errado, venda apagada. O pedido é montado NA HORA DO ENVIO, a partir da
-- venda e do cadastro como estiverem — então corrigir nesses 10 minutos
-- corrige o que sai. Venda apagada leva a linha da fila junto (cascade).
-- É o mesmo raciocínio da fila da Meta (042/043), com janela menor.
--
-- QUEM VAI: SÓ VENDA DE ANÚNCIO
--
-- A regra é crm_is_ad_contact (071), a mesma da Meta e do relatório de ADS:
-- clique de CTWA, clique no site com campanha, ou origem declarando
-- anúncio. Não existe uma segunda definição aqui. Ela é conferida no
-- envio, não no lançamento: o clique que chega pela automação alguns
-- minutos depois da venda ainda conta.
--
-- Venda que não é de anúncio fica 'skipped', com o motivo — não some.
--
-- O QUE NÃO FAZ
--
-- Não reenvia venda editada ou apagada DEPOIS do envio, e não manda
-- reembolso. Venda anterior a esta migration não entra (sem backfill).
--
-- A CHAMADA SÓ ACONTECE QUANDO HÁ O QUE ENVIAR
--
-- O cron roda a cada minuto, mas só chama a Edge Function se existe linha
-- vencida. Minuto sem venda é um select num índice parcial, e nenhuma
-- invocação.
--
-- O SEGREDO DO WORKER NÃO ESTÁ NESTE ARQUIVO
--
-- O cron precisa mandar x-worker-secret. Em vez de copiar o valor para mais
-- um arquivo versionado, o bloco 4 lê o cabeçalho do job que já existe
-- (ph-groups-crm-worker, 043) na hora de aplicar. Sem esse job, a migration
-- para com erro em vez de agendar uma chamada que seria recusada.
--
-- ORDEM DE DEPLOY: 096 (credencial) → Edge Function utmify-worker
-- (--no-verify-jwt) → esta. Com a ordem invertida nada se perde: o cron
-- chama uma função que ainda não existe, e as linhas ficam pendentes.
--
-- Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

-- ------------------------------------------------------------
-- 1. A fila
-- ------------------------------------------------------------
create table if not exists public.crm_utmify_queue (
  sale_id         uuid primary key references public.crm_sales(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  send_after      timestamptz not null,
  status          text not null default 'pending'
                  check (status in ('pending', 'sent', 'skipped', 'failed')),
  attempts        int not null default 0,
  error           text,
  sent_at         timestamptz,
  created_at      timestamptz not null default now()
);

comment on table public.crm_utmify_queue is
  'Vendas a enviar para a UTMify. Uma linha por venda; o pedido é montado '
  'no envio por crm_utmify_pedido().';

create index if not exists idx_crm_utmify_queue_due
  on public.crm_utmify_queue (send_after)
  where status = 'pending';

-- Sem policy, como crm_settings: só service role e SQL Editor.
alter table public.crm_utmify_queue enable row level security;

-- ------------------------------------------------------------
-- 2. Toda venda nova entra na fila
--
-- Nada aqui pode derrubar o lançamento da venda (mesma regra da 093).
-- ------------------------------------------------------------
create or replace function public.crm_utmify_enfileirar()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    insert into public.crm_utmify_queue (sale_id, organization_id, send_after)
    values (new.id, new.organization_id, now() + interval '10 minutes')
    on conflict (sale_id) do nothing;
  exception when others then
    raise warning 'utmify: venda % não entrou na fila: %', new.id, sqlerrm;
  end;
  return null;
end
$$;

drop trigger if exists trg_crm_sales_utmify on public.crm_sales;
create trigger trg_crm_sales_utmify
  after insert on public.crm_sales
  for each row execute function public.crm_utmify_enfileirar();

-- ------------------------------------------------------------
-- 3. O pedido, no formato da UTMify
--
-- Devolve o pedido pronto, ou o motivo de não enviar. Uma definição só:
-- o worker não decide nada sobre o conteúdo.
--
--   UTMs: da URL da landing (utm_*, src, sck). Sem ela — o caso do CTWA —
--   vão os ids que a automação gravou: campanha, conjunto, anúncio (ou o
--   source_id do clique de CTWA).
--
--   E-mail: obrigatório na UTMify e raro no CRM. Sem e-mail, vai
--   <telefone>@sememail.com. document vai sempre (nulo): a UTMify exige a
--   chave presente.
--
--   Pagamento: a UTMify não tem débito; vai como cartão. Não informado
--   vai como pix, que é o caso de quase toda venda.
-- ------------------------------------------------------------
create or replace function public.crm_utmify_pedido(p_sale uuid)
returns table (pedido jsonb, motivo text)
language plpgsql stable security definer set search_path = public as $$
declare
  v  record;
  ct record;
  v_quando text;
  v_url    text;
  v_fone   text;
begin
  select * into v from public.crm_sales where id = p_sale;
  if not found then
    return query select null::jsonb, 'Venda não existe mais'::text;
    return;
  end if;

  select * into ct from public.crm_contacts where id = v.contact_id;

  if not public.crm_is_ad_contact(ct.ctwaclid, ct.fbc, ct.campaign_id, ct.origem) then
    return query select null::jsonb, 'Cliente não veio de anúncio'::text;
    return;
  end if;

  if coalesce(v.value_cents, 0) <= 0 then
    return query select null::jsonb, 'Venda sem valor'::text;
    return;
  end if;

  if v.sold_at < now() - interval '7 days' then
    return query select null::jsonb, 'Venda com mais de 7 dias: a UTMify não aceita'::text;
    return;
  end if;

  v_quando := to_char(v.sold_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS');
  v_url    := ct.landing_url;
  v_fone   := nullif(regexp_replace(coalesce(ct.phone, ''), '\D', '', 'g'), '');

  return query select jsonb_build_object(
    'orderId',       coalesce(v.external_id, v.id::text),
    'platform',      'PH Creative',
    'paymentMethod', case v.payment_method
                       when 'boleto'  then 'boleto'
                       when 'credito' then 'credit_card'
                       when 'debito'  then 'credit_card'
                       else 'pix' end,
    'status',        'paid',
    'createdAt',     v_quando,
    'approvedDate',  v_quando,
    'refundedAt',    null,
    'customer', jsonb_build_object('document', null) || jsonb_strip_nulls(jsonb_build_object(
      'name',    coalesce(nullif(btrim(ct.name), ''), 'Cliente'),
      'email',   coalesce(nullif(btrim(ct.email), ''), coalesce(v_fone, v.id::text) || '@sememail.com'),
      'phone',   v_fone,
      'country', 'BR',
      'ip',      nullif(btrim(ct.client_ip), ''))),
    'products', jsonb_build_array(jsonb_build_object(
      'id',           v.id::text,
      'name',         case when v.creatives > 0
                           then v.creatives || ' criativo' || case when v.creatives > 1 then 's' else '' end
                           else 'Criativos' end,
      'planId',       null,
      'planName',     null,
      'quantity',     1,
      'priceInCents', v.value_cents)),
    'trackingParameters', jsonb_build_object(
      'src',          substring(v_url from '[?&]src=([^&#]*)'),
      'sck',          substring(v_url from '[?&]sck=([^&#]*)'),
      'utm_source',   coalesce(substring(v_url from '[?&]utm_source=([^&#]*)'), 'FB'),
      'utm_campaign', coalesce(substring(v_url from '[?&]utm_campaign=([^&#]*)'), nullif(ct.campaign_id, '')),
      'utm_medium',   coalesce(substring(v_url from '[?&]utm_medium=([^&#]*)'), nullif(ct.adset_id, '')),
      'utm_content',  coalesce(substring(v_url from '[?&]utm_content=([^&#]*)'),
                               nullif(ct.ad_id, ''), nullif(ct.source_id, '')),
      'utm_term',     substring(v_url from '[?&]utm_term=([^&#]*)')),
    'commission', jsonb_build_object(
      'totalPriceInCents',     v.value_cents,
      'gatewayFeeInCents',     0,
      'userCommissionInCents', v.value_cents,
      'currency',              'BRL')
  ), null::text;
end
$$;

comment on function public.crm_utmify_pedido(uuid) is
  'O pedido da venda no formato da UTMify, ou o motivo de não enviar. '
  'Montado na hora: correção feita antes do envio vale.';

-- Devolve nome, telefone e IP do cliente: só o worker (service role) chama.
revoke all on function public.crm_utmify_pedido(uuid) from public, anon, authenticated;
grant execute on function public.crm_utmify_pedido(uuid) to service_role;

-- ------------------------------------------------------------
-- 4. A cada minuto, se houver venda vencida, chama o worker
--
-- Os cabeçalhos (com o x-worker-secret) vêm do job do crm-worker (043):
-- WORKER_SECRET é um só para as funções do projeto.
-- ------------------------------------------------------------
select cron.unschedule(jobid)
from cron.job
where jobname = 'ph-groups-utmify-worker';

do $$
declare
  v_headers text;
begin
  select substring(command from 'headers := ''([^'']+)''::jsonb') into v_headers
    from cron.job
   where jobname = 'ph-groups-crm-worker';

  if v_headers is null or v_headers not like '%x-worker-secret%' then
    raise exception 'Job ph-groups-crm-worker não encontrado (043): sem ele não há de onde tirar o x-worker-secret.';
  end if;

  perform cron.schedule(
    'ph-groups-utmify-worker',
    '* * * * *',
    format($job$
      select net.http_post(
        url := 'https://djtpkyvvrntyagmivjqr.supabase.co/functions/v1/utmify-worker',
        headers := %L::jsonb,
        body := '{}'::jsonb
      )
      where exists (
        select 1 from public.crm_utmify_queue
         where status = 'pending' and send_after <= now()
      );
    $job$, v_headers)
  );
end
$$;

-- ------------------------------------------------------------
-- CONFERIR DEPOIS DE APLICAR
--
--   -- o que está na fila e o que aconteceu com cada venda
--   select q.status, q.send_after, q.sent_at, q.attempts, q.error, ct.name, v.value_cents
--     from public.crm_utmify_queue q
--     join public.crm_sales v     on v.id = q.sale_id
--     join public.crm_contacts ct on ct.id = v.contact_id
--    order by q.created_at desc limit 20;
--
--   -- o pedido que sairia para uma venda, sem enviar
--   select * from public.crm_utmify_pedido('<id da venda>');
--
-- DESLIGAR sem perder nada (as vendas continuam entrando na fila):
--
--   select cron.unschedule('ph-groups-utmify-worker');
-- ------------------------------------------------------------
