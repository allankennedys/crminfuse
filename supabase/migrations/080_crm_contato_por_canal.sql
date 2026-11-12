-- ============================================================
-- O contato daquele número NAQUELE canal — duplicando de outro canal
--
-- O caso que motivou: a venda manual do CRM (068) lançada para um cliente
-- que já existe, mas com o canal do lançamento diferente do canal do
-- cadastro. Até aqui a tela TROCAVA o canal do contato, e trocar significa
-- uma de duas coisas ruins:
--
--   • o número já tem cadastro no canal de destino → índice único da 069
--     (idx_crm_contacts_numero_canal_unico) devolve 409, a venda não entra;
--   • não tem → o cadastro MUDA de canal, e o histórico do canal antigo
--     (leads, conversas, relatório por canal) passa a mentir sobre o
--     passado.
--
-- A regra que este arquivo implementa é a que o produto já usa em todo o
-- resto: UM cadastro por (número, canal). Cliente que comprou pelo outro
-- WhatsApp ganha o cadastro dele naquele canal, criado a partir do que já
-- existe — com os dados de anúncio junto, senão a venda nasceria órfã de
-- atribuição e a Meta nunca saberia dela (crm_is_ad_contact, 071).
--
-- O QUE VIAJA PARA O CADASTRO NOVO
--
--   • identidade: nome, telefone, e-mail, etiquetas, descrição;
--   • anúncio de Click-to-WhatsApp: ctwaclid e source_id;
--   • anúncio de site: fbc, fbp, client_ip, user_agent, landing_url,
--     campaign_id, adset_id, ad_id — INTEIRO ou nada, a mesma regra da 073
--     e da 077: fbc de uma visita ao lado do campaign_id de outra atribui a
--     venda à campanha errada com toda a aparência de estar certa. Aqui sai
--     de graça, porque o cadastro novo nasce vazio.
--
-- O QUE NÃO VIAJA
--
--   • conversation_id — é único por organização (013), e o vínculo com o bot
--     é do cadastro que conversa naquele canal;
--   • sales_count / sales_total_cents / value_cents — dinheiro é do cadastro
--     que registrou a venda; o novo começa zerado e a trigger da 040 cuida;
--   • assigned_to — o responsável é lido pelo canal (064); herdar o vendedor
--     do outro WhatsApp é justamente o erro que aquele relatório evita;
--   • stage_id — vem no argumento (null = fora do funil, que é como a venda
--     manual cria: quem leva à etapa de conversão é a trigger).
--
-- A CONVERSÃO NA META NÃO DUPLICA
--
-- A trava da 072 é por VENDA (sale_id com evento de status <> 'skipped'),
-- não por contato. O cadastro novo tem venda nova: o Purchase que ele gera
-- é uma compra que de fato aconteceu. Dois cadastros com o mesmo ctwa_clid
-- não reenviam nada um do outro.
--
-- O RELATÓRIO DE ADS PASSA A CONTAR DOIS LEADS
--
-- Consequência aceita, e por isso está escrita aqui: crm_report_ads_* conta
-- lead por contato criado na janela, então o cliente que compra pelos dois
-- WhatsApps aparece duas vezes. É o preço de ter o canal certo em cada
-- venda; o rastro fica na descrição do cadastro novo, para quem for
-- conferir saber de onde ele veio.
--
-- ORDEM DE DEPLOY: esta migration ANTES do frontend. A tela nova chama
-- crm_contact_for_channel; sem a função, lançar venda com canal diferente
-- quebra. Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

-- ------------------------------------------------------------
-- 1. QUEM JÁ OCUPA (telefone, canal)
--
-- A pergunta da tela de contato antes de trocar o canal: "existe outro
-- cadastro deste número no canal para onde estou indo?". É a mesma chave do
-- índice único da 069 — crm_phone_id para o número, crm_channel_key para o
-- canal —, porque uma segunda definição de "mesmo número" divergiria dela em
-- seis meses e a tela passaria a prometer o que o banco recusa.
--
-- INVOKER, não security definer: a resposta é o nome de um contato, e quem
-- não enxerga aquele contato pela RLS (crm.contatos.ver, 055) não pode passar
-- a enxergar por aqui. Sem permissão de ver, devolve nada — e a tela cai na
-- mensagem genérica, que é o comportamento correto.
--
-- Só para o painel, por isso a organização vem de current_org_id() e não de
-- argumento: service role passaria RLS por cima e a função devolveria contato
-- de qualquer organização. Se um dia a Edge Function precisar disto, o
-- caminho é acrescentar p_org — não afrouxar aqui.
-- ------------------------------------------------------------
create or replace function public.crm_channel_conflict(
  p_phone   text,
  p_channel text default null,
  p_ignore  uuid default null
)
returns table(contact_id uuid, contact_name text, sales_count int, channel text)
language sql stable set search_path = public as $$
  select c.id, c.name, coalesce(c.sales_count, 0), c.channel
  from public.crm_contacts c
  where c.organization_id = public.current_org_id()
    and (p_ignore is null or c.id <> p_ignore)
    and public.crm_phone_id(c.phone) is not null
    and public.crm_phone_id(c.phone) = public.crm_phone_id(p_phone)
    and public.crm_channel_key(c.channel)
        is not distinct from public.crm_channel_key(p_channel)
  order by (coalesce(c.sales_count, 0) > 0) desc, c.created_at
  limit 1;
$$;

comment on function public.crm_channel_conflict(text, text, uuid) is
  'O contato que já ocupa (número, canal) — a chave do índice único da 069 —, '
  'ignorando o cadastro informado. É o que a tela pergunta antes de trocar o '
  'canal de um contato. Roda com os direitos de quem chama, na organização de '
  'quem chama: contato invisível pela RLS não é revelado aqui.';

revoke all on function public.crm_channel_conflict(text, text, uuid) from public;
grant execute on function public.crm_channel_conflict(text, text, uuid) to authenticated;

-- ------------------------------------------------------------
-- 2. DE QUAL CADASTRO COPIAR
--
-- Entre os cadastros do mesmo número em outros canais, o que tem anúncio
-- ganha — é o dado que a venda nova precisa para ser atribuível. Só depois
-- vem venda registrada, origem preenchida e, por último, o mais antigo.
--
-- POR QUE NÃO REUSAR O DESEMPATE DA 069. crm_contact_by_phone existe para
-- responder "quem é o DONO do número" e começa pelo dinheiro. Aqui a
-- pergunta é outra: "de quem copio o clique". E o critério "mais antigo"
-- sozinho eleger ia a carcaça da importação (created_at 2025-01-01, sem
-- anúncio e sem venda) em vez do cliente de verdade — com anúncio no topo,
-- ela perde.
-- ------------------------------------------------------------
create or replace function public.crm_contact_copy_source(p_org uuid, p_phone text)
returns public.crm_contacts
language sql stable set search_path = public as $$
  select c.*
  from public.crm_contacts c
  where c.organization_id = p_org
    and public.crm_phone_id(c.phone) is not null
    and public.crm_phone_id(c.phone) = public.crm_phone_id(p_phone)
  order by
    public.crm_is_ad_contact(c.ctwaclid, c.fbc, c.campaign_id, c.origem) desc,
    (coalesce(c.sales_count, 0) > 0) desc,
    (nullif(btrim(coalesce(c.origem, '')), '') is not null) desc,
    c.created_at
  limit 1;
$$;

comment on function public.crm_contact_copy_source(uuid, text) is
  'O cadastro do número de onde copiar ao abrir um contato em outro canal: '
  'anúncio primeiro, depois venda, origem e idade. Não confundir com '
  'crm_contact_by_phone (069), que responde quem é o dono do número.';

revoke all on function public.crm_contact_copy_source(uuid, text) from public;
grant execute on function public.crm_contact_copy_source(uuid, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 3. GARANTE O CONTATO DAQUELE NÚMERO NAQUELE CANAL
--
-- Irmã da crm_contact_claim (069) e com o MESMO advisory lock — a chave é
-- (organização, número), sem o canal, para que as duas nunca corram uma
-- contra a outra no mesmo cliente. A diferença está no que fazem quando o
-- número existe mas naquele canal não: a claim cria um cadastro pelado,
-- esta copia o que já se sabe do cliente.
--
-- A ORDEM DAS TRÊS RESPOSTAS
--
--   1. tem cadastro no canal exato        → é ele, ninguém cria nada;
--   2. tem cadastro de canal DESCONHECIDO → adota: grava o canal nele.
--      Mesma regra da claim ("canal desconhecido que agora tem nome"), e é
--      o que impede o cadastro cego de virar duplicata a cada canal novo;
--   3. tem cadastro em outro canal        → duplica a partir do melhor.
--
-- Sem nenhum dos três, é cliente novo: insere com o que veio da tela.
-- ------------------------------------------------------------
create or replace function public.crm_contact_for_channel(
  p_org      uuid default null,
  p_phone    text default null,
  p_channel  text default null,
  p_name     text default null,
  p_stage_id uuid default null,
  p_origem   text default null
)
returns table(contact_id uuid, created boolean, copied_from uuid, matched_by text)
language plpgsql security definer set search_path = public as $$
declare
  v_org    uuid;
  v_num    text;
  v_chan   text := nullif(btrim(coalesce(p_channel, '')), '');
  v_name   text := nullif(btrim(coalesce(p_name, '')), '');
  v_origem text := nullif(btrim(coalesce(p_origem, '')), '');
  v_hit    public.crm_contacts;
  v_src    public.crm_contacts;
  v_phone  text;
  v_trilha text;
  v_id     uuid;
begin
  -- As duas portas da 069, palavra por palavra: service role traz a
  -- organização no argumento, usuário do painel usa a dele e precisa da
  -- permissão de editar contatos — criar cadastro é editar contato.
  if auth.uid() is null then
    v_org := p_org;
    if v_org is null then
      raise exception 'Informe a organização do contato';
    end if;
  else
    v_org := public.current_org_id();
    if p_org is not null and p_org is distinct from v_org then
      raise exception 'Contato de outra organização';
    end if;
    if not public.current_user_can('crm.contatos.editar') then
      raise exception 'Sem permissão para criar contatos';
    end if;
  end if;

  v_num := public.crm_phone_id(coalesce(p_phone, ''));
  if v_num is null then
    raise exception 'Informe o telefone: sem número não há como saber se o cliente já tem cadastro neste canal';
  end if;

  -- Mesma fila da claim (069): procurar e inserir com o lock na mão é o que
  -- fecha a brecha entre os dois passos.
  perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':' || v_num, 0));

  -- 1. o canal exato já tem dono.
  select * into v_hit from public.crm_contact_by_phone(v_org, p_phone, v_chan, true);
  if v_hit.id is not null then
    -- Origem digitada na venda vale no cadastro quando ele ainda não tem uma.
    -- Não sobrescreve: quem já tem origem gravada foi classificado antes.
    if v_origem is not null then
      update public.crm_contacts
         set origem = v_origem
       where id = v_hit.id
         and nullif(btrim(coalesce(origem, '')), '') is null;
    end if;
    return query select v_hit.id, false, null::uuid, 'canal'::text;
    return;
  end if;

  -- 2. o cadastro cego vira o cadastro deste canal.
  if v_chan is not null then
    select * into v_hit from public.crm_contact_by_phone(v_org, p_phone, null, true);
    if v_hit.id is not null then
      update public.crm_contacts
         set channel = v_chan,
             origem  = case
               when v_origem is not null
                and nullif(btrim(coalesce(origem, '')), '') is null then v_origem
               else origem end
       where id = v_hit.id;
      return query select v_hit.id, false, null::uuid, 'canal-em-branco'::text;
      return;
    end if;
  end if;

  -- 3. existe em outro canal: o cadastro deste canal nasce a partir dele.
  select * into v_src from public.crm_contact_copy_source(v_org, p_phone);

  if v_src.id is null and v_name is null then
    raise exception 'name é obrigatório para criar um contato novo';
  end if;

  -- O número guardado é o desta venda, na forma que o bot disca (55 na
  -- frente quando vem local) — a mesma normalização da claim.
  v_phone := (select nullif(
    case when length(d.v) in (10, 11) then '55' || d.v else d.v end, '')
    from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as v) d);

  if v_src.id is not null then
    v_trilha := 'Cadastro deste cliente no canal '
      || coalesce(v_chan, 'não informado')
      || ', aberto a partir de "' || v_src.name || '" (canal '
      || coalesce(v_src.channel, 'não informado') || ') em '
      || to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY') || '.';
  end if;

  begin
    insert into public.crm_contacts (
      organization_id, name, phone, channel, stage_id, origem,
      email, description, tags, ctwaclid, source_id,
      fbc, fbp, client_ip, user_agent, landing_url, campaign_id, adset_id, ad_id,
      created_by
    ) values (
      v_org,
      coalesce(v_name, v_src.name),
      v_phone,
      v_chan,
      p_stage_id,
      coalesce(v_origem, v_src.origem),
      v_src.email,
      case
        when v_trilha is null then null
        when nullif(btrim(coalesce(v_src.description, '')), '') is null then v_trilha
        else v_src.description || E'\n\n' || v_trilha
      end,
      coalesce(v_src.tags, '{}'),
      v_src.ctwaclid,
      v_src.source_id,
      -- O bloco do site viaja inteiro (073/077): oito campos da MESMA visita.
      v_src.fbc, v_src.fbp, v_src.client_ip, v_src.user_agent,
      v_src.landing_url, v_src.campaign_id, v_src.adset_id, v_src.ad_id,
      auth.uid()
    )
    returning id into v_id;
  exception when unique_violation then
    -- Alguém abriu o cadastro deste canal por fora entre o lookup e o insert.
    -- O pedido era "garanta que existe": ele existe, devolve o que está lá.
    select * into v_hit from public.crm_contact_by_phone(v_org, p_phone, v_chan, true);
    if v_hit.id is null then raise; end if;
    return query select v_hit.id, false, null::uuid, 'canal'::text;
    return;
  end;

  return query select
    v_id,
    true,
    v_src.id,
    case when v_src.id is null then 'novo' else 'copiado' end::text;
end;
$$;

comment on function public.crm_contact_for_channel(uuid, text, text, text, uuid, text) is
  'Garante UM cadastro do número naquele canal: devolve o que existe, adota o '
  'de canal em branco ou duplica o de outro canal levando identidade e dados '
  'de anúncio (ctwa_clid, source_id e o bloco do site inteiro). Mesmo '
  'advisory lock da crm_contact_claim (069) — as duas nunca correm juntas.';

revoke all on function public.crm_contact_for_channel(uuid, text, text, text, uuid, text) from public;
grant execute on function public.crm_contact_for_channel(uuid, text, text, text, uuid, text) to authenticated, service_role;
