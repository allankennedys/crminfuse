/**
 * Catálogo de permissões — os rótulos das chaves que o banco enforce.
 *
 * QUEM MANDA É O BANCO. Cada chave daqui existe numa política de RLS ou numa
 * guarda de RPC (migration 055). Este arquivo só dá nome às caixas de seleção
 * e diz em qual dos dois sistemas cada uma aparece. Se as duas listas saírem
 * do lugar, o pior que acontece é a tela oferecer um botão que o banco
 * recusa — nunca o contrário, que seria o problema de verdade.
 *
 * OS PRESETS NÃO ESTÃO AQUI, DE PROPÓSITO
 *
 * Quem responde "o que um SDR pode fazer" é role_permissions(), no banco. A
 * tela pergunta via RPC permissions_preset. Duplicar a lista no bundle
 * criaria duas verdades, e a que aparece na tela não é a que decide.
 *
 * NÃO DERIVE O SISTEMA DE APP_MODE
 *
 * Existia aqui um APP_MODE_SYSTEM que lia o modo do build. Estava errado: a
 * tela de usuários é o MESMO componente nos dois sistemas, e o build não diz
 * onde ele foi montado — no domínio da gestão o CRM ainda abre em /crm, e em
 * dev não há VITE_APP nenhum. Nos dois casos APP_MODE dizia 'groups' e a tela
 * dentro do CRM listava permissões de Grupos. Quem sabe o sistema é o local
 * que renderiza; por isso areasDoSistema() recebe o sistema como argumento.
 *
 * FORA DO CATÁLOGO
 *
 * Duas coisas nunca viram caixa de seleção porque são exclusivas de admin
 * por decisão, não por preset:
 *   • credenciais da Meta (Pixel, tokens, conta de anúncios) — 054;
 *   • gestão de usuários e permissões — user_permissions_save, 055.
 * Oferecê-las como caixa daria a impressão de que dá para delegar.
 */

export type PermissionSystem = 'painel' | 'crm'

export interface PermissionArea {
  id: string
  sistema: PermissionSystem
  label: string
  /** Uma linha dizendo o que a área cobre, para o admin não ter que adivinhar. */
  hint: string
  actions: { key: string; label: string }[]
}

/**
 * A ordem aqui é a ordem da tela, e ela segue o menu de cada sistema — o
 * admin procura a permissão onde ele vê o item, não em ordem alfabética.
 */
export const PERMISSION_AREAS: PermissionArea[] = [
  // ---------- Painel de gestão ----------
  {
    id: 'painel.dashboard',
    sistema: 'painel',
    label: 'Dashboard',
    hint: 'Visão geral com os números de envio',
    actions: [{ key: 'painel.dashboard.ver', label: 'Ver' }],
  },
  {
    id: 'painel.grupos',
    sistema: 'painel',
    label: 'Grupos',
    hint: 'Grupos, participantes e sincronização',
    actions: [
      { key: 'painel.grupos.ver', label: 'Ver' },
      { key: 'painel.grupos.editar', label: 'Editar' },
      { key: 'painel.grupos.excluir', label: 'Excluir' },
    ],
  },
  {
    id: 'painel.mensagens',
    sistema: 'painel',
    label: 'Mensagens',
    hint: 'Compor e disparar envios, incluindo subir mídia',
    actions: [
      { key: 'painel.mensagens.ver', label: 'Ver' },
      { key: 'painel.mensagens.enviar', label: 'Enviar' },
    ],
  },
  {
    id: 'painel.agendamentos',
    sistema: 'painel',
    label: 'Agendamentos',
    hint: 'Envios programados',
    actions: [
      { key: 'painel.agendamentos.ver', label: 'Ver' },
      { key: 'painel.agendamentos.editar', label: 'Editar' },
      { key: 'painel.agendamentos.excluir', label: 'Excluir' },
    ],
  },
  {
    id: 'painel.historico',
    sistema: 'painel',
    label: 'Histórico',
    hint: 'Log do que foi enviado',
    actions: [{ key: 'painel.historico.ver', label: 'Ver' }],
  },
  {
    id: 'painel.automacoes',
    sistema: 'painel',
    label: 'Automações',
    hint: 'Regras automáticas de envio',
    actions: [
      { key: 'painel.automacoes.ver', label: 'Ver' },
      { key: 'painel.automacoes.editar', label: 'Editar' },
    ],
  },
  {
    id: 'painel.config',
    sistema: 'painel',
    label: 'Configurações',
    hint: 'Tela de configurações do painel',
    actions: [{ key: 'painel.config.ver', label: 'Ver' }],
  },

  // ---------- CRM ----------
  {
    id: 'crm.funil',
    sistema: 'crm',
    label: 'Funil',
    hint: 'O kanban e o histórico de movimentação',
    actions: [
      { key: 'crm.funil.ver', label: 'Ver' },
      // Para quem não edita contatos (ex.: Atendente): vê no funil só os
      // contatos das suas conversas e arrasta entre etapas. Não vale para a
      // etapa de conversão (que exige lançar venda) nem edita dados.
      { key: 'crm.funil.mover', label: 'Mover os das suas conversas' },
    ],
  },
  {
    id: 'crm.etapas',
    sistema: 'crm',
    label: 'Etapas',
    hint: 'Criar, renomear, reordenar e apagar colunas do funil',
    actions: [
      { key: 'crm.etapas.editar', label: 'Editar' },
      { key: 'crm.etapas.excluir', label: 'Excluir' },
    ],
  },
  {
    // A regra mora na RLS de wa_conversations (116). Sem "Ver todas", a
    // pessoa só enxerga as conversas atribuídas a ela — é o recorte do cargo
    // Atendente.
    id: 'atendimento',
    sistema: 'crm',
    label: 'Atendimento (WhatsApp)',
    hint: 'Conversas individuais. Se a restrição estiver ligada em Configurações → Atendimento, quem não tem "Ver todas" só vê as atribuídas a si',
    actions: [
      { key: 'atendimento.ver', label: 'Responder as suas' },
      { key: 'atendimento.transferir', label: 'Transferir as suas' },
      { key: 'atendimento.ver_todas', label: 'Ver todas' },
      { key: 'atendimento.atribuir', label: 'Atribuir qualquer uma' },
      { key: 'atendimento.configurar', label: 'Configurar' },
    ],
  },
  {
    // As chaves continuam 'painel.*' porque é o que a RLS de whatsapp_sessions
    // e a Edge Function evolution perguntam. Mudou só o sistema: neste
    // projeto não há painel de grupos, e os números moram no Atendimento.
    id: 'painel.numeros',
    sistema: 'crm',
    label: 'Números de WhatsApp',
    hint: 'Conectar pelo QR Code, desconectar e remover (sempre só os próprios números)',
    actions: [
      { key: 'painel.numeros.ver', label: 'Ver' },
      { key: 'painel.numeros.editar', label: 'Gerenciar' },
    ],
  },
  {
    id: 'crm.contatos',
    sistema: 'crm',
    label: 'Contatos',
    hint: 'Leads e clientes, incluindo mover de etapa',
    actions: [
      { key: 'crm.contatos.ver', label: 'Ver' },
      { key: 'crm.contatos.editar', label: 'Editar' },
      { key: 'crm.contatos.excluir', label: 'Excluir' },
    ],
  },
  {
    id: 'crm.vendas',
    sistema: 'crm',
    label: 'Vendas',
    hint: 'Lançar e corrigir vendas no painel do contato',
    actions: [
      { key: 'crm.vendas.ver', label: 'Ver' },
      { key: 'crm.vendas.editar', label: 'Lançar' },
      { key: 'crm.vendas.excluir', label: 'Excluir' },
    ],
  },
  // Relatórios saiu do catálogo: neste projeto a aba é só do admin (decisão,
  // não preset), e uma caixa marcável daria a impressão de que dá para
  // delegar. A chave crm.relatorios.ver continua no banco para as RPCs.
  {
    id: 'crm.automacoes',
    sistema: 'crm',
    label: 'Automações de etapa',
    hint: 'Regras que disparam quando o card muda de coluna',
    actions: [
      { key: 'crm.automacoes.ver', label: 'Ver' },
      { key: 'crm.automacoes.editar', label: 'Editar' },
    ],
  },
]

/**
 * As áreas de um sistema. É o que atende ao pedido de "permissões de cada
 * sistema só aparecem nele": no CRM não faz sentido marcar acesso a Grupos.
 *
 * Recebe o sistema em vez de ler APP_MODE porque a tela de usuários é o
 * MESMO componente nos dois lugares, e o build nem sempre diz onde ele está
 * sendo renderizado: no domínio da gestão o CRM ainda abre em /crm, e em
 * dev não existe VITE_APP nenhum. Nos dois casos APP_MODE dizia 'groups' e
 * a tela de usuários DENTRO do CRM listava permissões de Grupos.
 */
export function areasDoSistema(sistema: PermissionSystem): PermissionArea[] {
  return PERMISSION_AREAS.filter((a) => a.sistema === sistema)
}

/** Todas as chaves — usado para o admin, que tem tudo por definição. */
export const ALL_PERMISSIONS: string[] = PERMISSION_AREAS.flatMap(
  (a) => a.actions.map((x) => x.key),
)

/** Chaves de um sistema só. */
export function permissionsOfSystem(sistema: PermissionSystem): string[] {
  return PERMISSION_AREAS
    .filter((a) => a.sistema === sistema)
    .flatMap((a) => a.actions.map((x) => x.key))
}

/**
 * Monta a lista a gravar preservando o que é do OUTRO sistema.
 *
 * O banco guarda UMA lista por usuário, mas cada build mostra só as caixas
 * do seu sistema. Gravar apenas o que está marcado na tela apagaria, do CRM,
 * todo o acesso da pessoa ao painel — sem aviso, porque aquelas caixas nunca
 * apareceram. Daí a função existir separada e testada: é uma perda silenciosa
 * de acesso, o tipo de bug que só aparece semanas depois.
 *
 * @param base      lista efetiva do usuário ao abrir o editor (personalizada
 *                  ou o preset do cargo)
 * @param marcadas  o que está marcado agora, só do sistema atual
 * @param sistema   o sistema que a tela está editando
 */
export function mergePermissions(
  base: string[],
  marcadas: Iterable<string>,
  sistema: PermissionSystem,
): string[] {
  const doSistema = new Set(permissionsOfSystem(sistema))
  const doOutro = base.filter((k) => !doSistema.has(k))
  // Filtra `marcadas` pelo sistema também: uma chave de fora que tivesse
  // vazado para a seleção entraria duplicada com a preservada acima.
  const daTela = [...marcadas].filter((k) => doSistema.has(k))
  return [...new Set([...doOutro, ...daTela])]
}

/** Rótulo legível de uma chave, para mensagens de erro e auditoria. */
export function permissionLabel(key: string): string {
  for (const area of PERMISSION_AREAS) {
    const hit = area.actions.find((a) => a.key === key)
    if (hit) return `${area.label} · ${hit.label}`
  }
  return key
}
