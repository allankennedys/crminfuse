-- ============================================================
-- A fusão de duplicatas leva o clique da landing junto
--
-- A 069 funde dois cadastros do mesmo número e copia do descartado o que o
-- sobrevivente não tem: conversation_id, e-mail, origem, ctwaclid,
-- source_id, canal, telefone, etiquetas. A lista foi escrita antes da 071 —
-- e a 071 acrescentou oito colunas que ninguém avisou a ela.
--
-- O buraco: o lead que veio pela landing e AINDA NÃO COMPROU é exatamente o
-- perfil que a fusão toca (ela se recusa a mexer em contato com venda ou
-- com evento na Meta). Fundido, o cadastro que carregava fbc e campaign_id
-- é apagado e a atribuição morre com ele. Quando a venda finalmente
-- acontecer, ela sai como system_generated — ou nem sai, se a origem também
-- não declarar anúncio. Prejuízo silencioso: nada falha, o número só fica
-- menor no Gerenciador.
--
-- O BLOCO VIAJA INTEIRO
--
-- fbc, fbp, IP, User-Agent, URL e os três ids descrevem UMA visita. Copiados
-- campo a campo, como os outros, o fbc de uma visita acabaria ao lado do
-- campaign_id de outra e a venda seria atribuída à campanha errada — com
-- toda a aparência de estar certa. Por isso a regra aqui é all-or-nothing,
-- diferente da regra campo a campo do resto da função.
--
-- Corpo idêntico ao da 069: muda a declaração de uma variável, o cálculo
-- dela antes do update e oito colunas na lista do update.
--
-- A função só roda à mão (nenhuma tela a chama), então isto não é urgente —
-- é o tipo de coisa que só cobra a conta no dia em que alguém rodar a
-- manutenção e ninguém relacionar as duas coisas.
--
-- Aplicar pelo SQL Editor. Nunca por db push.
-- ============================================================

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
  -- O bloco do clique na landing (071) viaja inteiro: ver nota antes do
  -- update. true = o descartado tem clique e o sobrevivente não.
  v_leva_web boolean;
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

          -- O BLOCO DA LANDING VIAJA INTEIRO OU NÃO VIAJA.
          --
          -- Campo a campo, o fbc de uma visita acabaria ao lado do
          -- campaign_id de outra e a venda seria atribuída à campanha
          -- errada — com toda a aparência de estar certa. Só entra quando o
          -- sobrevivente não tem clique nenhum e o descartado tem; havendo
          -- clique nos dois, o do sobrevivente manda, porque é dele que os
          -- eventos já enfileirados falam.
          select coalesce(nullif(btrim(coalesce(c.fbc, '')), ''), '') = ''
            into v_leva_web
          from public.crm_contacts c where c.id = v_surv.id;
          v_leva_web := coalesce(v_leva_web, false)
            and btrim(coalesce(loser.fbc, '')) <> '';

          update public.crm_contacts s set
            conversation_id = coalesce(s.conversation_id, loser.conversation_id),
            email           = coalesce(s.email, loser.email),
            origem          = coalesce(nullif(btrim(coalesce(s.origem, '')), ''), loser.origem),
            ctwaclid        = coalesce(nullif(btrim(coalesce(s.ctwaclid, '')), ''), loser.ctwaclid),
            source_id       = coalesce(s.source_id, loser.source_id),
            fbc             = case when v_leva_web then loser.fbc         else s.fbc end,
            fbp             = case when v_leva_web then loser.fbp         else s.fbp end,
            client_ip       = case when v_leva_web then loser.client_ip   else s.client_ip end,
            user_agent      = case when v_leva_web then loser.user_agent  else s.user_agent end,
            landing_url     = case when v_leva_web then loser.landing_url else s.landing_url end,
            campaign_id     = case when v_leva_web then loser.campaign_id else s.campaign_id end,
            adset_id        = case when v_leva_web then loser.adset_id    else s.adset_id end,
            ad_id           = case when v_leva_web then loser.ad_id       else s.ad_id end,
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
