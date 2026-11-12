/**
 * Renames feitos no enum do banco, não em coluna nova:
 * 'crm_only' → 'sdr' (054) e 'viewer' → 'gestor' (056).
 */
export type UserRole = 'admin' | 'operator' | 'gestor' | 'sdr' | 'atendente'
export type SessionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'
export type MediaType = 'text' | 'image' | 'audio' | 'video' | 'document'
export type QueueStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled'
export type QueuePriority = 'urgent' | 'normal' | 'low'
export type LogStatus = 'sent' | 'failed' | 'queued' | 'retrying'
export type ScheduleStatus = 'scheduled' | 'executed' | 'cancelled' | 'failed'

export interface Organization {
  id: string
  name: string
  created_at: string
}

export interface UserProfile {
  id: string
  organization_id: string
  email: string
  username: string | null
  full_name: string | null
  role: UserRole
  /**
   * Permissões personalizadas. null = segue o preset do cargo (é o caso de
   * todo usuário que nunca foi editado). Array vazio = personalizado e sem
   * nenhuma permissão — diferente de null, e é essa distinção que permite
   * "tirar tudo" de alguém sem trocar o cargo dele.
   *
   * Ignorada para admin: ele tem acesso total por definição (055).
   */
  permissions: string[] | null
  is_active: boolean
  created_at: string
}

export interface WhatsAppSession {
  id: string
  organization_id: string
  instance_name: string
  phone_number: string | null
  status: SessionStatus
  rate_limit_per_min: number
  last_seen_at: string | null
  created_at: string
}

export interface Group {
  id: string
  organization_id: string
  name: string
  description: string | null
  group_jid: string | null
  is_active: boolean
  created_at: string
}

export interface GroupParticipant {
  id: string
  group_id: string
  jid: string
  name: string | null
  phone: string | null
  is_admin: boolean
  synced_at: string
}

export interface Message {
  id: string
  organization_id: string
  created_by: string | null
  media_type: MediaType
  content: string | null
  media_url: string | null
  storage_path: string | null
  caption: string | null
  file_name: string | null
  created_at: string
}

export interface QueueItem {
  id: string
  organization_id: string
  message_id: string
  group_id: string
  session_id: string | null
  priority: QueuePriority
  status: QueueStatus
  attempts: number
  max_attempts: number
  next_attempt_at: string
  locked_at: string | null
  locked_by: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export interface MessageLog {
  id: string
  organization_id: string
  queue_id: string | null
  message_id: string | null
  group_id: string | null
  session_id: string | null
  status: LogStatus
  media_type: MediaType
  detail: string | null
  created_at: string
}

export interface Schedule {
  id: string
  organization_id: string
  message_id: string
  group_id: string
  /** Número de origem; null = automático (worker escolhe entre os conectados) */
  session_id: string | null
  priority: QueuePriority
  scheduled_at: string
  timezone: string
  status: ScheduleStatus
  executed_at: string | null
  created_by: string | null
  created_at: string
}

export type ParticipantJobStatus = 'pending' | 'processing' | 'done' | 'failed'

export interface ParticipantJob {
  id: string
  organization_id: string
  group_id: string
  session_id: string
  action: 'add' | 'remove' | 'sync'
  phones: string[]
  processed: number
  total: number
  status: ParticipantJobStatus
  error: string | null
  created_at: string
  updated_at: string
}

export interface AutomationRule {
  id: string
  organization_id: string
  name: string
  trigger_event: string
  trigger_group_id: string | null
  action_message_id: string | null
  action_group_id: string | null
  is_active: boolean
  created_at: string
}

// ------------------------------------------------------------
// CRM
// ------------------------------------------------------------

export type CrmHistorySource = 'ui' | 'api' | 'system'
/** 'skipped' = conversão de contato que não veio de anúncio: não vai à Meta. */
export type CrmEventStatus = 'pending' | 'sent' | 'failed' | 'skipped'

export interface CrmStage {
  id: string
  organization_id: string
  name: string
  color: string
  position: number
  /** Entrar nesta etapa dispara o evento de conversão na Meta CAPI. */
  is_conversion: boolean
  /**
   * Papel da etapa no relatório de Jornada (060). null = etapa comum do
   * meio do funil. Existe para o SQL não comparar NOME de etapa: renomear a
   * coluna no kanban não pode mudar métrica nenhuma.
   */
  journey_role: CrmJourneyRole | null
  created_at: string
}

/**
 * Papéis que uma etapa pode ter na jornada. Só um por organização (índice
 * único na 060). A etapa de conversão continua marcada por is_conversion —
 * ganhar não é papel de jornada.
 */
export type CrmJourneyRole = 'triagem' | 'orcamento' | 'remarketing' | 'perdido'

/**
 * Regra de movimentação automática (050): quem fica parado em `from_stage_id`
 * mais que `hours` horas vai para `to_stage_id`. Quem executa é o pg_cron, de
 * hora em hora; a tela só usa isto para avisar na coluna.
 */
export interface CrmStageAutomation {
  from_stage_id: string
  to_stage_id: string
  to_stage_name: string
  hours: number
}

export interface CrmContact {
  id: string
  organization_id: string
  /** null = fora do funil (base pré-implementação): não aparece no kanban. */
  stage_id: string | null
  name: string
  email: string | null
  phone: string | null
  /** Identificador da conversa no bot — chave usada pelas automações externas. */
  conversation_id: string | null
  /** De qual WhatsApp/origem o contato veio. Texto livre. */
  channel: string | null
  /** Click-to-WhatsApp Ad Click ID (ctwa_clid do Meta): id do clique no anúncio. */
  ctwaclid: string | null
  /** Id da origem no sistema externo (campanha, anúncio, formulário). */
  source_id: string | null
  /** Rótulo legível da origem (ex.: "Instagram Ads", "Indicação"). */
  origem: string | null
  /**
   * Captura do pixel quando o lead passou por uma landing antes do WhatsApp
   * (071). fbc é o clique no anúncio — o que atribui a venda, como o
   * ctwaclid faz no funil de Click-to-WhatsApp. Preenchidos pela automação
   * da landing, nunca pela tela.
   */
  fbc: string | null
  /** Cookie _fbp: ajuda o casamento do usuário, não prova anúncio. */
  fbp: string | null
  /** IP do navegador do lead na visita à landing. */
  client_ip: string | null
  /** User-Agent do navegador do lead. Exigido em evento de site. */
  user_agent: string | null
  /** URL da landing com os parâmetros do clique (vira event_source_url). */
  landing_url: string | null
  /** Ids da Meta lidos da URL do anúncio. campaign_id é o que prova mídia paga. */
  campaign_id: string | null
  adset_id: string | null
  ad_id: string | null
  /**
   * Preenchido = os dados de anúncio acima foram COPIADOS do cadastro deste
   * mesmo número em outro canal (081), porque este nasceu sem nenhum. Não
   * houve clique de anúncio por este WhatsApp: houve pelo outro, e a venda
   * daqui é do mesmo cliente. null = a atribuição é deste cadastro.
   */
  ads_inherited_from: string | null
  tags: string[]
  /**
   * Valor da PRIMEIRA venda, em centavos — é o que vira conversão na Meta e
   * o que os relatórios de conversão somam. Mantido pelo banco quando o
   * contato tem vendas registradas. Formate com formatBRL() do crmService.
   */
  value_cents: number
  /** Quantas vendas o cliente tem (1ª + recompras). */
  sales_count: number
  /** Soma de todas as vendas do cliente, em centavos. */
  sales_total_cents: number
  description: string | null
  position: number
  stage_changed_at: string
  /** Quem está cuidando do lead. null = ninguém atribuído. */
  assigned_to: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/**
 * Uma venda do cliente. A primeira (ordem: sold_at, created_at, id) é a que
 * entra no funil de conversão e dispara o evento na Meta; as demais ficam
 * apenas registradas no contato — regra garantida por trigger no banco.
 */
/**
 * Como o cliente pagou. Lista fechada no banco (check da 070) — o rótulo de
 * tela sai de PAYMENT_METHODS, no crmService.
 */
export type CrmPaymentMethod = 'pix' | 'credito' | 'debito' | 'boleto'

/**
 * Resultado de unificar dois cadastros do mesmo cliente (RPC
 * crm_merge_contacts, 077). Números, não "ok": é a operação mais delicada do
 * CRM e a tela precisa dizer o que de fato mudou de lugar.
 */
export interface CrmMergeResult {
  survivor_id: string
  survivor_name: string
  /** Vendas que passaram para o contato que ficou. */
  sales_moved: number
  /** Eventos da Meta que mudaram de dono, de qualquer status. */
  events_moved: number
  /** Quantos deles já estavam na Meta — e por isso NÃO serão reenviados. */
  events_already_sent: number
  /** Conversões que entraram na fila agora, uma por venda que ainda não tinha. */
  conversions_queued: number
}

export interface CrmSale {
  id: string
  organization_id: string
  contact_id: string
  /** Quantidade de criativos vendidos. 0 = não informado. */
  creatives: number
  value_cents: number
  /** null = não informada (vendas anteriores à 070 e as importadas). */
  payment_method: CrmPaymentMethod | null
  /** Data da venda — define o período dos relatórios e quem é a primeira. */
  sold_at: string
  note: string | null
  created_by: string | null
  created_at: string
  /**
   * Quando foi marcada como reembolsada (101). null = não reembolsada. A
   * venda continua no faturamento; o líquido desconta pela data do reembolso.
   */
  refunded_at?: string | null
  refunded_by?: string | null
  /**
   * Quanto foi devolvido no reembolso parcial (102). null com refunded_at
   * preenchido = reembolso total.
   */
  refunded_cents?: number | null
  /** Nota do reembolso (103). Só vale enquanto refunded_at estiver preenchido. */
  refund_note?: string | null
}

/** Uma venda reembolsada no período (crm_report_refunds, 101). */
export interface CrmRefundRow {
  sale_id: string
  contact_id: string
  name: string
  phone: string | null
  channel: string | null
  /** Valor da venda. */
  value_cents: number
  /** O que foi devolvido: o valor da venda no total, menos que isso no parcial (102). */
  refund_cents: number
  partial: boolean
  sold_at: string
  refunded_at: string
  refunded_by_name: string | null
}

/** Detalhe do reembolso de uma venda — o card clicável (crm_sale_refund_detail, 103). */
export interface CrmRefundDetail extends CrmRefundRow {
  refund_note: string | null
}

/** Arquivo anexado ao reembolso (crm_sale_refund_files, 103). */
export interface CrmRefundFile {
  id: string
  sale_id: string
  /** Caminho no bucket privado crm-refunds. */
  path: string
  name: string
  /** Tamanho no bucket, já comprimido. */
  size_bytes: number | null
  original_bytes: number | null
  mime_type: string | null
  /** 'gzip' = o objeto no bucket está em gzip (PDF) e é descompactado ao abrir. */
  encoding: 'gzip' | null
  created_at: string
}

export interface CrmStageHistory {
  id: string
  organization_id: string
  contact_id: string
  from_stage_id: string | null
  to_stage_id: string | null
  source: CrmHistorySource
  changed_by: string | null
  created_at: string
}

// ---------- Relatórios do CRM ----------
// Números chegam como string (bigint/numeric do Postgres) e são
// convertidos no service. Aqui já os declaramos como number.

/** KPIs de topo da aba Relatórios (coorte por criação no período). */
export interface CrmReportOverview {
  total_leads: number
  converted: number
  /** % com uma casa; null quando não houve nenhum lead no período. */
  conversion_rate: number | null
  revenue_cents: number
  avg_ticket_cents: number
  /** Tempo médio criação → 1ª conversão, em horas; null se ninguém converteu. */
  avg_hours_to_convert: number | null
}

/**
 * Conversões que ACONTECERAM na janela (fluxo), sem olhar quando o lead
 * entrou — a outra leitura do mesmo funil. O `converted` do CrmReportOverview
 * é coorte: dos leads criados no período, quantos fecharam. Os dois só batem
 * quando ninguém demora mais que a janela para converter.
 */
export interface CrmConversionsInPeriod {
  conversions: number
  /** Quantas vieram de leads criados ANTES da janela — a diferença para a coorte. */
  from_older_leads: number
  /** Valor somado dessas conversões — a contrapartida de fluxo da receita. */
  revenue_cents: number
  /** Quanto desse valor veio de leads criados ANTES da janela. */
  revenue_older_cents: number
  /**
   * false = o banco ainda tem a função da 048, sem as colunas de valor. Sem
   * este aviso o front mostraria R$ 0,00 — indistinguível de "ninguém
   * converteu", que é justamente a leitura errada.
   */
  has_revenue: boolean
}

/** Um dia da série temporal: leads que entraram x conversões ocorridas. */
export interface CrmReportPeriodRow {
  day: string
  leads: number
  conversions: number
}

/** Uma origem/canal com sua taxa de conversão de coorte. */
export interface CrmReportBreakdownRow {
  /** Rótulo do grupo — o valor de origem ou de canal. */
  label: string
  leads: number
  converted: number
  conversion_rate: number | null
  revenue_cents: number
}

// ---------- Relatório de vendas ----------
// Aqui é FLUXO por data da venda (sold_at), não coorte por criação do lead
// como nos relatórios de conversão acima.

/** Topo do relatório de vendas: período selecionado + histórico completo. */
export interface CrmSalesOverview {
  sales: number
  /** Vendas do período que foram a 1ª do cliente (as que converteram). */
  first_sales: number
  /** Vendas do período que foram recompra. */
  repeat_sales: number
  /** Clientes distintos com venda no período. */
  clients: number
  creatives: number
  revenue_cents: number
  /** Receita ÷ VENDAS do período — quanto vale uma venda. */
  avg_ticket_cents: number
  /**
   * Receita ÷ CLIENTES do período. Cuidado: é receita por cliente ativo na
   * janela, não o LTV do cliente — quem comprou antes do p_from entra aqui só
   * com o que gastou dentro dela. Para valor de cliente use total_ltv_cents.
   */
  ltv_cents: number
  /** Todo o histórico, sem filtro de período. */
  total_sales: number
  total_clients: number
  total_revenue_cents: number
  total_avg_ticket_cents: number
  /**
   * O LTV médio de verdade: tudo que já foi vendido ÷ clientes distintos.
   * É receita realizada, não projeção — cliente novo ainda vai comprar, então
   * a média cai quando entram muitos leads recentes. Serve para comparar com
   * o custo de aquisição.
   */
  total_ltv_cents: number
}

/** Um dia da série de vendas. */
export interface CrmSalesDayRow {
  day: string
  sales: number
  revenue_cents: number
  creatives: number
}

/** Uma linha da tabela "vendas por cliente". */
export interface CrmSalesContactRow {
  contact_id: string
  name: string
  channel: string | null
  sales: number
  creatives: number
  revenue_cents: number
  first_sale_at: string
  last_sale_at: string
}

/**
 * Linha da lista que abre pelo card "Conversões" da aba Funil (074). Mesma
 * população do `converted` de crm_report_overview: lead criado na janela que
 * passou pela etapa de conversão.
 */
export interface CrmConvertedContactRow {
  contact_id: string
  name: string | null
  phone: string | null
  channel: string | null
  origem: string | null
  created_at: string
  /** Data da 1ª venda; a entrada na etapa é a reserva de quem não tem venda. */
  converted_at: string
  /** Negativo quando a venda foi lançada com data anterior à entrada do lead. */
  hours_to_conv: number | null
  value_cents: number
  sales_count: number
  /** Quantos são no total, antes do limite da consulta. */
  total: number
}

/**
 * Linha das quebras "Vendas por origem" e "Vendas por canal" (076).
 *
 * Não confundir com CrmReportBreakdownRow, do Funil: aquela é coorte de
 * leads criados na janela; esta é faturamento da janela, com recompra.
 */
export interface CrmSalesBreakdownRow {
  /** null = contato sem o campo preenchido. */
  label: string | null
  sales: number
  first_sales: number
  repeat_sales: number
  clients: number
  revenue_cents: number
  avg_ticket_cents: number
  /** % do faturamento da janela; null quando não houve faturamento. */
  share: number | null
}

// ---------- Recompra ----------
// Três populações que não se comparam entre si, e por isso têm prefixos
// diferentes desde o banco (053): fluxo da janela, coorte que estreou nela
// e a base inteira. Misturá-las é o erro clássico deste relatório.

export interface CrmRepeatOverview {
  // 1. Fluxo: as vendas do período, partidas em duas
  sales: number
  first_sales: number
  repeat_sales: number
  revenue_cents: number
  first_revenue_cents: number
  repeat_revenue_cents: number
  /** Ticket da estreia e ticket de quem voltou — a comparação é o ponto. */
  first_ticket_cents: number
  repeat_ticket_cents: number

  // 2. Coorte: quem fez a 1ª compra da vida dentro da janela
  cohort_clients: number
  /** Destes, quantos já voltaram — inclusive depois do fim da janela. */
  cohort_repeaters: number
  /**
   * Enviesada para baixo por construção: quem estreou ontem não teve tempo
   * de voltar. A tela avisa isso em cima do número.
   */
  cohort_repeat_rate: number | null

  // 3. Base inteira: ignora o período de propósito
  total_clients: number
  repeat_clients: number
  once_clients: number
  repeat_rate: number | null
  avg_orders: number | null
  /** Mediana, não média: um retorno de dois anos distorceria a média. */
  median_days_to_second: number | null
  once_ltv_cents: number
  repeat_ltv_cents: number
}

/** Um balde da distribuição por número de compras. '5+' é o último. */
export interface CrmRepeatBucket {
  bucket: string
  ord: number
  clients: number
  sales: number
  revenue_cents: number
  avg_ltv_cents: number
}

/** Um dia da série, com o faturamento partido em estreia e retorno. */
export interface CrmRepeatDayRow {
  day: string
  first_sales: number
  repeat_sales: number
  first_revenue_cents: number
  repeat_revenue_cents: number
}

/** Cliente que recomprou na janela; os total_* são da vida inteira dele. */
export interface CrmRepeatTopRow {
  contact_id: string
  name: string
  channel: string | null
  repeat_in_period: number
  total_sales: number
  total_revenue_cents: number
  first_sale_at: string
  last_sale_at: string
  /** Ritmo do cliente: intervalo médio entre compras consecutivas. */
  avg_days_between: number | null
}

/** Cliente de uma compra só que já passou do tempo típico de retorno. */
export interface CrmRepeatPendingRow {
  contact_id: string
  name: string
  phone: string | null
  channel: string | null
  origem: string | null
  value_cents: number
  sold_at: string
  days_since: number
}

// ---------- Jornada do cliente (060) ----------
// Coorte por data de entrada do lead, como a aba Funil. O que estes números
// medem é o CAMINHO: onde a IA passa o bastão, onde o lead para, quanto
// tempo leva entre o orçamento e o dinheiro.
//
// Nada aqui mede mensagem: o banco não guarda conversa. Onde a pergunta
// pedia "respondeu", o dado é "avançou no funil" — está marcado no nome e
// dito na tela.

/** Topo da aba Jornada. */
export interface CrmJourneyOverview {
  total_leads: number
  /** Leads em que alguém do time tocou (moveu de etapa ou lançou venda). */
  human_leads: number
  /** human_leads ÷ total: a taxa de transferência IA → atendente. */
  transfer_rate: number | null
  avg_hours_to_human: number | null
  median_hours_to_human: number | null
  converted: number
  /**
   * Converteu com toque humano registrado. Não existe o par
   * "converteu sem humano": a IA não fecha venda, então conversão sem
   * sessão é falha de registro (automação, importação, venda retroativa)
   * e não vira métrica de resultado na tela.
   */
  human_converted: number
  /** Nunca teve humano, não converteu e está na etapa de perda ou parado. */
  abandoned_leads: number
  abandon_rate: number | null
  /**
   * Andou para frente no funil depois do primeiro atendimento humano. É o
   * substituto de "taxa de resposta": sem tabela de mensagens, movimentação
   * é o único sinal de que a conversa continuou.
   */
  advanced_after_human: number
  advance_rate: number | null
  budget_leads: number
  budget_converted: number
  budget_conversion_rate: number | null
  avg_hours_budget_to_conv: number | null
  median_hours_budget_to_conv: number | null
  /**
   * Papéis de etapa configurados (journey_role). Sem eles as métricas de
   * orçamento e de perda não têm de onde sair, e a tela pede a configuração
   * em vez de mostrar zero.
   */
  has_triagem_stage: boolean
  has_budget_stage: boolean
  has_loss_stage: boolean
  /** Dias de imobilidade que já contam como abandono. */
  stale_days: number
}

/** Uma linha da tabela de conversão por atendente. */
export interface CrmJourneyAssigneeRow {
  /**
   * O canal do contato, que aqui É o vendedor: cada um atende pelo próprio
   * número. null = contato sem canal preenchido.
   *
   * Não vem de assigned_to nem de changed_by — o primeiro ninguém preenche e
   * o segundo é nulo em tudo que a automação escreve.
   */
  vendedor: string | null
  leads: number
  converted: number
  conversion_rate: number | null
  revenue_cents: number
  avg_hours_to_convert: number | null
}

/** Um motivo de perda deduzido do rastro do lead. */
export interface CrmJourneyLossRow {
  motivo: string
  ord: number
  leads: number
  share: number | null
  /** Destes, quantos caíram pela automação da 050 em vez de decisão humana. */
  via_automacao: number
  /** Etapa mais comum do balde: onde a perda acontece. */
  etapa: string | null
  avg_days: number | null
  /** Total de perdas do período — igual em todas as linhas. */
  total_perdas: number
}

/** Um degrau do funil do CRM, com o vazamento até o degrau seguinte. */
export interface CrmJourneyStageFlowRow {
  /** null no degrau que não é coluna do kanban (o do portfólio, 083). */
  stage_id: string | null
  stage_name: string
  color: string
  ord: number
  is_conversion: boolean
  reached: number
  /**
   * Nulo no degrau que não está na corrente do funil (o do portfólio, 084):
   * ele não é etapa cumprida, então não há queda dele para o seguinte.
   */
  dropped: number | null
  drop_rate: number | null
  /**
   * Nulo no degrau de etiqueta: a tabela do bot não carimba quando cada
   * etiqueta entrou, então não há hora para medir.
   */
  avg_hours_to_reach: number | null
  /** 'crm' = coluna do kanban; 'etiqueta' = degrau vindo do banco do bot. */
  source: 'crm' | 'etiqueta'
  /**
   * Só no degrau de etiqueta: quantos receberam a etiqueta sem terem chegado
   * ao degrau anterior da corrente — receberam o portfólio pulando a
   * qualificação.
   */
  from_tag: number | null
}

/** Cruzamento de uma etapa de etiqueta com o CRM. */
export interface CrmJourneyTagRow {
  stage: string
  /** Linhas de etiqueta nesta etapa. */
  leads: number
  /** Destas, quantas acharam contato no CRM. O resto é lead sem cadastro. */
  matched: number
  converted: number
  conversion_rate: number | null
  revenue_cents: number
  human_leads: number
  avg_hours_to_convert: number | null
}

/**
 * Métricas de conversa (061). Aqui mora o que a 060 não conseguia medir: a
 * tabela conversation_messages vive no MESMO banco do CRM, então é join.
 *
 * `sender_type` só separa 'client' de 'agent', e a IA e o time mandam pelo
 * mesmo número — nenhum número daqui afirma "o humano respondeu". Quem
 * fornece o instante em que o time assumiu é o CRM.
 */
export interface CrmJourneyMessages {
  cohort_leads: number
  /** Leads da coorte com conversa casada por telefone. */
  with_messages: number
  /** Sem telefone não há como casar conversa nenhuma. */
  leads_sem_telefone: number
  client_replied: number
  /** A conversa existe e o cliente nunca falou: mandaram, ninguém respondeu. */
  never_replied: number
  rmkt_leads: number
  rmkt_replied: number
  rmkt_reply_rate: number | null
  /** Voltou E fechou: a conversão veio depois de cair no remarketing. */
  rmkt_converted: number
  converted_with_messages: number
  avg_msgs_to_convert: number | null
  median_msgs_to_convert: number | null
  avg_client_msgs_to_convert: number | null
  avg_agent_msgs_to_convert: number | null
  avg_msgs_per_lead: number | null
  /** Tempo até a 1ª saída depois da 1ª fala do lead — IA ou time. */
  median_hours_first_reply: number | null
  has_rmkt_stage: boolean
  total_messages: number
}

/**
 * Visão geral pelo relógio da conversa (062).
 *
 * Substitui a família de métricas de "toque humano" da 060. Aqui o vendedor
 * não mexe no CRM — quem escreve é o n8n, pela service role — então
 * `changed_by` não distingue vendedor de IA e não serve de âncora. O que tem
 * hora confiável é a mensagem.
 *
 * Nenhum campo daqui afirma QUEM respondeu: `sender_type = 'agent'` cobre
 * IA e time no mesmo número. Afirma que houve resposta.
 */
export interface CrmJourneyConversation {
  cohort_leads: number
  /** Sem telefone não há como casar conversa nenhuma. */
  leads_sem_telefone: number
  leads_sem_conversa: number
  /** O cliente falou ao menos uma vez: o denominador de tudo que é resposta. */
  leads_com_fala: number
  /** Saiu resposta depois da 1ª fala do lead (disparo anterior não conta). */
  answered_leads: number
  answer_rate: number | null
  unanswered_leads: number
  /** Sem resposta E já esfriou: conversa de ontem ainda é fila, não perda. */
  unanswered_stale: number
  unanswered_rate: number | null
  avg_hours_first_reply: number | null
  median_hours_first_reply: number | null
  /** O lead voltou a falar depois da nossa 1ª resposta. */
  re_replied_leads: number
  re_reply_rate: number | null
  /** Andou no funil depois da 1ª resposta (etapa à frente ou venda). */
  advanced_after_reply: number
  advance_after_reply_rate: number | null
  /** Dias de silêncio a partir dos quais "sem resposta" vira perda. */
  stale_days: number
}

/** Um lead sem conversão em que a última mensagem foi nossa. */
export interface CrmJourneySilentRow {
  contact_id: string
  name: string
  phone: string | null
  channel: string | null
  origem: string | null
  stage_name: string | null
  /** Responsável cadastrado. Não é lido na tela: o vendedor sai do canal. */
  assignee: string | null
  /** Última saída nossa. A fila é de quem não voltou depois dela. */
  last_agent_at: string
  /** null = o lead nunca falou nada, só recebeu. */
  last_client_at: string | null
  days_silent: number | null
  msgs: number
  total: number
}

/** Um lead parado numa etapa da jornada. */
export interface CrmJourneyTagContactRow {
  /** Número da conversa, como está na tabela de etiquetas. */
  numero: string
  /** null = a conversa existe no bot e o contato não existe no CRM. */
  contact_id: string | null
  name: string | null
  phone: string | null
  channel: string | null
  origem: string | null
  stage_name: string | null
  /** Responsável cadastrado. Não é lido na tela: o vendedor sai do canal. */
  assignee: string | null
  days_idle: number | null
  converted: boolean
  total: number
}

// ---------- Meta ADS: lado do CRM ----------
// "Cliente de anúncio" = contato com ctwa_clid, com clique de mídia paga na
// landing (fbc + campanha) ou com a origem declarando mídia paga. É a mesma
// regra que decide o envio da conversão para a Meta (crm_is_ad_contact,
// migrations 052/071) — não existe segunda definição.
//
// O custo NÃO está aqui: vem da Marketing API, pela Edge Function meta-ads.
// ROAS, CAC e CPL são calculados na tela, com um número de cada lado.

/** Topo da aba Meta ADS, pelo lado do banco. */
export interface CrmAdsOverview {
  /** Leads de anúncio criados na janela (coorte). */
  leads: number
  /** Destes, quantos têm clique rastreado — ctwa_clid ou fbc + campanha (100). */
  leads_ctwa: number
  /** Todos os leads da janela, de qualquer origem: denominador da fatia. */
  leads_all: number
  /** Contatos de anúncio cuja 1ª conversão da vida caiu na janela (fluxo). */
  conversions: number
  /** Contatos de anúncio cuja 1ª VENDA caiu na janela — a base do CAC. */
  new_clients: number
  /** Clientes de anúncio com qualquer venda na janela (inclui recompra). */
  clients: number
  sales: number
  first_sales: number
  repeat_sales: number
  creatives: number
  revenue_cents: number
  /** Receita ÷ vendas da janela. */
  avg_ticket_cents: number
  /** Receita ÷ clientes ativos na janela — não é o LTV do cliente. */
  ltv_period_cents: number
  /** Histórico completo dos clientes de anúncio (ignora a janela). */
  total_clients: number
  total_sales: number
  total_revenue_cents: number
  total_avg_ticket_cents: number
  /** O LTV de verdade: tudo que os clientes de anúncio já compraram ÷ eles. */
  total_ltv_cents: number
}

/** Um dia da série de ads. Receita por data da venda; leads por criação. */
export interface CrmAdsDayRow {
  day: string
  leads: number
  conversions: number
  sales: number
  revenue_cents: number
}

/** Receita de anúncio agrupada pelo rótulo da origem. */
export interface CrmAdsOrigemRow {
  origem: string
  leads: number
  clients: number
  sales: number
  revenue_cents: number
  avg_ticket_cents: number
}

// ---------- Meta ADS: lado da Marketing API ----------

/**
 * Um bloco de números vindo da Meta. O mesmo formato serve para o total da
 * conta, para um dia da série e para uma linha de campanha ou anúncio — os
 * três saem do mesmo endpoint, só muda o `level`.
 *
 * Valores monetários vêm em unidade INTEIRA da moeda da conta (reais, não
 * centavos) — é assim que a Meta responde, e converter aqui só criaria uma
 * chance a mais de errar por 100.
 */
export interface MetaAdsRow {
  date: string | null
  campaign_id: string | null
  campaign_name: string | null
  adset_name: string | null
  ad_id: string | null
  ad_name: string | null
  /** De qual conta veio a linha. null no total somado de várias contas. */
  account_id: string | null
  /** Rótulo local da conta, ou o nome dela na Meta. */
  account_label: string | null
  spend: number
  impressions: number
  reach: number
  clicks: number
  link_clicks: number
  landing_page_views: number
  ctr: number
  cpc: number
  cpm: number
  frequency: number
  /** Conversas iniciadas (Click-to-WhatsApp). */
  messaging: number
  cost_per_messaging: number | null
  /** Compras que a própria Meta atribuiu — vêm dos eventos da Conversion API. */
  purchases: number
  purchase_value: number
  leads: number
}

/** Uma linha da tabela "tudo que a Meta reportou" no nível da conta. */
export interface MetaAdsAction {
  type: string
  label: string
  value: number
  /** Custo por resultado, quando a Meta informa. */
  cost: number | null
  /** Valor de conversão, quando existe. */
  amount: number | null
}

/**
 * Uma conta de anúncios no resultado da consulta.
 *
 * `ok: false` numa conta não derruba o relatório: as outras somam
 * normalmente e a tela lista quem ficou de fora. Um total incompleto
 * anunciado vale mais que uma tela vazia — ou, pior, um total menor sem
 * aviso nenhum.
 */
export interface MetaAdsAccountResult {
  id: string
  /** Rótulo dado na configuração. */
  label: string | null
  /** Nome da conta na Meta. */
  name: string | null
  currency: string | null
  timezone: string | null
  /** 1 = ativa. Outro valor explica sozinho um gasto zerado. */
  status: number | null
  ok: boolean
  error: string | null
  hint: string | null
  /** Números só desta conta. null quando ela falhou. */
  totals: MetaAdsRow | null
}

/** Uma campanha que ficou fora dos totais, e quanto ela gastou no período. */
export interface MetaAdsExcludedCampaign {
  campaign_id: string | null
  campaign_name: string | null
  account_id: string | null
  account_label: string | null
  spend: number
}

/**
 * Campanha na lista de ignoradas da organização (crm_ad_excluded_campaigns).
 *
 * É configuração da org, não filtro de tela: se cada um pudesse ligar e
 * desligar, duas pessoas leriam ROAS diferentes do mesmo período.
 */
export interface CrmExcludedCampaign {
  id: string
  campaign_id: string
  campaign_name: string | null
  account_id: string | null
  /** Por que saiu — "recrutamento", "institucional". */
  note: string | null
  created_at: string
}

/** Resposta da Edge Function meta-ads. */
export interface MetaAdsInsights {
  ok: boolean
  /** false = nenhuma conta cadastrada ou nenhum token; a tela ensina o passo a passo. */
  configured: boolean
  error?: string
  /** O que fazer para resolver, quando dá para dizer. */
  hint?: string | null
  /** Primeira conta que respondeu. Mantido para compatibilidade. */
  account?: {
    id: string
    name: string | null
    currency: string | null
    timezone: string | null
    status: number | null
  }
  /** Todas as contas consultadas, inclusive as que falharam. */
  accounts?: MetaAdsAccountResult[]
  /** Moeda comum das contas. null quando elas divergem — aí não se soma. */
  currency?: string | null
  /**
   * false = há campanha ignorada, então o total veio da soma das campanhas
   * e o alcance conta duas vezes quem viu duas delas.
   */
  reach_exact?: boolean
  /** Campanhas ignoradas que veicularam no período, com o gasto que saiu. */
  excluded_campaigns?: MetaAdsExcludedCampaign[]
  /** Quantas campanhas estão na lista de ignoradas, tenham veiculado ou não. */
  excluded_total?: number
  /** true = contas em moedas diferentes; os totais em dinheiro não valem. */
  mixed_currency?: boolean
  /** Soma das contas que responderam. Razões (CTR, CPC, CPM) recalculadas. */
  totals?: MetaAdsRow
  /** Mesma janela, período imediatamente anterior. null no All-Time. */
  previous?: MetaAdsRow | null
  daily?: MetaAdsRow[]
  campaigns?: MetaAdsRow[]
  ads?: MetaAdsRow[]
  actions?: MetaAdsAction[]
}

/**
 * Uma conta de anúncios cadastrada na organização (crm_ad_accounts).
 * O token nunca chega ao cliente — só o booleano de que existe um.
 */
export interface CrmAdAccount {
  id: string
  account_id: string
  label: string | null
  has_token: boolean
  /** Ordem na lista. Não se chama `position` — ver a 058. */
  sort_order: number
  /**
   * Entra no relatório automático de campanhas (085). Desligada, a conta
   * continua cadastrada e continua somando na aba Meta ADS — o toggle vale
   * só para o relatório do WhatsApp.
   */
  is_active: boolean
}

/** Configuração da org — os access tokens nunca chegam ao cliente. */
export interface CrmSettings {
  meta_pixel_id: string | null
  has_token: boolean
  meta_test_event_code: string | null
  /** Página dos anúncios: sem ela a Meta recusa conversões de CTWA. */
  meta_page_id: string | null
  /**
   * Primeira conta de anúncios da org. Espelho de crm_ad_accounts mantido
   * pelo banco (058) — quem edita a lista é a seção de contas, não este
   * campo.
   */
  meta_ad_account_id: string | null
  /** Token dedicado com ads_read. Sem ele, o relatório usa o da CAPI. */
  has_ads_token: boolean
}

export interface CrmApiKey {
  id: string
  organization_id: string
  name: string
  key_prefix: string
  last_used_at: string | null
  revoked_at: string | null
  created_by: string | null
  created_at: string
}

// ---------- Atendimento (WhatsApp, 116) ----------

export type WaConversationStatus = 'aberta' | 'resolvida'

export interface WaConversation {
  id: string
  organization_id: string
  /** null = o número foi removido do painel; o histórico fica, sem resposta. */
  session_id: string | null
  remote_jid: string
  lid_jid: string | null
  /** Só dígitos, com DDI. null enquanto o WhatsApp só informou o LID. */
  phone: string | null
  push_name: string | null
  contact_id: string | null
  assigned_to: string | null
  assigned_at: string | null
  status: WaConversationStatus
  last_message_at: string | null
  last_message_preview: string | null
  last_message_from_me: boolean | null
  unread_count: number
  created_at: string
  updated_at: string
  /** Embed do contato do CRM — null quando não há vínculo ou a RLS não deixa ver. */
  crm_contacts?: { name: string } | null
}

export type WaMessageType =
  | 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker'
  | 'location' | 'contact' | 'reaction' | 'other'

export type WaMessageStatus = 'received' | 'pending' | 'sent' | 'delivered' | 'read' | 'failed'

export interface WaMessage {
  id: string
  conversation_id: string
  wa_message_id: string
  from_me: boolean
  sent_by: string | null
  type: WaMessageType
  body: string | null
  media_path: string | null
  media_mime: string | null
  media_name: string | null
  media_status: 'pendente' | 'ok' | 'falhou' | null
  status: WaMessageStatus
  wa_timestamp: string
  created_at: string
}

export interface WaSession {
  id: string
  instance_name: string
  phone_number: string | null
  status: SessionStatus
  chat_enabled: boolean
}

export interface WaAttendant {
  id: string
  name: string
  role: UserRole
}
