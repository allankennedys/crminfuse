-- ============================================================
-- Relatórios por atendente e abas de relatório liga/desliga
--
-- ATENDENTE NOS RELATÓRIOS. "Atendente" é quem atende o cliente: o contato
-- pertence ao atendente quando alguma conversa dele está atribuída a essa
-- pessoa (crm_contact_of_user). Com ele escolhido:
--   • Funil e Vendas: só os contatos dele (e as vendas desses contatos);
--   • Atendimento (wa_report): os atendimentos que passaram por ele, as
--     mensagens que ele enviou e as que o cliente mandou nesses atendimentos.
-- Jornada, Recompra e Meta ADS não têm atendente: o investimento do anúncio
-- e a jornada do lead não dependem de quem atende.
--
-- Cada função ganha o parâmetro p_user (null = todos, como era). Em vez de
-- recopiar as 14 funções, a condição entra por substituição no texto de cada
-- uma; se o trecho esperado não for achado, a migration para com erro claro.
-- A função antiga (sem p_user) é apagada: duas versões com os mesmos nomes de
-- parâmetro deixariam a chamada ambígua.
--
-- ABAS. crm_funil_settings.report_tabs_off: abas dos relatórios que o admin
-- desligou (a tela esconde e não carrega).
-- ============================================================

create or replace function public.crm_contact_of_user(p_contact uuid, p_user uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.wa_conversations w
    where w.contact_id = p_contact and w.assigned_to = p_user
  );
$$;
revoke all on function public.crm_contact_of_user(uuid, uuid) from public, anon;
grant execute on function public.crm_contact_of_user(uuid, uuid) to authenticated;

do $$
declare
  r       record;
  v_def   text;
  v_new   text;
  v_cond  constant text := '(p_channel is null or c.channel = p_channel)';
  v_novo  constant text := '(p_channel is null or c.channel = p_channel) and (p_user is null or public.crm_contact_of_user(c.id, p_user))';
begin
  -- Uma função SQL chama a outra: valida o corpo só na hora de usar.
  perform set_config('check_function_bodies', 'off', true);
  for r in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname in (
        'crm_report_overview', 'crm_report_timeseries', 'crm_report_by_origem', 'crm_report_by_channel',
        'crm_report_conversions_in_period', 'crm_report_converted_contacts',
        'crm_report_no_origem_by_stage', 'crm_report_no_origem_list',
        'crm_sales_metrics', 'crm_report_sales', 'crm_report_sales_timeseries',
        'crm_report_sales_breakdown', 'crm_report_sales_by_contact', 'crm_report_refunds'
      )
    order by case when p.proname = 'crm_sales_metrics' then 0 else 1 end
  loop
    v_def := pg_get_functiondef(r.oid);
    if position('p_user uuid' in v_def) > 0 then continue; end if;

    v_new := regexp_replace(v_def, E'\\)\\n RETURNS', ', p_user uuid DEFAULT NULL::uuid)' || E'\n RETURNS');
    if v_new = v_def then
      raise exception '%: não achei o fim da lista de parâmetros', r.proname;
    end if;

    if r.proname = 'crm_report_sales' then
      -- Só repassa para o cálculo das vendas.
      v_new := replace(v_new, 'p_from, p_to, p_channel);', 'p_from, p_to, p_channel, p_user);');
      if position('p_channel, p_user)' in v_new) = 0 then
        raise exception '%: não achei a chamada a repassar', r.proname;
      end if;
    else
      v_new := replace(v_new, v_cond, v_novo);
      if position('crm_contact_of_user' in v_new) = 0 then
        raise exception '%: não achei o filtro de canal', r.proname;
      end if;
    end if;

    execute v_new;
    execute format('drop function public.%I(%s)', r.proname, r.args);
  end loop;
end;
$$;

-- Relatório de atendimento (por pessoa).
do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'wa_report' and p.prokind = 'f'
    and pg_get_function_identity_arguments(p.oid) = 'p_from date, p_to date';
  if v_def is null then
    return; -- já aplicada
  end if;

  v_new := replace(v_def, E'(p_from date, p_to date)\n RETURNS jsonb', E'(p_from date, p_to date, p_user uuid DEFAULT NULL::uuid)\n RETURNS jsonb');
  v_new := replace(v_new,
    'select * from public.wa_tickets where organization_id = v_org)',
    'select * from public.wa_tickets where organization_id = v_org and (p_user is null or assigned_to = p_user))');
  v_new := replace(v_new,
    'where e.organization_id = v_org and e.created_at >= v_ini and e.created_at < v_fim',
    'where e.organization_id = v_org and e.created_at >= v_ini and e.created_at < v_fim
      and (p_user is null or e.conversation_id in (select t2.conversation_id from t t2))');
  v_new := replace(v_new,
    'select m.from_me, m.sent_by from public.wa_messages m',
    'select m.from_me, m.sent_by, m.conversation_id from public.wa_messages m');
  v_new := replace(v_new,
    'and m.type <> ''reaction''',
    'and m.type <> ''reaction''
      and (p_user is null or (m.from_me and m.sent_by = p_user)
           or (not m.from_me and m.conversation_id in (select t3.conversation_id from t t3)))');
  v_new := replace(v_new,
    E'where u.organization_id = v_org\n          and (public.user_has_perm',
    E'where u.organization_id = v_org\n          and (p_user is null or u.id = p_user)\n          and (public.user_has_perm');

  if position('p_user' in v_new) = 0 or v_new = v_def
     or position('t2.conversation_id' in v_new) = 0 or position('t3.conversation_id' in v_new) = 0
     or position('u.id = p_user' in v_new) = 0 or position('assigned_to = p_user' in v_new) = 0 then
    raise exception 'wa_report: trechos esperados não encontrados';
  end if;
  execute v_new;
  drop function public.wa_report(date, date);
end;
$$;

-- Abas dos relatórios desligadas pelo admin.
alter table public.crm_funil_settings
  add column if not exists report_tabs_off text[] not null default '{}';
