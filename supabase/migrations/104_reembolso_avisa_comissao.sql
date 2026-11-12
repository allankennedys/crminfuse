-- ============================================================
-- Reembolso avisa o sistema de comissão (Lovable)
--
-- Até aqui o reembolso passava calado (101–103). Agora UM destino passa a
-- saber dele: a rota do sistema de comissão, que desconta o valor devolvido
-- da base de cálculo do vendedor no mês do REEMBOLSO. A venda lá não muda.
--
-- O n8n continua sem saber: o webhook de alteração (088) segue olhando só
-- valor, pagamento, data e canal. Esta é uma trigger SEPARADA — não pôr
-- refunded_at na lista da 088, senão reembolso vira "venda_atualizada".
--
-- O QUE SAI
--
--   upsert  ao marcar o reembolso, ao trocar o valor (parcial ↔ total), ao
--           editar a nota, e quando muda algo que entra no corpo: valor ou
--           data da venda (o total é o valor da venda), ou o dono (venda
--           movida de cadastro, contato trocou de canal).
--   delete  ao desfazer o reembolso, e ao EXCLUIR uma venda que estava
--           reembolsada — a venda some de lá pela 082, e o desconto não
--           pode ficar órfão.
--
-- refund_id = id da venda. A venda tem no máximo um reembolso, então a chave
-- é estável: reenviar o mesmo upsert não desconta duas vezes do outro lado.
--
-- seller_name = canal do contato ("PH" ou "Pedro"), o mesmo dono da 088.
-- Canal diferente desses volta 422 e fica no log abaixo.
--
-- O TOKEN FICA NO VAULT, não neste arquivo:
--
--   select vault.create_secret('<token>', 'lovable_refund_token');
--
-- Sem o segredo o reembolso grava normalmente e o log registra o motivo —
-- nunca derruba o clique em "marcar como reembolso".
--
-- NÃO FICA CALADO: pg_net não devolve a resposta para quem chamou, e 401 de
-- token errado morreria sem ninguém ver. Cada envio fica em
-- crm_refund_notifications com o request_id do pg_net; a consulta de
-- conferência no fim junta com net._http_response (que o pg_net guarda por
-- 6 horas).
--
-- Rollback anula o aviso: net.http_post enfileira dentro da transação.
--
-- Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

create table if not exists public.crm_refund_notifications (
  id          bigserial primary key,
  sale_id     uuid not null,
  action      text not null check (action in ('upsert', 'delete')),
  request_id  bigint,
  error       text,
  body        jsonb not null,
  created_at  timestamptz not null default now()
);

comment on table public.crm_refund_notifications is
  'Cada aviso de reembolso enviado ao sistema de comissão. request_id casa '
  'com net._http_response para ver o status da resposta.';

create index if not exists idx_crm_refund_notifications_sale
  on public.crm_refund_notifications (sale_id, created_at desc);

-- Só o SQL Editor/service role lê. Sem policy = nada para authenticated.
alter table public.crm_refund_notifications enable row level security;

-- ------------------------------------------------------------
-- O corpo e o POST
--
-- Lê a venda do banco em vez de receber a linha: serve à trigger e ao
-- reenvio manual (ver o fim do arquivo) do mesmo jeito. No delete a venda
-- pode já não existir — por isso o delete só precisa do id.
-- ------------------------------------------------------------
create or replace function public.crm_refund_notify(p_sale_id uuid, p_action text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url constant text := 'https://phcreative.site/api/public/refund-commission';
  v_token   text;
  v_sale    public.crm_sales;
  v_contact public.crm_contacts;
  v_body    jsonb;
  v_req     bigint;
begin
  if p_action = 'delete' then
    v_body := jsonb_build_object('action', 'delete', 'refund_id', p_sale_id);
  else
    select * into v_sale from public.crm_sales where id = p_sale_id;
    if v_sale.id is null or v_sale.refunded_at is null then
      return;
    end if;

    select * into v_contact from public.crm_contacts where id = v_sale.contact_id;

    v_body := jsonb_build_object(
      'action', 'upsert',
      'refund_id', v_sale.id,
      'sale_id', v_sale.id,
      'external_id', v_sale.external_id,
      'seller_name', trim(v_contact.channel),
      'seller_channel', trim(v_contact.channel),
      'customer_name', v_contact.name,
      'customer_phone', v_contact.phone,
      'sale_value', round(v_sale.value_cents::numeric / 100, 2),
      'sold_at', v_sale.sold_at,
      -- refunded_cents null = reembolso total (102): devolveu a venda inteira.
      'refunded_value', round(coalesce(v_sale.refunded_cents, v_sale.value_cents)::numeric / 100, 2),
      'refunded_at', v_sale.refunded_at,
      'note', nullif(trim(v_sale.refund_note), '')
    );
  end if;

  select decrypted_secret into v_token
  from vault.decrypted_secrets where name = 'lovable_refund_token';

  if v_token is null then
    insert into public.crm_refund_notifications (sale_id, action, error, body)
    values (p_sale_id, p_action, 'Segredo lovable_refund_token ausente no Vault', v_body);
    return;
  end if;

  select net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_token
    ),
    body := v_body,
    timeout_milliseconds := 15000
  ) into v_req;

  insert into public.crm_refund_notifications (sale_id, action, request_id, body)
  values (p_sale_id, p_action, v_req, v_body);
end;
$$;

comment on function public.crm_refund_notify(uuid, text) is
  'Envia ao sistema de comissão o reembolso da venda (upsert) ou a remoção '
  'dele (delete), e registra em crm_refund_notifications.';

revoke all on function public.crm_refund_notify(uuid, text) from public, authenticated;

-- ------------------------------------------------------------
-- A venda mudou
--
-- AFTER: a crm_sales_refund_stamp (BEFORE, 102) já carimbou data e
-- normalizou refunded_cents, então o corpo sai com o valor final.
-- ------------------------------------------------------------
create or replace function public.crm_sale_refund_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.refunded_at is not null then
      perform public.crm_refund_notify(old.id, 'delete');
    end if;
    return null;
  end if;

  if new.refunded_at is null then
    if old.refunded_at is not null then
      perform public.crm_refund_notify(new.id, 'delete');
    end if;
    return null;
  end if;

  if old.refunded_at is null
     or new.refunded_cents is distinct from old.refunded_cents
     or new.refund_note    is distinct from old.refund_note
     or new.value_cents    is distinct from old.value_cents
     or new.sold_at        is distinct from old.sold_at
     or new.external_id    is distinct from old.external_id
     or new.contact_id     is distinct from old.contact_id then
    perform public.crm_refund_notify(new.id, 'upsert');
  end if;

  return null;
end;
$$;

comment on function public.crm_sale_refund_webhook() is
  'Avisa o sistema de comissão quando um reembolso é marcado, alterado, '
  'desfeito, ou quando a venda reembolsada é excluída.';

drop trigger if exists crm_sales_refund_webhook on public.crm_sales;
create trigger crm_sales_refund_webhook
  after update or delete on public.crm_sales
  for each row
  execute function public.crm_sale_refund_webhook();

-- ------------------------------------------------------------
-- O contato trocou de canal — o reembolso muda de vendedor
-- ------------------------------------------------------------
create or replace function public.crm_contact_channel_refund_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale_id uuid;
begin
  if public.crm_channel_key(new.channel)
     is not distinct from public.crm_channel_key(old.channel) then
    return null;
  end if;

  for v_sale_id in
    select id from public.crm_sales
    where contact_id = new.id and refunded_at is not null
  loop
    perform public.crm_refund_notify(v_sale_id, 'upsert');
  end loop;

  return null;
end;
$$;

drop trigger if exists crm_contacts_refund_webhook_channel on public.crm_contacts;
create trigger crm_contacts_refund_webhook_channel
  after update of channel on public.crm_contacts
  for each row
  execute function public.crm_contact_channel_refund_webhook();

-- ------------------------------------------------------------
-- Conferência
--
-- Últimos envios com o status da resposta. status_code null = ainda na fila
-- do pg_net, ou a resposta já expirou (6h).
--
--   select n.created_at, n.action, n.sale_id, n.error,
--          r.status_code, r.content, r.error_msg
--   from public.crm_refund_notifications n
--   left join net._http_response r on r.id = n.request_id
--   order by n.id desc
--   limit 20;
--
-- REENVIAR OS REEMBOLSOS QUE JÁ EXISTIAM (marcados antes desta migration —
-- o sistema de comissão não sabe deles). Rodar uma vez, depois do Vault:
--
--   select public.crm_refund_notify(id, 'upsert')
--   from public.crm_sales
--   where refunded_at is not null;
-- ------------------------------------------------------------
select
  to_regprocedure('public.crm_refund_notify(uuid, text)') is not null as funcao_ok,
  exists (select 1 from pg_trigger where tgname = 'crm_sales_refund_webhook') as trigger_venda_ok,
  exists (select 1 from pg_trigger where tgname = 'crm_contacts_refund_webhook_channel') as trigger_contato_ok,
  exists (select 1 from vault.decrypted_secrets where name = 'lovable_refund_token') as token_no_vault;
