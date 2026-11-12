-- ============================================================
-- Gestor passa a administrar a lista de grupos
--
-- Continuação da 065, que deu a ele o envio. Sincronizar a lista de grupos e
-- os participantes vinha logo depois e ainda batia em 403.
--
-- Eram DUAS paredes, e só uma estava no banco:
--
--   1. a Edge Function `evolution` (o proxy da Evolution API) recusava por
--      CARGO — `role === 'gestor'` → 403 — sem nunca perguntar permissão a
--      ninguém. Corrigido no código da função: agora cada rota declara a
--      permissão que exige e quem responde é current_user_can(), a mesma
--      função que a RLS usa;
--
--   2. as políticas de `groups` e `group_participants` exigem
--      painel.grupos.editar para gravar, e o gestor não tinha. É o que esta
--      migration resolve.
--
-- Sem as duas, sincronizar falha: liberar só o proxy adiantaria o erro para
-- a linha seguinte, e liberar só a RLS não passaria do primeiro fetch.
--
-- O QUE painel.grupos.editar DÁ, E O QUE NÃO DÁ
--
--   dá     criar e atualizar grupo, gravar participantes — ou seja, importar
--          do WhatsApp e sincronizar
--   não dá excluir grupo, que é painel.grupos.excluir e continua fora
--
-- ESTA MIGRATION SUBSTITUI A 065
--
-- role_permissions() é um CASE único: não há como alterar um cargo isolado,
-- a função é recriada inteira. Então o corpo abaixo já contém tudo que a 065
-- fazia (mensagens.enviar e agendamentos.editar para o gestor) mais o
-- grupos.editar.
--
--   • não aplicou a 065 ainda → aplique só esta, ignore a 065;
--   • já aplicou a 065        → aplique esta por cima, o resultado é o mesmo.
--
-- QUEM ESTA MIGRATION NÃO ALCANÇA
--
-- Usuário com lista PERSONALIZADA (users.permissions não nulo) não segue
-- preset. Confira quem está nessa situação:
--   select id, email, role from public.users
--   where role = 'gestor' and permissions is not null;
-- ============================================================

create or replace function public.role_permissions(p_role public.user_role)
returns text[]
language sql immutable set search_path = public as $$
  -- ::text de propósito (056): sem isto, o próximo rename de cargo
  -- transforma esta função numa bomba-relógio.
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

    -- Gestor: opera o envio para os grupos e mantém a lista deles em dia
    -- (importar do WhatsApp, sincronizar participantes). Não exclui grupo,
    -- não conecta número, não edita automação, e no CRM lê só relatórios.
    when 'gestor' then array[
      'painel.dashboard.ver',
      'painel.grupos.ver', 'painel.grupos.editar',
      'painel.numeros.ver',
      'painel.mensagens.ver', 'painel.mensagens.enviar',
      'painel.agendamentos.ver', 'painel.agendamentos.editar',
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
  'RPCs, a Edge Function evolution e a tela de usuários todas derivam daqui. '
  'Compara p_role::text para não quebrar quando um cargo for renomeado.';
