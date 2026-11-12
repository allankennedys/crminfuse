-- ============================================================
-- viewer vira gestor, e no CRM ele vê só os relatórios
--
-- Mesma mecânica da 054: `alter type ... rename value` troca o rótulo em
-- pg_enum sem mexer no OID, então as linhas de public.users migram sozinhas
-- e as políticas de RLS continuam válidas (a expressão guardada aponta para
-- o OID, não para o texto).
--
-- O QUE MUDA DE COMPORTAMENTO
--
-- O preset do painel continua igual: ver tudo, editar nada. No CRM, o gestor
-- passa a ter APENAS 'crm.relatorios.ver'. Ele perde funil, contatos, vendas,
-- automações e chaves — que como viewer ele lia.
--
-- Consequência prática: a única aba que aparece para ele no CRM é
-- Relatórios. Os números seguem completos ali (faturamento, LTV, ROI), o que
-- some é a operação por trás deles.
--
-- POR QUE role_permissions PASSA A COMPARAR TEXTO
--
-- O corpo antigo tinha `case p_role when 'viewer' then ...`, com o literal
-- resolvido como valor do enum. Duas consequências ruins, e as duas se
-- pagam agora:
--
--   1. Renomear um valor QUEBRA a função. O corpo é texto reparseado, e
--      'viewer' deixa de existir no instante do rename. Foi exatamente o que
--      obrigou a 054 a recriar crm_settings_save e as RPCs de etapa.
--   2. Criar a função no MESMO comando do rename é arriscado: o corpo de uma
--      função `language sql` é parseado já no CREATE, e o Postgres recusa
--      usar um valor de enum cuja linha em pg_enum foi tocada pela transação
--      corrente ("unsafe use of new value").
--
-- Com `p_role::text` não existe literal de enum nenhum no corpo. A função
-- para de depender dos rótulos vigentes, este arquivo roda de uma vez só, e
-- o próximo rename de cargo não precisa mexer aqui.
--
-- A assinatura NÃO muda (continua recebendo public.user_role), então
-- current_user_can e permissions_preset seguem chamando sem alteração.
-- ============================================================

alter type public.user_role rename value 'viewer' to 'gestor';

create or replace function public.role_permissions(p_role public.user_role)
returns text[]
language sql immutable set search_path = public as $$
  -- ::text de propósito: ver o cabeçalho. Sem isto, o próximo rename de
  -- cargo transforma esta função numa bomba-relógio.
  select case p_role::text

    when 'admin' then array[
      'painel.dashboard.ver',
      'painel.grupos.ver', 'painel.grupos.editar', 'painel.grupos.excluir',
      'painel.numeros.ver', 'painel.numeros.editar',
      'painel.mensagens.ver', 'painel.mensagens.enviar',
      'painel.agendamentos.ver', 'painel.agendamentos.editar', 'painel.agendamentos.excluir',
      'painel.historico.ver',
      'painel.comprovantes.ver',
      'painel.automacoes.ver', 'painel.automacoes.editar',
      'painel.config.ver',
      'crm.funil.ver',
      'crm.etapas.editar', 'crm.etapas.excluir',
      'crm.contatos.ver', 'crm.contatos.editar', 'crm.contatos.excluir',
      'crm.vendas.ver', 'crm.vendas.editar', 'crm.vendas.excluir',
      'crm.relatorios.ver',
      'crm.automacoes.ver', 'crm.automacoes.editar',
      'crm.chaves.ver', 'crm.chaves.editar'
    ]

    when 'operator' then array[
      'painel.dashboard.ver',
      'painel.grupos.ver', 'painel.grupos.editar', 'painel.grupos.excluir',
      'painel.numeros.ver', 'painel.numeros.editar',
      'painel.mensagens.ver', 'painel.mensagens.enviar',
      'painel.agendamentos.ver', 'painel.agendamentos.editar', 'painel.agendamentos.excluir',
      'painel.historico.ver',
      'painel.comprovantes.ver',
      'painel.automacoes.ver',
      'painel.config.ver',
      'crm.funil.ver',
      'crm.etapas.editar', 'crm.etapas.excluir',
      'crm.contatos.ver', 'crm.contatos.editar', 'crm.contatos.excluir',
      'crm.vendas.ver', 'crm.vendas.editar', 'crm.vendas.excluir',
      'crm.relatorios.ver',
      'crm.automacoes.ver', 'crm.automacoes.editar',
      'crm.chaves.ver'
    ]

    when 'sdr' then array[
      'crm.funil.ver',
      'crm.etapas.editar',
      'crm.contatos.ver', 'crm.contatos.editar',
      'crm.vendas.ver', 'crm.vendas.editar',
      'crm.relatorios.ver',
      'crm.automacoes.ver'
    ]

    -- Gestor: acompanha, não opera. No painel lê tudo; no CRM lê SÓ os
    -- relatórios — os números do negócio sem a operação por trás deles.
    -- Como 'viewer' ele lia funil, contatos e vendas; isso sai agora.
    when 'gestor' then array[
      'painel.dashboard.ver',
      'painel.grupos.ver',
      'painel.numeros.ver',
      'painel.mensagens.ver',
      'painel.agendamentos.ver',
      'painel.historico.ver',
      'painel.comprovantes.ver',
      'painel.automacoes.ver',
      'painel.config.ver',
      'crm.relatorios.ver'
    ]

    else array[]::text[]
  end;
$$;

comment on function public.role_permissions(public.user_role) is
  'Permissões padrão de cada cargo. Fonte única: as políticas de RLS, as '
  'RPCs e a tela de usuários todas derivam daqui. Compara p_role::text para '
  'não quebrar quando um cargo for renomeado.';

-- ------------------------------------------------------------
-- Quem já tinha permissões PERSONALIZADAS não é tocado
--
-- A lista deles é texto e não menciona cargo nenhum, então o rename não a
-- afeta. Quem estava no preset (permissions is null) migra sozinho para o
-- preset novo — que é justamente o efeito desejado.
--
-- Confira depois com:
--   select role, count(*), count(permissions) as personalizados
--   from public.users group by role;
-- ------------------------------------------------------------
