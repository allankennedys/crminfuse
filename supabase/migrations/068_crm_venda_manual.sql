-- ============================================================
-- Venda lançada à mão: avisar o n8n depois de gravar
--
-- O vendedor lança a venda pela tela inicial do CRM (botão "Lançar venda").
-- Gravar continua sendo insert em crm_sales — toda a regra de negócio já
-- mora lá (031): a 1ª venda move o contato para a etapa de conversão, a
-- recompra só soma. O que falta é avisar o n8n, e é o que este arquivo faz.
--
-- POR QUE PELO BANCO, E NÃO PELO NAVEGADOR
--
-- O webhook do n8n não responde CORS por padrão: um fetch do painel morre no
-- preflight e a venda ficaria gravada sem ninguém do outro lado saber — a
-- pior falha possível aqui, porque é silenciosa. Pelo pg_net a chamada sai
-- do servidor, sem navegador no caminho, do mesmo jeito que o worker da Meta
-- (043) e a busca de grupos (067) já fazem.
--
-- ENTREGA É ASSÍNCRONA
--
-- net.http_post ENFILEIRA e devolve na hora o id da requisição; quem manda de
-- fato é o processo de background do pg_net. Por isso a RPC não tem como
-- prometer que o n8n recebeu — ela devolve o id, e crm_sale_webhook_status()
-- responde depois o que aconteceu. A tela consulta uma vez, alguns segundos
-- depois, só para avisar quando o n8n recusou. Sem retry próprio: se o
-- webhook cair, a venda está gravada e o reenvio é do n8n.
--
-- O QUE VAI NO CORPO
--
-- A venda, o contato inteiro e o que só o banco sabe responder: se esta é a
-- PRIMEIRA compra do cliente. Não é o `sales_count` do contato lido antes do
-- insert — é a posição desta venda na ordem canônica (sold_at, created_at,
-- id), a mesma que a trigger da 031 usa para decidir quem converte. Assim
-- uma venda lançada com data retroativa chega ao n8n marcada como primeira
-- se de fato passou a ser a primeira.
--
-- APLIQUE DEPOIS DA 069. O payload manda phone_id — a identidade do número,
-- que é a chave pela qual o n8n casa o contato com a conversa — e quem a
-- calcula é crm_phone_id(), criada lá. Aplicada antes, este arquivo entra sem
-- reclamar (plpgsql só resolve a chamada na primeira execução) e o webhook
-- estoura na primeira venda lançada, que é o pior momento para descobrir.
-- ============================================================

-- ------------------------------------------------------------
-- O aviso
--
-- security definer por dois motivos, os dois necessários: o schema net não é
-- acessível ao usuário autenticado, e o payload junta etapa, responsável e
-- autor — leituras que a RLS de cada tabela recusaria em cascata. Em troca, a
-- função checa na mão o que a RLS checaria: organização e permissão de venda.
-- ------------------------------------------------------------
create or replace function public.crm_sale_webhook(
  p_sale_id uuid,
  -- true quando o contato acabou de ser criado no mesmo lançamento. O banco
  -- não tem como deduzir isso depois (contato novo e contato antigo sem venda
  -- são indistinguíveis), então quem sabe é quem chamou.
  p_new_contact boolean default false
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  -- URL fixa, como a do worker da Meta na 043: é endereço de infraestrutura,
  -- não configuração de organização. Mudou o fluxo no n8n? Muda aqui.
  -- Infuse: a URL vem de integration_urls (041); sem cadastro, não envia.
  v_url  constant text := public.integration_url('n8n_venda_manual');
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
      -- casa o contato com a conversa. NÃO mande phone_key aqui: aquela é a
      -- coluna crua da 044, que ignora o 9 mas não o 55, então um contato
      -- cadastrado à mão como "48 99953-3582" chegaria ao n8n com uma chave
      -- que não bate com a do mesmo cliente vindo do WhatsApp.
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

  if v_url is null then
    return null;
  end if;

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
  'Envia a venda e o contato para o webhook de venda manual do n8n, marcando '
  'se é a primeira compra do cliente. Devolve o id da requisição do pg_net — '
  'o envio é assíncrono; consulte crm_sale_webhook_status() para o resultado.';

revoke all on function public.crm_sale_webhook(uuid, boolean) from public;
grant execute on function public.crm_sale_webhook(uuid, boolean) to authenticated;

-- ------------------------------------------------------------
-- "O n8n recebeu?"
--
-- Só o veredito: código, timeout e mensagem de erro. O corpo da resposta NÃO
-- é devolvido de propósito — net._http_response é uma tabela só, comum a
-- todas as chamadas do banco (Evolution, Meta), e devolver conteúdo daria a
-- qualquer autenticado uma janela para respostas que não são dele.
--
-- pending = ainda em voo (ou já limpo pelo pg_net, que apaga as respostas
-- depois de algumas horas). A tela trata isso como silêncio, não como falha.
-- ------------------------------------------------------------
create or replace function public.crm_sale_webhook_status(p_request_id bigint)
returns table(status_code int, timed_out boolean, error_msg text)
language sql
stable
security definer
set search_path = public
as $$
  select r.status_code, coalesce(r.timed_out, false), r.error_msg
  from net._http_response r
  where r.id = p_request_id;
$$;

comment on function public.crm_sale_webhook_status(bigint) is
  'Resultado da chamada do pg_net: nenhuma linha = ainda em voo. Sem o corpo '
  'da resposta, que é compartilhado com as outras chamadas do banco.';

revoke all on function public.crm_sale_webhook_status(bigint) from public;
grant execute on function public.crm_sale_webhook_status(bigint) to authenticated;
