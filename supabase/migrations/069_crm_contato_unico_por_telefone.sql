-- ============================================================
-- Um contato por número POR CANAL, mesmo com duas automações escrevendo juntas
--
-- O QUE ESTÁ ACONTECENDO
--
-- O upsert da crm-api procura o contato e, não achando, insere. São dois
-- passos, em duas transações. Quando a IA e a outra automação atendem o mesmo
-- número ao mesmo tempo, as duas procuram antes de qualquer uma inserir: as
-- duas não acham nada e as duas inserem. Nasce o par.
--
-- Nenhuma checagem no meio do caminho resolve isso — só o banco pode decidir
-- quem chegou primeiro, porque só ele enxerga as duas transações.
--
-- O MESMO NÚMERO EM DOIS CANAIS NÃO É DUPLICATA
--
-- O cliente que fala com o WhatsApp da PH e com o do Pedro são dois cadastros
-- legítimos, um por canal — e é assim que os relatórios por canal fecham. A
-- chave do "mesmo contato" é, portanto, (organização, CANAL, número).
--
-- Canal em branco é canal DESCONHECIDO, não um canal à parte: o cadastro sem
-- canal casa com qualquer um. É o caso da automação que ainda não sabe por
-- onde o lead entrou — ela reaproveita o cadastro existente em vez de abrir um
-- terceiro, e o canal é preenchido no patch logo em seguida.
--
-- AS QUATRO PEÇAS
--
--   crm_phone_id()        a identidade do número: uma forma só para as
--                         quatro grafias que circulam (com/sem 55, com/sem o
--                         9 do celular).
--
--   crm_contact_claim()   procura e cria DENTRO da mesma transação, com um
--                         advisory lock na chave (organização + número). A
--                         segunda chamada espera a primeira terminar e já
--                         enxerga o que ela criou.
--
--   crm_merge_duplicate_contacts()  junta o que já está partido, por canal.
--
--   índice único          rede de segurança para os caminhos que não passam
--                         pelo claim (tela, SQL na mão). Só é criado se a
--                         base estiver limpa; ver o fim do arquivo.
--
-- O LOCK É POR NÚMERO, NÃO POR CANAL — de propósito. Se ele incluísse o
-- canal, a automação que manda "PH" e a que não manda canal nenhum pegariam
-- fechaduras diferentes, entrariam juntas e criariam o par assim mesmo. Preso
-- pelo número, quem chega depois enxerga o cadastro de quem chegou antes e
-- decide reaproveitar (mesmo canal, ou canal desconhecido) ou abrir o segundo
-- (canal declaradamente outro). São microssegundos de fila, e só entre duas
-- escritas do MESMO número.
--
-- QUEM GANHA QUANDO JÁ EXISTE MAIS DE UM
--
--   1. quem já tem venda;
--   2. quem está no canal pedido (contra o de canal desconhecido);
--   3. quem tem ORIGEM preenchida;
--   4. o mais antigo.
--
-- Origem entrou a pedido da operação, e é o critério que decide o caso real:
-- dois cadastros recém-criados pelas automações, nenhum com venda, um deles
-- com a origem que veio do anúncio. O de origem vazia é o cego.
--
-- VENDA CONTINUA NA FRENTE, DE PROPÓSITO. Devolver o cadastro sem venda
-- quando existe um com venda faz a PRÓXIMA venda contar como primeira: o
-- contato é movido para a conversão de novo e um segundo evento vai para a
-- Meta, que não tem como ser desfeito (028/033/044). A origem do outro lado é
-- copiada para o sobrevivente na fusão abaixo — ninguém perde origem por
-- causa desta ordem.
--
-- DEPENDE DA 044 (crm_phone_key) e da 055 (current_user_can).
-- ============================================================

-- ------------------------------------------------------------
-- 1. A IDENTIDADE DO NÚMERO
--
-- A 044 resolveu o 9 extra do celular, mas não o 55: "48 99953-3582" digitado
-- na tela e "5548999533582" vindo do WhatsApp continuavam sendo dois números
-- diferentes para o banco — e viravam dois contatos. Aqui as quatro grafias
-- colapsam numa só:
--
--   5548999533582  (WhatsApp, com 9)      ─┐
--   554899533582   (WhatsApp, sem 9)       ├─→  554899533582
--   48999533582    (digitado, com 9)       │
--   4899533582     (digitado, sem 9)      ─┘
--
-- 10 ou 11 dígitos = número brasileiro sem o país (DDD + 8 ou 9 dígitos): o 55
-- entra. Qualquer outro tamanho passa intacto — número estrangeiro de 12 ou 13
-- dígitos já vem com o país e não é tocado.
--
-- NÃO SUBSTITUI phone_key. Aquela coluna é gerada e materializada em disco;
-- trocar a regra dela exigiria reescrever a tabela e deixaria os valores
-- antigos inconsistentes no meio do caminho. Esta função é a chave de
-- COMPARAÇÃO, usada nas buscas, na fusão e no índice único.
-- ------------------------------------------------------------
create or replace function public.crm_phone_id(p_phone text)
returns text
language sql immutable set search_path = public as $$
  select public.crm_phone_key(
    case
      when length(d.v) in (10, 11) then '55' || d.v
      else d.v
    end
  )
  from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as v) d;
$$;

comment on function public.crm_phone_id(text) is
  'Identidade do número: mesma forma para as quatro grafias que circulam '
  '(com/sem o 55, com/sem o 9 do celular). É a chave de comparação de '
  '"mesmo contato" — phone_key (044) continua sendo a coluna materializada.';

-- ------------------------------------------------------------
-- 2. A CHAVE DO CANAL
--
-- Canal é texto livre digitado por gente e por automação: "PH Creative" e
-- "ph creative " são o mesmo canal. Sem caixa e sem espaço nas pontas, como o
-- agrupamento de origens (038) já faz. Vazio vira NULL — "não sei o canal" —,
-- e é isso que o resto do arquivo lê como "casa com qualquer um".
--
-- immutable de verdade (lower e btrim são): é o que permite usá-la no índice
-- único. Sem acento aqui, ao contrário das origens, justamente porque
-- unaccent() é stable e não entra em índice.
-- ------------------------------------------------------------
create or replace function public.crm_channel_key(p_channel text)
returns text
language sql immutable set search_path = public as $$
  select nullif(btrim(lower(coalesce(p_channel, ''))), '');
$$;

comment on function public.crm_channel_key(text) is
  'Canal reduzido à forma comparável (sem caixa, sem espaço nas pontas). '
  'NULL = canal desconhecido, que casa com qualquer canal.';

-- Busca por identidade do número sem varrer a tabela. Vale mesmo quando o
-- índice único não puder ser criado lá no fim.
create index if not exists idx_crm_contacts_phone_id
  on public.crm_contacts(organization_id, (public.crm_phone_id(phone)))
  where phone is not null;

-- ------------------------------------------------------------
-- 3. QUEM GANHA O DESEMPATE — definição única
--
-- Esta função é a resposta de "qual contato é o dono deste número neste
-- canal". Todo o resto (lookup, claim, fusão, a API) chama daqui em vez de
-- repetir o order by, que é como duas definições de "mesmo cliente"
-- nasceriam e divergiriam.
--
-- p_channel nulo = pergunta sem canal: entra qualquer cadastro do número, e o
-- desempate resolve. É o comportamento que a API sempre teve, preservado para
-- a automação que não manda canal.
--
-- p_strict = true exige o canal EXATO, sem aceitar o cadastro de canal
-- desconhecido. Só a fusão usa: quando o número aparece em dois canais, o
-- cadastro cego não pertence a nenhum dos dois com certeza, e deixá-lo entrar
-- faria a fusão engoli-lo pelo canal que fosse processado primeiro.
--
-- Assinatura nova, então as antigas caem antes: com duas vivas, uma chamada
-- de dois argumentos ficaria ambígua para o Postgres.
-- ------------------------------------------------------------
drop function if exists public.crm_contact_by_phone(uuid, text);
drop function if exists public.crm_contact_by_phone(uuid, text, text);

create or replace function public.crm_contact_by_phone(
  p_org uuid,
  p_phone text,
  p_channel text default null,
  p_strict boolean default false
)
returns setof public.crm_contacts
language sql stable set search_path = public as $$
  select c.*
  from public.crm_contacts c
  where c.organization_id = p_org
    and public.crm_phone_id(c.phone) is not null
    and public.crm_phone_id(c.phone) = public.crm_phone_id(p_phone)
    and (
      case
        -- Fusão com o número em mais de um canal: só o canal exato.
        when p_strict then
          public.crm_channel_key(c.channel) is not distinct from public.crm_channel_key(p_channel)
        -- Pergunta sem canal: qualquer cadastro do número serve.
        when public.crm_channel_key(p_channel) is null then true
        -- Canal pedido: ele e o cadastro de canal desconhecido. O contato do
        -- OUTRO canal é outra conversa — não pode ser devolvido aqui.
        else public.crm_channel_key(c.channel) is null
          or public.crm_channel_key(c.channel) = public.crm_channel_key(p_channel)
      end
    )
  order by
    -- 1. dinheiro registrado manda: ver o cabeçalho.
    (coalesce(c.sales_count, 0) > 0) desc,
    -- 2. o canal exato ganha do canal desconhecido.
    (public.crm_channel_key(c.channel) is not distinct from public.crm_channel_key(p_channel)) desc,
    -- 3. origem preenchida ganha do cadastro cego.
    (nullif(btrim(coalesce(c.origem, '')), '') is not null) desc,
    -- 4. e, por fim, o registro original do lead.
    c.created_at
  limit 1;
$$;

comment on function public.crm_contact_by_phone(uuid, text, text, boolean) is
  'Contato dono do número no canal informado, em qualquer grafia do telefone '
  '(crm_phone_id). Canal nulo = qualquer canal; p_strict exige o canal exato. '
  'Desempate: venda, canal exato, origem preenchida, mais antigo.';

-- ------------------------------------------------------------
-- 4. LOCALIZAR — pelo ID da conversa e, faltando ele, pelo telefone
--
-- Mesma ordem que a API usa desde sempre: conversation_id é exato, telefone é
-- a chave do negócio. Devolve também COMO achou, que é o que deixa a
-- automação (e o suporte) enxergarem por onde o contato foi reconhecido.
-- ------------------------------------------------------------
create or replace function public.crm_contact_lookup(
  p_org uuid,
  p_phone text default null,
  p_conversation_id text default null,
  p_channel text default null
)
returns table(contact_id uuid, matched_by text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if nullif(btrim(coalesce(p_conversation_id, '')), '') is not null then
    select c.id into v_id
    from public.crm_contacts c
    where c.organization_id = p_org
      and c.conversation_id = btrim(p_conversation_id);
    if v_id is not null then
      return query select v_id, 'conversation'::text;
      return;
    end if;
  end if;

  if public.crm_phone_id(coalesce(p_phone, '')) is not null then
    select c.id into v_id from public.crm_contact_by_phone(p_org, p_phone, p_channel) c;
    if v_id is not null then
      return query select v_id, 'phone'::text;
      return;
    end if;
  end if;
end;
$$;

comment on function public.crm_contact_lookup(uuid, text, text, text) is
  'Acha o contato pelo ID da conversa e, na falta dele, pelo telefone dentro '
  'do canal. Devolve por qual dos dois casou. Nenhuma linha = não existe.';

-- ------------------------------------------------------------
-- 5. CLAIM — procurar e criar sem brecha entre os dois
--
-- O advisory lock é o coração disto: tirado sobre (organização + número), não
-- sobre a tabela, então duas automações atendendo clientes diferentes não
-- esperam uma pela outra. `xact` = solto no fim da transação, sempre, mesmo
-- se a função estourar no meio.
--
-- Sem telefone o lock é o do ID da conversa — a outra chave única que existe.
-- Sem nenhum dos dois não há como reconhecer contato: insere direto, e não
-- duplicar é responsabilidade de quem chamou (é o "novo contato" digitado à
-- mão, com a lista de parecidos à vista na tela).
--
-- CONTEXTO DE SEGURANÇA. Duas portas, porque são dois chamadores:
--   • service role (Edge Function, auth.uid() nulo): a organização vem no
--     argumento — a chave de API já a resolveu antes de chegar aqui;
--   • usuário do painel: a organização é a dele, e precisa da permissão de
--     editar contatos. p_org de outra organização é recusado, não ignorado.
-- ------------------------------------------------------------
create or replace function public.crm_contact_claim(
  p_org uuid default null,
  p_phone text default null,
  p_conversation_id text default null,
  p_name text default null,
  p_stage_id uuid default null,
  p_origem text default null,
  p_channel text default null
)
returns table(contact_id uuid, created boolean, matched_by text)
language plpgsql security definer set search_path = public as $$
declare
  v_org  uuid;
  v_id_num text;
  v_conv text := nullif(btrim(coalesce(p_conversation_id, '')), '');
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_id   uuid;
  v_by   text;
begin
  if auth.uid() is null then
    -- Service role: sem usuário logado, a organização é a que veio.
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

  v_id_num := public.crm_phone_id(coalesce(p_phone, ''));

  -- A fila por número. Tudo daqui para baixo — procurar e inserir — acontece
  -- com este lock na mão, e é isso que fecha a brecha entre os dois passos.
  -- Sem o canal na chave, de propósito: ver o cabeçalho.
  if v_id_num is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':' || v_id_num, 0));
  elsif v_conv is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':conv:' || v_conv, 0));
  end if;

  select l.contact_id, l.matched_by into v_id, v_by
  from public.crm_contact_lookup(v_org, p_phone, v_conv, p_channel) l;

  if v_id is not null then
    -- Achou pelo telefone e agora veio o ID da conversa: grava-o se o contato
    -- ainda não tiver um. É como o cadastro criado sem ID recupera o vínculo
    -- com o bot. Com um ID diferente já gravado, não mexe — o índice único
    -- não deixaria, e sobrescrever seria perder o vínculo antigo.
    if v_conv is not null then
      update public.crm_contacts
         set conversation_id = v_conv
       where id = v_id and conversation_id is null;
    end if;
    -- Canal desconhecido que agora tem nome: preenche. É o que impede o
    -- cadastro cego de continuar casando com todos os canais para sempre.
    if public.crm_channel_key(p_channel) is not null then
      update public.crm_contacts
         set channel = btrim(p_channel)
       where id = v_id and public.crm_channel_key(channel) is null;
    end if;
    return query select v_id, false, v_by;
    return;
  end if;

  if v_name is null then
    raise exception 'name é obrigatório para criar um contato novo';
  end if;

  begin
    insert into public.crm_contacts (
      organization_id, name, phone, conversation_id, stage_id, origem, channel
    ) values (
      v_org,
      v_name,
      -- Guarda com o 55 quando vem número brasileiro local (10 ou 11 dígitos,
      -- o jeito que a pessoa digita na tela). O phone é o número que o bot vai
      -- discar e que o n8n casa com a conversa: sem o país ele não serve para
      -- nenhum dos dois. O 9 do celular fica como veio — quem o ignora é a
      -- chave de comparação, não o cadastro.
      (select nullif(
        case when length(d.v) in (10, 11) then '55' || d.v else d.v end, '')
       from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as v) d),
      v_conv,
      p_stage_id,
      nullif(btrim(coalesce(p_origem, '')), ''),
      nullif(btrim(coalesce(p_channel, '')), '')
    )
    returning id into v_id;
  exception when unique_violation then
    -- Alguém inseriu o mesmo número por um caminho que não passa por aqui
    -- (tela, SQL na mão) entre o lookup e este insert. Assume o que já está
    -- lá: o pedido era "garanta que este contato existe", e ele existe.
    select l.contact_id, l.matched_by into v_id, v_by
    from public.crm_contact_lookup(v_org, p_phone, v_conv, p_channel) l;
    if v_id is null then raise; end if;
    return query select v_id, false, v_by;
    return;
  end;

  return query select v_id, true, 'created'::text;
end;
$$;

comment on function public.crm_contact_claim(uuid, text, text, text, uuid, text, text) is
  'Garante que existe UM contato para o número naquele canal: procura e, '
  'faltando, cria — na mesma transação e com advisory lock na chave do '
  'número, para duas automações simultâneas não criarem dois.';

revoke all on function public.crm_contact_lookup(uuid, text, text, text) from public;
revoke all on function public.crm_contact_claim(uuid, text, text, text, uuid, text, text) from public;
grant execute on function public.crm_contact_lookup(uuid, text, text, text) to authenticated, service_role;
grant execute on function public.crm_contact_claim(uuid, text, text, text, uuid, text, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 6. FUSÃO DOS DUPLICADOS QUE JÁ EXISTEM
--
-- Junta por (organização, número, CANAL) — o mesmo número em dois canais fica
-- como está, que é o certo.
--
-- O cadastro de canal desconhecido entra no bolo quando o número tem no
-- máximo um canal conhecido. Com dois, ele fica de fora e sai listado: não há
-- como saber a qual dos dois pertence, e chutar juntaria conversas de
-- vendedores diferentes.
--
-- Só funde o caso sem decisão a tomar: no máximo um lado com venda, e os
-- descartados sem evento na Meta. Do descartado sobem os campos que faltam no
-- sobrevivente — origem e ctwaclid à frente de todos, porque são a atribuição
-- do lead — e as tags entram unidas, não substituídas. Nome diferente vai
-- para a descrição em vez de sumir. É a política da 045, agora repetível.
--
-- Devolve uma linha por bolo tocado (ou recusado), com o motivo.
-- ------------------------------------------------------------
create or replace function public.crm_merge_duplicate_contacts(p_org uuid default null)
returns table(
  organization_id uuid,
  phone           text,
  channel         text,
  survivor_id     uuid,
  survivor_name   text,
  merged          int,
  skipped_reason  text
)
language plpgsql security definer set search_path = public as $$
declare
  g         record;
  loser     record;
  v_org     uuid;
  v_surv    public.crm_contacts;
  v_canais  text[];
  v_strict  boolean;
  v_ch      text;
  v_merged  int;
  v_skip    text;
  v_vendas  int;
begin
  if auth.uid() is not null then
    -- Pela tela isto é operação de admin: funde cadastro e apaga linha.
    if public.current_user_role() <> 'admin' then
      raise exception 'Apenas administradores podem fundir contatos duplicados';
    end if;
    v_org := public.current_org_id();
  else
    v_org := p_org;
  end if;

  for g in
    select c.organization_id as org, public.crm_phone_id(c.phone) as num
    from public.crm_contacts c
    where public.crm_phone_id(c.phone) is not null
      and (v_org is null or c.organization_id = v_org)
    group by 1, 2
    having count(*) > 1
    order by 1, 2
  loop
    -- Os canais CONHECIDOS deste número.
    select coalesce(array_agg(distinct ck), '{}') into v_canais
    from (
      select public.crm_channel_key(c.channel) as ck
      from public.crm_contacts c
      where c.organization_id = g.org and public.crm_phone_id(c.phone) = g.num
    ) t
    where ck is not null;

    if coalesce(array_length(v_canais, 1), 0) <= 1 then
      -- Um canal só (ou nenhum): tudo do número é o mesmo cliente, inclusive
      -- os cadastros sem canal.
      v_canais := array[ v_canais[1] ];  -- pode ser NULL, e é o que queremos
      v_strict := false;
    else
      -- Dois canais ou mais: cada um é um cliente diferente na conversa, e o
      -- cadastro sem canal não pertence a nenhum com certeza.
      v_strict := true;
      if exists (
        select 1 from public.crm_contacts c
        where c.organization_id = g.org and public.crm_phone_id(c.phone) = g.num
          and public.crm_channel_key(c.channel) is null
      ) then
        organization_id := g.org; phone := g.num; channel := null;
        survivor_id := null; survivor_name := null; merged := 0;
        skipped_reason := format(
          'cadastro sem canal e o número aparece em %s canais — informe o canal antes de fundir',
          array_length(v_canais, 1));
        return next;
      end if;
    end if;

    foreach v_ch in array v_canais loop
      v_merged := 0;
      v_skip := null;

      -- Venda em mais de um lado do MESMO bolo: qual delas é a "primeira" do
      -- cliente decide o valor que já foi para a Meta. Não é decisão de rotina.
      select count(*) into v_vendas
      from public.crm_contacts c
      where c.organization_id = g.org
        and public.crm_phone_id(c.phone) = g.num
        and coalesce(c.sales_count, 0) > 0
        and (not v_strict or public.crm_channel_key(c.channel) is not distinct from v_ch);

      if v_vendas > 1 then
        v_skip := 'venda registrada em mais de um contato — precisa de decisão humana';
      end if;

      -- O dono do número neste canal, pela regra única do desempate.
      select * into v_surv
      from public.crm_contact_by_phone(g.org, g.num, v_ch, v_strict);

      if v_skip is null and v_surv.id is not null then
        for loser in
          select * from public.crm_contacts c
          where c.organization_id = g.org
            and public.crm_phone_id(c.phone) = g.num
            and c.id <> v_surv.id
            and (not v_strict or public.crm_channel_key(c.channel) is not distinct from v_ch)
        loop
          if coalesce(loser.sales_count, 0) > 0 then
            -- Não deveria chegar aqui (o filtro acima já barrou), mas contador
            -- é mantido por trigger e um contador errado não pode custar venda.
            v_skip := 'contato descartado tem venda — não foi tocado';
            continue;
          end if;
          if exists (select 1 from public.crm_events e where e.contact_id = loser.id) then
            v_skip := 'contato descartado tem evento na Meta — resolva à mão';
            continue;
          end if;

          -- Ordem obrigatória: apagar antes de copiar. conversation_id tem
          -- índice único por organização, então gravá-lo no sobrevivente com o
          -- descartado ainda vivo esbarraria nele (mesma nota da 045).
          delete from public.crm_contacts where id = loser.id;

          update public.crm_contacts s set
            conversation_id = coalesce(s.conversation_id, loser.conversation_id),
            email           = coalesce(s.email, loser.email),
            origem          = coalesce(nullif(btrim(coalesce(s.origem, '')), ''), loser.origem),
            ctwaclid        = coalesce(nullif(btrim(coalesce(s.ctwaclid, '')), ''), loser.ctwaclid),
            source_id       = coalesce(s.source_id, loser.source_id),
            channel         = coalesce(s.channel, loser.channel),
            phone           = coalesce(s.phone, loser.phone),
            tags            = (select array(select distinct unnest(s.tags || coalesce(loser.tags, '{}')))),
            description     = case
              when loser.name is distinct from s.name
                then coalesce(s.description || E'\n', '')
                     || 'Também cadastrado como: ' || loser.name
              else s.description
            end
          where s.id = v_surv.id;

          v_merged := v_merged + 1;
        end loop;
      end if;

      if v_merged > 0 or v_skip is not null then
        organization_id := g.org;
        phone           := g.num;
        channel         := v_ch;
        survivor_id     := v_surv.id;
        survivor_name   := v_surv.name;
        merged          := v_merged;
        skipped_reason  := v_skip;
        return next;
      end if;
    end loop;
  end loop;
end;
$$;

comment on function public.crm_merge_duplicate_contacts(uuid) is
  'Funde os contatos que dividem o mesmo número DENTRO do mesmo canal, '
  'mantendo o dono pela regra de crm_contact_by_phone e subindo para ele os '
  'campos que faltam. Não toca em número que aparece em canais diferentes, '
  'em bolo com venda dos dois lados nem em descartado com evento na Meta.';

revoke all on function public.crm_merge_duplicate_contacts(uuid) from public;
grant execute on function public.crm_merge_duplicate_contacts(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 7. LIMPEZA E A REDE DE SEGURANÇA
--
-- Roda a fusão agora, em toda a base, e só então tenta o índice único — por
-- (organização, canal, identidade do número), com o canal desconhecido virando
-- '' porque NULL não conflita com NULL num índice único, e aí dois cadastros
-- cegos passariam.
--
-- O índice é TENTADO, não imposto: se sobrar número ambíguo, criá-lo é
-- impossível e derrubar a migration por causa disso deixaria de fora o claim,
-- que é a correção de verdade. Nesse caso a migration termina dizendo o que
-- falta, e o comando fica no fim do arquivo para rodar depois.
-- ------------------------------------------------------------
do $$
declare
  r        record;
  v_bolos  int := 0;
  v_fund   int := 0;
  v_resta  int;
begin
  for r in select * from public.crm_merge_duplicate_contacts(null) loop
    v_bolos := v_bolos + 1;
    v_fund := v_fund + r.merged;
    if r.skipped_reason is not null then
      raise notice 'PENDENTE % (canal %): %', r.phone, coalesce(r.channel, '—'), r.skipped_reason;
    else
      raise notice 'Fundido % (canal %) em % — % descartado(s)',
        r.phone, coalesce(r.channel, '—'), r.survivor_name, r.merged;
    end if;
  end loop;

  raise notice '% bolo(s) tocado(s) · % cadastro(s) fundido(s)', v_bolos, v_fund;

  select count(*) into v_resta from (
    select 1 from public.crm_contacts
    where public.crm_phone_id(phone) is not null
    group by organization_id, coalesce(public.crm_channel_key(channel), ''), public.crm_phone_id(phone)
    having count(*) > 1
  ) t;

  if v_resta = 0 then
    create unique index if not exists idx_crm_contacts_numero_canal_unico
      on public.crm_contacts(
        organization_id,
        (coalesce(public.crm_channel_key(channel), '')),
        (public.crm_phone_id(phone))
      )
      where phone is not null;
    raise notice 'Índice único (organização, canal, número) criado.';
  else
    raise notice
      'ATENÇÃO: % combinação(ões) de canal+número ainda com mais de um '
      'contato. O índice único NÃO foi criado — resolva no painel e rode o '
      'comando comentado no fim da 069. O claim já está valendo: automação '
      'simultânea não cria par novo.',
      v_resta;
  end if;
end $$;

-- Depois de resolver os pendentes, rode isto (fora de transação):
--
--   create unique index concurrently if not exists idx_crm_contacts_numero_canal_unico
--     on public.crm_contacts(
--       organization_id,
--       (coalesce(public.crm_channel_key(channel), '')),
--       (public.crm_phone_id(phone))
--     )
--     where phone is not null;
