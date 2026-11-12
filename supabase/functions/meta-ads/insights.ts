/**
 * Tradução da resposta da Marketing API para o formato que a tela consome.
 *
 * Fora do index.ts de propósito: são funções puras, e num arquivo que
 * chama Deno.serve() no topo elas não podem ser exercitadas sem subir a
 * função inteira. Aqui um teste roda contra um payload real da Meta e
 * verifica o que de fato costuma quebrar — nome de action_type que muda
 * conforme o objetivo da campanha, campo ausente virando NaN, custo por
 * resultado que a Meta simplesmente não manda.
 */

/** Mesma versão da crm-worker: uma só para subir as duas juntas. */
export const META_API_VERSION = 'v21.0'

/**
 * Teto de linhas por quebra. A Meta pagina; sem limite explícito ela
 * devolve 25 e a tabela pareceria ter só as 25 primeiras campanhas. 200
 * cobre com folga uma conta real e cabe numa resposta só.
 */
export const BREAKDOWN_LIMIT = 200

/**
 * Uma métrica derivada de `actions`/`action_values` que a tela usa por
 * nome. A Meta nomeia a mesma coisa de formas diferentes conforme o tipo
 * de campanha e a janela de atribuição, então cada uma é uma LISTA de
 * candidatos em ordem de preferência — o primeiro que existir vence.
 *
 * Conversa iniciada é o caso mais bagunçado: campanha de Click-to-WhatsApp
 * reporta `total_messaging_connection`; contas antigas ainda devolvem
 * `messaging_conversation_started_7d`. Somar os dois contaria a mesma
 * conversa duas vezes.
 */
export const ACTION_KEYS = {
  messaging: [
    'onsite_conversion.total_messaging_connection',
    'onsite_conversion.messaging_conversation_started_7d',
    'onsite_conversion.messaging_first_reply',
  ],
  purchases: [
    'purchase',
    'offsite_conversion.fb_pixel_purchase',
    'omni_purchase',
  ],
  linkClicks: ['link_click'],
  landingPageViews: ['landing_page_view'],
  leads: ['lead', 'onsite_conversion.lead_grouped'],
} as const

/** Rótulos em pt-BR para a tabela "tudo que a Meta reportou". */
export const ACTION_LABELS: Record<string, string> = {
  'onsite_conversion.total_messaging_connection': 'Conversas iniciadas',
  'onsite_conversion.messaging_conversation_started_7d': 'Conversas iniciadas (7d)',
  'onsite_conversion.messaging_first_reply': 'Primeira resposta',
  'onsite_conversion.messaging_user_depth_2_message_send': 'Conversa com 2+ mensagens',
  'onsite_conversion.messaging_user_depth_3_message_send': 'Conversa com 3+ mensagens',
  'onsite_conversion.messaging_welcome_message_view': 'Mensagem de boas-vindas vista',
  'onsite_conversion.messaging_block': 'Bloqueios',
  link_click: 'Cliques no link',
  landing_page_view: 'Visualizações da página',
  post_engagement: 'Engajamento na publicação',
  page_engagement: 'Engajamento na Página',
  video_view: 'Visualizações de vídeo',
  lead: 'Leads',
  purchase: 'Compras',
  'offsite_conversion.fb_pixel_purchase': 'Compras (pixel)',
  omni_purchase: 'Compras (todos os canais)',
  post_reaction: 'Reações',
  comment: 'Comentários',
  onsite_conversion_post_save: 'Salvamentos',
}

export interface MetaAction {
  action_type: string
  value: string
}

export interface MetaInsightRow {
  date_start?: string
  date_stop?: string
  spend?: string
  impressions?: string
  reach?: string
  clicks?: string
  ctr?: string
  cpc?: string
  cpm?: string
  frequency?: string
  campaign_id?: string
  campaign_name?: string
  adset_id?: string
  adset_name?: string
  ad_id?: string
  ad_name?: string
  actions?: MetaAction[]
  action_values?: MetaAction[]
  cost_per_action_type?: MetaAction[]
}

/** "1234.56" → 1234.56; ausente ou lixo → 0. */
export function num(v: string | undefined | null): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Soma dos action_types pedidos, na ordem: vence o primeiro que existir. */
export function pickAction(list: MetaAction[] | undefined, keys: readonly string[]): number {
  if (!list?.length) return 0
  for (const key of keys) {
    const hit = list.find((a) => a.action_type === key)
    if (hit) return num(hit.value)
  }
  return 0
}

/** De qual conta veio a linha. Nulo no total somado de várias contas. */
export interface AdsRowAccount {
  id: string
  /** Rótulo local, se houver; senão o nome da Meta. Resolvido no index.ts. */
  label: string | null
}

/** Formato que a tela consome — o mesmo para total, dia, campanha e anúncio. */
export interface AdsRow {
  date: string | null
  campaign_id: string | null
  campaign_name: string | null
  adset_name: string | null
  ad_id: string | null
  ad_name: string | null
  account_id: string | null
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
  messaging: number
  cost_per_messaging: number | null
  purchases: number
  purchase_value: number
  leads: number
}

/**
 * O bloco de números que a tela consome. Vale para o total da conta, para
 * um dia da série e para uma linha de campanha/anúncio — os três vêm do
 * mesmo endpoint, só muda o `level`.
 *
 * `account` carimba de qual conta a linha veio. Com três contas na mesma
 * tabela de campanhas, sem esse carimbo duas campanhas homônimas em contas
 * diferentes seriam indistinguíveis na tela.
 */
export function shapeRow(row: MetaInsightRow, account?: AdsRowAccount): AdsRow {
  const spend = num(row.spend)
  const messaging = pickAction(row.actions, ACTION_KEYS.messaging)
  const purchases = pickAction(row.actions, ACTION_KEYS.purchases)

  return {
    date: row.date_start ?? null,
    campaign_id: row.campaign_id ?? null,
    campaign_name: row.campaign_name ?? null,
    adset_name: row.adset_name ?? null,
    ad_id: row.ad_id ?? null,
    ad_name: row.ad_name ?? null,
    account_id: account?.id ?? null,
    account_label: account?.label ?? null,

    spend,
    impressions: num(row.impressions),
    reach: num(row.reach),
    clicks: num(row.clicks),
    link_clicks: pickAction(row.actions, ACTION_KEYS.linkClicks),
    landing_page_views: pickAction(row.actions, ACTION_KEYS.landingPageViews),
    // Vêm prontos da Meta em vez de calculados aqui: CTR e CPC dela já
    // consideram a janela de atribuição da conta, e recalcular na mão
    // produziria um número parecido mas diferente do Gerenciador — que é
    // exatamente onde o usuário vai conferir.
    ctr: num(row.ctr),
    cpc: num(row.cpc),
    cpm: num(row.cpm),
    frequency: num(row.frequency),

    messaging,
    /** Custo por conversa iniciada. null quando não houve conversa. */
    cost_per_messaging: messaging > 0 ? spend / messaging : null,

    // Compras que a PRÓPRIA Meta atribuiu a estes anúncios — vêm dos
    // eventos que a crm-worker envia pela Conversion API. Não substituem a
    // receita do CRM (que é a verdade do caixa): servem para comparar o que
    // ela conseguiu atribuir com o que de fato foi vendido.
    purchases,
    purchase_value: pickAction(row.action_values, ACTION_KEYS.purchases),
    leads: pickAction(row.actions, ACTION_KEYS.leads),
  }
}

/** Uma linha de "tudo que a Meta reportou", já rotulada. */
export interface AdsAction {
  type: string
  label: string
  value: number
  /** Custo por resultado, quando a Meta informa. */
  cost: number | null
  /** Valor de conversão, quando existe. */
  amount: number | null
}

/** Toda a lista de `actions` do nível de conta, rotulada e com custo. */
export function shapeActions(row: MetaInsightRow | undefined): AdsAction[] {
  if (!row?.actions?.length) return []
  const custos = row.cost_per_action_type ?? []
  const valores = row.action_values ?? []
  return row.actions
    .map((a) => ({
      type: a.action_type,
      label: ACTION_LABELS[a.action_type] ?? a.action_type,
      value: num(a.value),
      cost: num(custos.find((c) => c.action_type === a.action_type)?.value) || null,
      amount: num(valores.find((c) => c.action_type === a.action_type)?.value) || null,
    }))
    .filter((a) => a.value > 0)
    .sort((a, b) => b.value - a.value)
}

export interface MetaError {
  message?: string
  code?: number
  error_subcode?: number
  error_user_title?: string
  error_user_msg?: string
  fbtrace_id?: string
}

/** Mesma ideia do formatMetaError da crm-worker: `message` sozinho não diz nada. */
export function formatMetaError(err: MetaError | undefined, status: number): string {
  if (!err) return `A Meta respondeu HTTP ${status} sem detalhe.`
  const parts = [err.message ?? `HTTP ${status}`]
  if (err.error_user_msg) parts.push(err.error_user_msg)
  else if (err.error_user_title) parts.push(err.error_user_title)
  if (err.code) parts.push(`code ${err.code}`)
  if (err.error_subcode) parts.push(`subcode ${err.error_subcode}`)
  return parts.join(' · ')
}

/** Dica acionável para os erros que a operação de fato encontra. */
export function hintFor(err: MetaError | undefined): string | null {
  const code = err?.code
  const sub = err?.error_subcode
  if (code === 190) return 'O token expirou ou foi revogado. Gere um novo e salve em Configurações › Integrações.'
  if (code === 200 || code === 10) {
    return 'O token não tem permissão ads_read nesta conta de anúncios. '
      + 'Gere um token de usuário de sistema com ads_read e acesso a esta conta.'
  }
  if (code === 100 && sub === 33) {
    return 'A conta de anúncios não existe ou o token não enxerga ela. '
      + 'Confira o ID (o número que aparece como act_XXXXXXXX no Gerenciador).'
  }
  if (code === 4 || code === 17 || code === 80000) {
    return 'Limite de requisições da Meta atingido. Tente de novo em alguns minutos.'
  }
  return null
}

// ------------------------------------------------------------
// SOMA ENTRE CONTAS
//
// A operação usa mais de uma conta de anúncios e quer o total. Somar é
// óbvio para gasto e impressão, e ERRADO para todo o resto:
//
//   • CTR, CPC, CPM e frequência são RAZÕES. Média das razões não é a razão
//     das somas — três contas com CTR 1%, 2% e 3% não dão 2% de CTR
//     conjunto, dão (cliques somados ÷ impressões somadas). Por isso aqui
//     elas são RECALCULADAS a partir dos totais, e não somadas nem
//     promediadas. Numa conta só a tela continua mostrando o valor que veio
//     pronto da Meta (shapeRow), que é o que bate com o Gerenciador.
//
//   • ALCANCE não é somável de verdade: a mesma pessoa alcançada por duas
//     contas conta duas vezes, e a Meta só deduplica isso dentro da mesma
//     conta. A soma daqui é um TETO, não o alcance real — a tela avisa.
//     Não há endpoint que resolva sem passar por relatório de BM.
//
//   • MOEDA: somar BRL com USD é inventar dinheiro. Quem decide se pode
//     somar é o index.ts, olhando as moedas das contas; estas funções só
//     fazem a aritmética.
// ------------------------------------------------------------

/** Zero absoluto, para somar em cima sem repetir 20 campos. */
function emptyRow(): AdsRow {
  return {
    date: null,
    campaign_id: null,
    campaign_name: null,
    adset_name: null,
    ad_id: null,
    ad_name: null,
    account_id: null,
    account_label: null,
    spend: 0,
    impressions: 0,
    reach: 0,
    clicks: 0,
    link_clicks: 0,
    landing_page_views: 0,
    ctr: 0,
    cpc: 0,
    cpm: 0,
    frequency: 0,
    messaging: 0,
    cost_per_messaging: null,
    purchases: 0,
    purchase_value: 0,
    leads: 0,
  }
}

/**
 * Soma linhas de contas diferentes num total só, recalculando as razões.
 *
 * Uma linha só entra e sai idêntica (as razões recalculadas coincidem com
 * as da Meta a menos de arredondamento) — mas ainda assim o chamador passa
 * a linha original quando há uma conta só, para a tela mostrar exatamente o
 * número do Gerenciador.
 */
export function mergeRows(rows: AdsRow[]): AdsRow {
  const total = emptyRow()
  for (const r of rows) {
    total.spend += r.spend
    total.impressions += r.impressions
    total.reach += r.reach
    total.clicks += r.clicks
    total.link_clicks += r.link_clicks
    total.landing_page_views += r.landing_page_views
    total.messaging += r.messaging
    total.purchases += r.purchases
    total.purchase_value += r.purchase_value
    total.leads += r.leads
  }

  // Razões a partir dos totais. Denominador zero vira 0 (e não NaN, que na
  // tela apareceria como "NaN%").
  total.ctr = total.impressions > 0 ? (total.clicks / total.impressions) * 100 : 0
  total.cpc = total.clicks > 0 ? total.spend / total.clicks : 0
  total.cpm = total.impressions > 0 ? (total.spend / total.impressions) * 1000 : 0
  total.frequency = total.reach > 0 ? total.impressions / total.reach : 0
  total.cost_per_messaging = total.messaging > 0 ? total.spend / total.messaging : null

  return total
}

/**
 * Série diária de várias contas numa só: um ponto por data, com o gasto
 * somado. Mantém a data em cada linha porque é por ela que a tela casa o
 * gasto com a receita do dia.
 *
 * Dia em que só uma conta veiculou aparece com o gasto dela — a Meta
 * simplesmente não devolve linha para conta parada, e tratar ausência como
 * zero é o comportamento certo aqui.
 */
export function mergeDaily(rows: AdsRow[]): AdsRow[] {
  const porDia = new Map<string, AdsRow[]>()
  for (const r of rows) {
    if (!r.date) continue
    const lista = porDia.get(r.date)
    if (lista) lista.push(r)
    else porDia.set(r.date, [r])
  }
  return [...porDia.entries()]
    .map(([date, lista]) => ({ ...mergeRows(lista), date }))
    .sort((a, b) => (a.date! < b.date! ? -1 : 1))
}

/**
 * "Tudo que a Meta reportou" das várias contas numa lista só.
 *
 * O custo por resultado é média PONDERADA pelo volume de cada conta, não
 * média simples: o custo da Meta é gasto ÷ resultados, então Σ(custo×valor)
 * ÷ Σ(valor) reconstrói exatamente gasto total ÷ resultados totais. Contas
 * que não informaram custo ficam fora do peso — o número resultante é o
 * custo das que informaram, e é melhor do que fingir que gastaram zero.
 */
export function mergeActions(lists: AdsAction[][]): AdsAction[] {
  const acc = new Map<string, {
    label: string
    value: number
    amount: number
    temAmount: boolean
    custoPonderado: number
    valorComCusto: number
  }>()

  for (const list of lists) {
    for (const a of list) {
      const atual = acc.get(a.type) ?? {
        label: a.label,
        value: 0,
        amount: 0,
        temAmount: false,
        custoPonderado: 0,
        valorComCusto: 0,
      }
      atual.value += a.value
      if (a.amount != null) {
        atual.amount += a.amount
        atual.temAmount = true
      }
      if (a.cost != null) {
        atual.custoPonderado += a.cost * a.value
        atual.valorComCusto += a.value
      }
      acc.set(a.type, atual)
    }
  }

  return [...acc.entries()]
    .map(([type, v]) => ({
      type,
      label: v.label,
      value: v.value,
      cost: v.valorComCusto > 0 ? v.custoPonderado / v.valorComCusto : null,
      amount: v.temAmount ? v.amount : null,
    }))
    .filter((a) => a.value > 0)
    .sort((a, b) => b.value - a.value)
}

/** `time_range` da Meta: JSON com as duas pontas, inclusive. */
export function timeRange(from: string, to: string): string {
  return JSON.stringify({ since: from, until: to })
}

/** Só dígitos e o prefixo que a Graph API espera — o usuário cola dos dois jeitos. */
export function normalizeAccount(id: string): string {
  const digits = id.trim().replace(/^act_/i, '').replace(/\D/g, '')
  return digits ? `act_${digits}` : ''
}
