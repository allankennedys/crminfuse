-- ============================================================
-- Permissão "Mover no funil" (crm.funil.mover)
--
-- Para quem NÃO pode editar contatos (ex.: Atendente) mas deve poder arrastar
-- no kanban os contatos das PRÓPRIAS conversas. É uma permissão a parte, que
-- o admin liga por usuário em Configurações → Usuários → Permissões. Ninguém
-- a tem por padrão.
--
-- O que ela dá, e só isso:
--   • ver o funil, mas SÓ os contatos cujas conversas estão atribuídas à
--     própria pessoa (crm_board);
--   • ler esses contatos, editar os dados do cliente (nome, telefone, e-mail,
--     origem, etiquetas, campos personalizados) e trocar a ETAPA;
--   • ir para a etapa de conversão lançando a venda (a tela abre o popup).
-- O que ela NÃO dá: mexer nos campos de rastreio do anúncio (um gatilho
-- recusa) nem tocar em contato de conversa de outra pessoa.
--
-- Quem tem "Contatos: Editar" (admin, SDR…) continua como sempre.
-- ============================================================

-- Contato é "meu" quando alguma conversa dele está atribuída a mim.
create or replace function public.crm_contact_is_mine(p_contact uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.wa_conversations w
    where w.contact_id = p_contact and w.assigned_to = auth.uid()
  );
$$;
revoke all on function public.crm_contact_is_mine(uuid) from public, anon;
grant execute on function public.crm_contact_is_mine(uuid) to authenticated;

-- ---------- Etapas: quem move precisa enxergar as colunas ----------
drop policy if exists crm_stages_select on public.crm_stages;
create policy crm_stages_select on public.crm_stages
  for select using (
    organization_id = public.current_org_id()
    and (public.current_user_can('crm.funil.ver') or public.current_user_can('crm.funil.mover'))
  );

-- ---------- Contatos: ler e atualizar os "meus" ----------
drop policy if exists crm_contacts_select on public.crm_contacts;
create policy crm_contacts_select on public.crm_contacts
  for select using (
    organization_id = public.current_org_id()
    and (
      public.current_user_can('crm.contatos.ver')
      or (public.current_user_can('crm.funil.mover') and public.crm_contact_is_mine(id))
    )
  );

drop policy if exists crm_contacts_update on public.crm_contacts;
create policy crm_contacts_update on public.crm_contacts
  for update using (
    organization_id = public.current_org_id()
    and (
      public.current_user_can('crm.contatos.editar')
      or (public.current_user_can('crm.funil.mover') and public.crm_contact_is_mine(id))
    )
  )
  with check (
    organization_id = public.current_org_id()
    and (
      public.current_user_can('crm.contatos.editar')
      or (public.current_user_can('crm.funil.mover') and public.crm_contact_is_mine(id))
    )
  );

-- Quem só tem "Mover no funil" edita os dados do cliente e troca a etapa, mas
-- não mexe nos campos de RASTREIO (clique de anúncio, origem da Meta, valores
-- de venda…): o gatilho compara a linha antes e depois e só deixa mudar as
-- colunas da lista abaixo. Só vale para chamada direta do navegador
-- (current_user = authenticated): as funções do banco que atualizam o contato
-- por baixo (vendas, fusão…) rodam como o dono e passam.
-- Ir para a etapa de CONVERSÃO só vale com venda: a tela abre o lançamento, e
-- é a venda gravada que leva o card para lá (031).
create or replace function public.crm_contacts_mover_guard()
returns trigger
language plpgsql set search_path = public as $$
declare
  v_ok text[] := array[
    'name', 'email', 'phone', 'phone_key', 'name_sort', 'origem', 'tags', 'custom', 'description',
    'stage_id', 'position', 'stage_changed_at', 'lost_reason', 'lost_at', 'updated_at'
  ];
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if public.current_user_can('crm.contatos.editar') then
    return new;
  end if;

  if (to_jsonb(new) - v_ok) is distinct from (to_jsonb(old) - v_ok) then
    raise exception 'Você pode editar os dados do cliente e mover de etapa, mas não os campos de rastreio do anúncio';
  end if;
  if new.stage_id is distinct from old.stage_id and new.stage_id is null then
    raise exception 'Você não pode tirar o contato do funil';
  end if;
  if new.stage_id is distinct from old.stage_id
     and coalesce(old.sales_count, 0) = 0
     and exists (select 1 from public.crm_stages s where s.id = new.stage_id and s.is_conversion) then
    raise exception 'Para marcar como convertido, lance a venda';
  end if;
  return new;
end;
$$;
drop trigger if exists crm_contacts_mover_guard on public.crm_contacts;
create trigger crm_contacts_mover_guard
  before update on public.crm_contacts
  for each row execute function public.crm_contacts_mover_guard();

-- ---------- Kanban: cada um vê o que a permissão dá ----------
-- Antes a função devolvia TODOS os contatos da organização para qualquer
-- usuário logado (ela ignora a RLS). Agora: "Funil: Ver" vê tudo; quem só tem
-- "Mover no funil" vê só os contatos das próprias conversas; os demais, nada.
do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'crm_board' and p.prokind = 'f';
  if v_def is null then
    raise exception 'crm_board não encontrada';
  end if;
  v_new := replace(
    v_def,
    'and c.stage_id is not null',
    'and c.stage_id is not null
      and (
        public.current_user_can(''crm.funil.ver'')
        or (public.current_user_can(''crm.funil.mover'') and public.crm_contact_is_mine(c.id))
      )'
  );
  if v_new = v_def then
    raise exception 'crm_board: trecho esperado não encontrado';
  end if;
  execute v_new;
end;
$$;
