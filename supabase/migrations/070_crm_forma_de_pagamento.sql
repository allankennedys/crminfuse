-- ============================================================
-- Forma de pagamento da venda
--
-- Pix, crédito, débito ou boleto. Guardado por VENDA, não por cliente: o
-- mesmo cliente paga a primeira no cartão e a recompra no pix, e é a venda
-- que precisa dizer como entrou o dinheiro.
--
-- LISTA FECHADA, e de propósito. Origem e canal são texto livre porque
-- nascem de fora (anúncio, campanha, número novo) e ninguém consegue prever a
-- lista; forma de pagamento é o oposto — são as quatro maneiras de receber, e
-- deixar livre só produziria "PIX", "pix ", "Pix Bradesco" e um relatório que
-- não fecha. O check recusa o resto.
--
-- Precisa de uma quinta (dinheiro, transferência)? É um comando só:
--
--   alter table public.crm_sales drop constraint crm_sales_payment_method_check;
--   alter table public.crm_sales add constraint crm_sales_payment_method_check
--     check (payment_method in ('pix','credito','debito','boleto','dinheiro'));
--
-- e o rótulo novo em PAYMENT_METHODS, no crmService.
--
-- NULO É "NÃO INFORMADA", e vai continuar existindo: toda venda anterior a
-- esta migration nasceu sem o campo, e as importadas do histórico (031) nunca
-- vão ter. Por isso a coluna é anulável — quem exige o preenchimento é o
-- formulário, para as vendas novas, não o banco, que teria que inventar um
-- valor para o passado.
--
-- Os valores são guardados sem acento e sem caixa ('credito', não "Crédito"):
-- rótulo é coisa de tela, e acento em chave de comparação é fonte de bug.
-- ============================================================

alter table public.crm_sales
  add column if not exists payment_method text;

do $$
begin
  alter table public.crm_sales
    add constraint crm_sales_payment_method_check
    check (payment_method in ('pix', 'credito', 'debito', 'boleto'));
exception when duplicate_object then
  -- Já existe: a migration é repetível.
  null;
end $$;

comment on column public.crm_sales.payment_method is
  'Como o cliente pagou: pix, credito, debito ou boleto. NULL = não '
  'informada (vendas anteriores à 070 e as importadas do histórico).';

-- Relatório por forma de pagamento vai varrer por período: o índice segue a
-- mesma ordem dos outros de venda (org + data).
create index if not exists idx_crm_sales_payment
  on public.crm_sales(organization_id, payment_method, sold_at desc)
  where payment_method is not null;

-- ------------------------------------------------------------
-- O webhook passa a levar a forma de pagamento
--
-- Mesma função da 068, com dois campos a mais no bloco "sale". Recriada
-- inteira porque no Postgres não existe "adicione uma linha ao corpo": o
-- create or replace substitui tudo.
--
--   payment_method        o valor guardado ('pix'), para o fluxo decidir
--   payment_method_label  o rótulo ('Pix'), para quem só repassa o texto
--
-- Os dois porque os consumidores são de dois tipos: quem faz `if` no valor e
-- quem escreve numa planilha ou numa mensagem. Sem o rótulo, cada fluxo do
-- n8n reinventaria o próprio de-para e um deles escreveria "credito" na
-- mensagem para o cliente.
-- ------------------------------------------------------------
create or replace function public.crm_sale_webhook(
  p_sale_id uuid,
  p_new_contact boolean default false
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url  constant text :=
    'https://n8n-n8n.40lgqg.easypanel.host/webhook/187a732f-81df-4cdb-903d-887f2591aed3-venda-manual';
  v_sale     public.crm_sales;
  v_contact  public.crm_contacts;
  v_stage    public.crm_stages;
  v_seq      int;
  v_total    int;
  v_author   text;
  v_assignee text;
  v_body     jsonb;
begin
  select * into v_sale from public.crm_sales where id = p_sale_id;
  if not found then
    raise exception 'Venda não encontrada';
  end if;

  -- As duas checagens que a RLS faria se esta função não fosse definer.
  if v_sale.organization_id is distinct from public.current_org_id() then
    raise exception 'Venda de outra organização';
  end if;
  if not public.current_user_can('crm.vendas.editar') then
    raise exception 'Sem permissão para lançar vendas';
  end if;

  select * into v_contact from public.crm_contacts where id = v_sale.contact_id;
  select * into v_stage from public.crm_stages where id = v_contact.stage_id;

  select count(*) into v_total
  from public.crm_sales where contact_id = v_sale.contact_id;

  -- Posição desta venda na vida do cliente. Comparação de tupla: é a mesma
  -- ordem (sold_at, created_at, id) da trigger de conversão e dos relatórios.
  select count(*) into v_seq
  from public.crm_sales s
  where s.contact_id = v_sale.contact_id
    and (s.sold_at, s.created_at, s.id) <= (v_sale.sold_at, v_sale.created_at, v_sale.id);

  select coalesce(nullif(trim(u.full_name), ''), u.email) into v_author
  from public.users u where u.id = v_sale.created_by;

  select coalesce(nullif(trim(u.full_name), ''), u.email) into v_assignee
  from public.users u where u.id = v_contact.assigned_to;

  v_body := jsonb_build_object(
    'event', 'venda_manual',
    'sent_at', now(),
    'organization_id', v_sale.organization_id,
    -- Os dois campos que respondem "é a primeira compra dele?" — o booleano
    -- para decidir e a posição para o caso de o fluxo querer saber a qual
    -- recompra se refere.
    'is_first_sale', v_seq = 1,
    'sale_number', v_seq,
    'new_contact', coalesce(p_new_contact, false),
    'sale', jsonb_build_object(
      'id', v_sale.id,
      'value_cents', v_sale.value_cents,
      -- Já em reais para o fluxo não ter que dividir por 100 do outro lado.
      'value', round(v_sale.value_cents::numeric / 100, 2),
      'creatives', v_sale.creatives,
      'sold_at', v_sale.sold_at,
      'note', v_sale.note,
      'payment_method', v_sale.payment_method,
      'payment_method_label', case v_sale.payment_method
        when 'pix'     then 'Pix'
        when 'credito' then 'Crédito'
        when 'debito'  then 'Débito'
        when 'boleto'  then 'Boleto'
        else null
      end,
      'created_at', v_sale.created_at,
      'created_by', v_sale.created_by,
      'created_by_name', v_author
    ),
    'contact', jsonb_build_object(
      'id', v_contact.id,
      'name', v_contact.name,
      'phone', v_contact.phone,
      -- A identidade do número (069): mesma forma para as quatro grafias que
      -- circulam — com/sem o 55, com/sem o 9 do celular. É por ela que o n8n
      -- casa o contato com a conversa.
      'phone_id', public.crm_phone_id(v_contact.phone),
      'email', v_contact.email,
      'channel', v_contact.channel,
      'origem', v_contact.origem,
      'source_id', v_contact.source_id,
      'ctwaclid', v_contact.ctwaclid,
      'conversation_id', v_contact.conversation_id,
      'tags', to_jsonb(v_contact.tags),
      'stage_id', v_contact.stage_id,
      'stage_name', v_stage.name,
      'stage_is_conversion', coalesce(v_stage.is_conversion, false),
      'assigned_to', v_contact.assigned_to,
      'assigned_to_name', v_assignee,
      'created_at', v_contact.created_at,
      -- Totais já recalculados pela trigger da 031 — incluem esta venda.
      'sales_count', v_total,
      'first_sale_value_cents', v_contact.value_cents,
      'sales_total_cents', v_contact.sales_total_cents,
      'sales_total', round(v_contact.sales_total_cents::numeric / 100, 2)
    )
  );

  return net.http_post(
    url := v_url,
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := v_body,
    -- 15s: o n8n pode estar acordando o workflow. O tempo é do processo de
    -- background do pg_net, não do vendedor — a tela não espera por isto.
    timeout_milliseconds := 15000
  );
end;
$$;

comment on function public.crm_sale_webhook(uuid, boolean) is
  'Envia a venda (com forma de pagamento) e o contato para o webhook de venda '
  'manual do n8n, marcando se é a primeira compra do cliente. Devolve o id da '
  'requisição do pg_net — o envio é assíncrono; consulte '
  'crm_sale_webhook_status() para o resultado.';

revoke all on function public.crm_sale_webhook(uuid, boolean) from public;
grant execute on function public.crm_sale_webhook(uuid, boolean) to authenticated;
