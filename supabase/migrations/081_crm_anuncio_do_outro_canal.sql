-- ============================================================
-- O anúncio do cliente viaja para o cadastro do outro canal — SEMPRE
--
-- A 080 já fazia isto, mas só no caminho da venda manual: quem lança uma
-- venda para um cliente que existe em outro canal ganha um cadastro novo com
-- ctwa_clid e o bloco do site junto. O caminho que roda sozinho o dia
-- inteiro — o upsert da crm-api, chamado pela automação a cada passo da
-- conversa — usa a crm_contact_claim (069), que insere um cadastro pelado:
-- organização, nome, telefone, conversa, etapa, origem e canal. Nada de
-- anúncio.
--
-- O RESULTADO QUE ISTO CONSERTA
--
-- Cliente clicou no anúncio e falou com o WhatsApp da PH: cadastro com
-- ctwa_clid, atribuível. Semanas depois escreve para o WhatsApp do Pedro
-- (organicamente, porque já é cliente). O cadastro do canal do Pedro nasce
-- sem nada, e a venda que sair dali é órfã: não vira Purchase atribuído na
-- Meta e não entra na receita por campanha. O anúncio pagou por essa venda e
-- o relatório nunca soube.
--
-- A REGRA
--
--   herda os dados de anúncio do melhor cadastro do MESMO número em outro
--   canal, A MENOS QUE o cadastro já tenha vindo com dados de anúncio
--   próprios.
--
-- "Dados próprios" é medido DEPOIS que a chamada gravou o que trouxe: a
-- crm-api cria o contato (claim) e só então aplica o patch com ctwaclid e o
-- bloco do site. Por isso a herança é o último passo antes da venda, e não
-- parte da criação — perguntar antes do patch responderia "não tem anúncio"
-- para todo lead que está justamente chegando com o anúncio dele.
--
-- O QUE CONTA COMO DADO PRÓPRIO (crm_contact_has_ad_data)
--
-- Os seis campos que são SINAL DE ANÚNCIO: ctwaclid, source_id, fbc,
-- campaign_id, adset_id, ad_id. Fora da lista, de propósito: fbp, client_ip,
-- user_agent e landing_url. Eles são a mobília da visita — a landing os
-- captura de todo visitante, inclusive do orgânico —, e tratá-los como
-- anúncio faria todo lead que passou pelo site nunca herdar nada.
--
-- TUDO OU NADA, como na 073, na 077 e na 080. Herdando, os DEZ campos vão
-- juntos, inclusive por cima de um fbp/client_ip que o cadastro já tivesse:
-- fbc de uma visita ao lado do campaign_id de outra atribui a venda à
-- campanha errada com toda a aparência de estar certa. É a mesma pessoa nos
-- dois cadastros, então ip e user-agent herdados continuam servindo ao
-- casamento na Meta.
--
-- O QUE NÃO VIAJA: origem. Ela é a classificação de COMO ESTA conversa
-- começou, e quem a escreveu foi a automação deste canal. Um cliente pode
-- ter chegado por anúncio lá e por indicação aqui; herdar o clique não
-- reescreve isso.
--
-- SÓ ENQUANTO O CADASTRO É RECÉM-NASCIDO (15 minutos)
--
-- A janela existe para proteger o passado. Sem ela, um upsert qualquer em
-- 2027 daria anúncio a um contato orgânico criado em 2025 — e o relatório de
-- ADS conta lead por created_at, então aquele contato apareceria
-- retroativamente como lead de anúncio numa janela já fechada e já lida. A
-- herança é um dado do nascimento do cadastro; passado o parto, o que muda
-- atribuição de contato antigo é a fusão (077), na mão e com dono.
--
-- Quinze minutos e não "só no created=true" porque o upsert é reenviado: se
-- a primeira chamada criar o contato e falhar depois, o reenvio encontra o
-- cadastro já existente e, com a herança presa à criação, ele ficaria sem
-- atribuição para sempre.
--
-- QUANDO O ANÚNCIO DE VERDADE CHEGA DEPOIS (crm_contact_drop_inherited_ads)
--
-- Cadastro herdou às 10:00 e às 10:05 a automação manda o ctwa_clid deste
-- canal: gravar por cima do ctwaclid herdado deixaria o clique novo ao lado
-- do campaign_id velho — a mistura que o "tudo ou nada" existe para impedir.
-- Então a crm-api limpa o bloco herdado ANTES do patch, sempre que a chamada
-- traz sinal de anúncio. Sem marca de herança, não faz nada: dado próprio
-- nunca é apagado aqui.
--
-- O PREÇO, ESCRITO AQUI PARA NINGUÉM DESCOBRIR SOZINHO
--
-- crm_report_ads_* conta lead por contato de anúncio criado na janela. O
-- cliente que volta pelo outro WhatsApp passa a entrar como um segundo lead
-- de anúncio — o CPL do relatório sobe sem ninguém ter clicado duas vezes.
-- É o mesmo preço que a 080 já aceitou para a venda manual, agora no volume
-- da automação. A coluna ads_inherited_from é o que torna isso reversível:
-- com ela dá para excluir o lead herdado da contagem sem perder a receita
-- atribuída. Se for o caminho escolhido, o lugar é a CTE `ads` das três
-- funções de relatório (052/071) — não desfazer a herança.
--
-- ORDEM DE DEPLOY: esta migration → crm-api → frontend. A Edge Function nova
-- chama crm_contact_inherit_ads; sem a função no banco, todo upsert quebra.
-- Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

-- ------------------------------------------------------------
-- 1. DE ONDE VEIO A ATRIBUIÇÃO DESTE CADASTRO
--
-- null = o clique é dele. Preenchido = foi copiado do cadastro apontado,
-- porque este aqui nasceu sem nada. É o que separa "lead de anúncio" de
-- "cliente de anúncio que voltou por outro número" em qualquer relatório
-- futuro, e é o que autoriza a limpeza quando o anúncio de verdade chega.
--
-- on delete set null: a fusão (077) apaga o cadastro que sobe. Perder o
-- ponteiro é aceitável — perder o contato por causa do ponteiro, não.
-- ------------------------------------------------------------
alter table public.crm_contacts
  add column if not exists ads_inherited_from uuid
    references public.crm_contacts(id) on delete set null;

comment on column public.crm_contacts.ads_inherited_from is
  'Cadastro do mesmo número em outro canal de onde os dados de anúncio foram '
  'copiados (081), porque este nasceu sem nenhum. null = a atribuição é dele. '
  'Existe para o relatório poder separar lead novo de cliente que voltou por '
  'outro WhatsApp, e para a limpeza quando o anúncio próprio chega depois.';

-- Sem índice, apagar um contato varre a tabela inteira pela FK.
create index if not exists idx_crm_contacts_ads_inherited_from
  on public.crm_contacts(ads_inherited_from)
  where ads_inherited_from is not null;

-- ------------------------------------------------------------
-- 2. O CADASTRO TEM ANÚNCIO PRÓPRIO?
--
-- Não confundir com crm_is_ad_contact (052/071), que responde "este contato
-- veio de anúncio" e por isso inclui a origem declarada. Aqui a pergunta é
-- outra e mais estreita: "existe DADO de atribuição gravado neste cadastro"
-- — origem é rótulo digitado, não atribui venda nenhuma, e um contato com
-- origem "Instagram Ads" e nenhum clique é exatamente quem mais precisa
-- herdar.
-- ------------------------------------------------------------
create or replace function public.crm_contact_has_ad_data(c public.crm_contacts)
returns boolean
language sql immutable set search_path = public as $$
  select coalesce(c.ctwaclid, '')    <> ''
      or coalesce(c.source_id, '')   <> ''
      or coalesce(c.fbc, '')         <> ''
      or coalesce(c.campaign_id, '') <> ''
      or coalesce(c.adset_id, '')    <> ''
      or coalesce(c.ad_id, '')       <> '';
$$;

comment on function public.crm_contact_has_ad_data(public.crm_contacts) is
  'true quando o cadastro tem sinal de anúncio GRAVADO nele: ctwaclid, '
  'source_id, fbc, campaign_id, adset_id ou ad_id. fbp/client_ip/user_agent/'
  'landing_url ficam de fora — a landing os captura de todo visitante, '
  'inclusive do orgânico. Não é a crm_is_ad_contact (052/071), que decide o '
  'envio à Meta e conta a origem declarada.';

-- ------------------------------------------------------------
-- 3. DE QUAL CADASTRO COPIAR — agora sabendo ignorar a si mesmo
--
-- Mesma função da 080, mesma ordem de desempate (anúncio, venda, origem,
-- idade), com um argumento a mais: a herança acontece DEPOIS do insert, e
-- sem o p_ignore o cadastro recém-criado seria candidato a fonte de si
-- próprio. Recriada em vez de sobrecarregada porque duas versões com o mesmo
-- nome deixariam a chamada de dois argumentos ambígua.
-- ------------------------------------------------------------
drop function if exists public.crm_contact_copy_source(uuid, text);

create or replace function public.crm_contact_copy_source(
  p_org    uuid,
  p_phone  text,
  p_ignore uuid default null
)
returns public.crm_contacts
language sql stable set search_path = public as $$
  select c.*
  from public.crm_contacts c
  where c.organization_id = p_org
    and (p_ignore is null or c.id <> p_ignore)
    and public.crm_phone_id(c.phone) is not null
    and public.crm_phone_id(c.phone) = public.crm_phone_id(p_phone)
  order by
    public.crm_is_ad_contact(c.ctwaclid, c.fbc, c.campaign_id, c.origem) desc,
    (coalesce(c.sales_count, 0) > 0) desc,
    (nullif(btrim(coalesce(c.origem, '')), '') is not null) desc,
    c.created_at
  limit 1;
$$;

comment on function public.crm_contact_copy_source(uuid, text, uuid) is
  'O cadastro do número de onde copiar ao abrir um contato em outro canal: '
  'anúncio primeiro, depois venda, origem e idade. p_ignore tira o próprio '
  'cadastro da disputa (081). Não confundir com crm_contact_by_phone (069), '
  'que responde quem é o dono do número.';

revoke all on function public.crm_contact_copy_source(uuid, text, uuid) from public;
grant execute on function public.crm_contact_copy_source(uuid, text, uuid)
  to authenticated, service_role;

-- ------------------------------------------------------------
-- 4. HERDA O ANÚNCIO DO OUTRO CANAL
--
-- Idempotente e auto-guardada: chamar duas vezes, ou chamar para um contato
-- que não devia herdar, não faz nada. Quem chama não precisa saber a regra —
-- ela mora aqui, num lugar só.
--
-- Devolve o cadastro de onde copiou, ou null quando não copiou (já tinha
-- anúncio, já passou da janela, não tem telefone, ou não há irmão com
-- anúncio). Não distingue os casos de propósito: para quem chama, todos
-- significam "não há o que fazer".
--
-- security definer com as duas portas da 069/080: service role manda de
-- fora, usuário do painel precisa ser da organização do contato e ter
-- permissão de editar contatos.
-- ------------------------------------------------------------
create or replace function public.crm_contact_inherit_ads(p_contact uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_c   public.crm_contacts;
  v_src public.crm_contacts;
begin
  select * into v_c from public.crm_contacts where id = p_contact;
  if not found then
    raise exception 'Contato não encontrado';
  end if;

  if auth.uid() is not null then
    if v_c.organization_id is distinct from public.current_org_id() then
      raise exception 'Contato de outra organização';
    end if;
    if not public.current_user_can('crm.contatos.editar') then
      raise exception 'Sem permissão para editar contatos';
    end if;
  end if;

  -- Veio com anúncio próprio: é dele, não se toca.
  if public.crm_contact_has_ad_data(v_c) then
    return null;
  end if;

  -- Fora da janela do nascimento: ver o cabeçalho. Mexer aqui reescreve
  -- relatório de ADS já fechado.
  if now() - v_c.created_at > interval '15 minutes' then
    return null;
  end if;

  -- Sem número não há como saber que é o mesmo cliente.
  if public.crm_phone_id(coalesce(v_c.phone, '')) is null then
    return null;
  end if;

  select * into v_src
  from public.crm_contact_copy_source(v_c.organization_id, v_c.phone, v_c.id);

  if v_src.id is null or not public.crm_contact_has_ad_data(v_src) then
    return null;
  end if;

  -- Os dez juntos: o bloco é de uma visita só (073/077/080).
  update public.crm_contacts set
    ctwaclid    = v_src.ctwaclid,
    source_id   = v_src.source_id,
    fbc         = v_src.fbc,
    fbp         = v_src.fbp,
    client_ip   = v_src.client_ip,
    user_agent  = v_src.user_agent,
    landing_url = v_src.landing_url,
    campaign_id = v_src.campaign_id,
    adset_id    = v_src.adset_id,
    ad_id       = v_src.ad_id,
    ads_inherited_from = v_src.id
  where id = v_c.id;

  return v_src.id;
end;
$$;

comment on function public.crm_contact_inherit_ads(uuid) is
  'Copia os dados de anúncio do melhor cadastro do mesmo número em outro '
  'canal para este, quando ele nasceu sem nenhum (081). Devolve a fonte, ou '
  'null quando não havia o que fazer. Só nos primeiros 15 minutos de vida do '
  'cadastro: depois disso, mexer na atribuição reescreve o passado.';

revoke all on function public.crm_contact_inherit_ads(uuid) from public;
grant execute on function public.crm_contact_inherit_ads(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 5. DEVOLVE O CADASTRO AO ESTADO SEM ANÚNCIO
--
-- Chamada ANTES de gravar um anúncio que chegou depois da herança. Só age
-- sobre bloco herdado (ads_inherited_from preenchido): dado próprio nunca é
-- apagado por aqui, e é isso que faz esta função poder ser chamada sem medo
-- a cada upsert que traz atribuição.
-- ------------------------------------------------------------
create or replace function public.crm_contact_drop_inherited_ads(p_contact uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.crm_contacts where id = p_contact;
  if not found then
    raise exception 'Contato não encontrado';
  end if;

  if auth.uid() is not null then
    if v_org is distinct from public.current_org_id() then
      raise exception 'Contato de outra organização';
    end if;
    if not public.current_user_can('crm.contatos.editar') then
      raise exception 'Sem permissão para editar contatos';
    end if;
  end if;

  update public.crm_contacts set
    ctwaclid = null, source_id = null,
    fbc = null, fbp = null, client_ip = null, user_agent = null,
    landing_url = null, campaign_id = null, adset_id = null, ad_id = null,
    ads_inherited_from = null
  where id = p_contact
    and ads_inherited_from is not null;

  return found;
end;
$$;

comment on function public.crm_contact_drop_inherited_ads(uuid) is
  'Apaga o bloco de anúncio HERDADO (081) de um cadastro, para o anúncio '
  'próprio que chegou depois entrar limpo em vez de se misturar com o do '
  'outro canal. Não toca em cadastro cuja atribuição é dele. true = limpou.';

revoke all on function public.crm_contact_drop_inherited_ads(uuid) from public;
grant execute on function public.crm_contact_drop_inherited_ads(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 6. A 080 PASSA A MARCAR O QUE COPIA
--
-- Corpo idêntico ao da 080 — a única mudança é ads_inherited_from no insert,
-- para que o cadastro aberto pela venda manual e o aberto pela automação
-- fiquem indistinguíveis para quem for ler o relatório depois. Recriada
-- inteira porque o corpo de uma função é texto: não há como remendar só a
-- linha do insert.
--
-- A marca só vale quando há anúncio de verdade na fonte: copiar nome e
-- e-mail de um cadastro sem clique nenhum não é herança de atribuição.
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
      ads_inherited_from, created_by
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
      -- A marca da 081: atribuição copiada não é clique deste cadastro.
      case when public.crm_contact_has_ad_data(v_src) then v_src.id end,
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
  'de anúncio (ctwa_clid, source_id e o bloco do site inteiro), marcando a '
  'herança em ads_inherited_from (081). Mesmo advisory lock da '
  'crm_contact_claim (069) — as duas nunca correm juntas.';

revoke all on function public.crm_contact_for_channel(uuid, text, text, text, uuid, text) from public;
grant execute on function public.crm_contact_for_channel(uuid, text, text, text, uuid, text)
  to authenticated, service_role;
