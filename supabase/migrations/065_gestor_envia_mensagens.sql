-- ============================================================
-- Gestor passa a enviar mensagens e mídia para os grupos
--
-- O preset do gestor (056) era "acompanha, não opera": ele via a tela de
-- Mensagens e não conseguia usá-la. Na prática isso produzia o pior dos
-- mundos — o formulário aparecia inteiro, o seletor de arquivo abria, e o
-- erro só vinha no clique, cru, vindo da política do bucket.
--
-- A decisão mudou: gestor envia. Ganha duas permissões.
--
--   painel.mensagens.enviar     upload no bucket media, insert em messages,
--                               insert em message_queue, insert em
--                               message_logs e delete de mídia. Todas as
--                               cinco políticas da 055 cobram esta mesma
--                               permissão, então é ela que destrava o fluxo
--                               inteiro do envio.
--
--   painel.agendamentos.editar  criar e alterar agendamento. Entra junto
--                               porque agendar é enviar depois: a tela de
--                               Agendamentos também sobe mídia, e o gestor
--                               já a enxergava. Sem isto ele bateria na
--                               mesma parede, um clique adiante.
--
-- O QUE O GESTOR CONTINUA SEM PODER
--
--   painel.agendamentos.excluir   criar sim, apagar não
--   painel.grupos.editar          envia PARA os grupos, não mexe neles
--   painel.numeros.editar         usa os números conectados, não os conecta
--   painel.automacoes.editar      só leitura
--   no CRM, nada além de crm.relatorios.ver
--
-- QUEM ESTA MIGRATION NÃO ALCANÇA
--
-- Usuário com lista PERSONALIZADA (users.permissions não nulo) não segue
-- preset nenhum: current_user_can testa a lista dele antes do cargo. Se
-- algum gestor foi editado à mão na tela de usuários, ele precisa receber
-- as duas permissões por lá — ou voltar ao preset, que agora já é este.
--
-- Confira quem está nessa situação:
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

    -- Gestor: no painel agora OPERA o envio — manda mensagem e mídia para os
    -- grupos e agenda envio. Fora isso continua acompanhando: não mexe em
    -- grupo, número nem automação, e no CRM lê só os relatórios.
    when 'gestor' then array[
      'painel.dashboard.ver',
      'painel.grupos.ver',
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
  'RPCs e a tela de usuários todas derivam daqui. Compara p_role::text para '
  'não quebrar quando um cargo for renomeado.';
