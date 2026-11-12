/**
 * crmService — contatos, etapas do funil, configurações e chaves de API.
 *
 * Fala direto com o Supabase (RLS cuida do isolamento por organização),
 * no mesmo formato dos demais serviços do projeto. O que exige segredo ou
 * regra de servidor passa por RPC: configurações da Meta, chaves de API,
 * reordenação e exclusão de etapas.
 */

import { supabase } from '@/lib/supabase'
import { addDaysISO, spDayStartISO } from '@/lib/datetime'
import { asError } from '@/lib/dbError'
import { gunzipBlob, type CompressedFile } from '@/lib/compressFile'
import type {
  CrmPaymentMethod,
  CrmAdAccount,
  CrmAdsDayRow, CrmAdsOrigemRow, CrmAdsOverview, CrmApiKey, CrmContact,
  CrmRepeatBucket, CrmRepeatDayRow, CrmRepeatOverview, CrmRepeatPendingRow, CrmRepeatTopRow,
  CrmConversionsInPeriod, CrmConvertedContactRow, CrmExcludedCampaign,
  CrmJourneyAssigneeRow, CrmJourneyConversation, CrmJourneyLossRow, CrmJourneyMessages,
  CrmJourneyOverview, CrmJourneyRole, CrmJourneySilentRow,
  CrmJourneyStageFlowRow, CrmJourneyTagContactRow, CrmJourneyTagRow, CrmMergeResult,
  CrmReportBreakdownRow, CrmReportOverview, CrmReportPeriodRow, CrmSale,
  CrmRefundDetail, CrmRefundFile, CrmRefundRow, CrmSalesBreakdownRow, CrmSalesContactRow, CrmSalesDayRow, CrmSalesOverview, CrmSettings,
  CrmStage, CrmStageAutomation, CrmStageHistory, UserProfile,
} from '@/types'

/** Bucket privado dos anexos de reembolso (103). */
const REFUND_BUCKET = 'crm-refunds'
export const REFUND_FILE_MAX = 20 * 1024 * 1024

export function formatBytes(n: number | null | undefined) {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function refundTooBig(name: string, bytes: number) {
  return `"${name}" tem ${formatBytes(bytes)} mesmo depois de comprimido — o limite é ${formatBytes(REFUND_FILE_MAX)} por arquivo.`
}

/** Traduz o erro do storage para o que o usuário precisa fazer. */
function storageErrorMessage(name: string, msg: string) {
  if (/exceed|too large|payload|413|size/i.test(msg)) {
    return `"${name}" passa do tamanho máximo de ${formatBytes(REFUND_FILE_MAX)}.`
  }
  if (/quota|storage limit|insufficient|no space/i.test(msg)) {
    return 'Sem espaço livre no armazenamento — apague arquivos antigos ou aumente o plano antes de anexar.'
  }
  if (/mime|type/i.test(msg)) return `"${name}" não é PDF nem imagem.`
  return `Falha ao enviar "${name}": ${msg}`
}

export type ContactSort = 'recent' | 'name' | 'value' | 'stage_changed'

export interface ContactFilters {
  search?: string
  tags?: string[]
  stageId?: string
  /** true = só contatos fora do funil (base pré-implementação). */
  outOfFunnel?: boolean
  /** Canal de origem (WhatsApp de entrada). */
  channel?: string
  /** true = só contatos com o campo Origem vazio (lista de trabalho). */
  noOrigem?: boolean
  /** Uma origem só, como o seletor a mostra (crm_origens). */
  origem?: string
  /** 'with' = já compraram (sales_count > 0) — o "Convertido" da lista de contatos. */
  sales?: 'with'
  sort?: ContactSort
  page?: number
  pageSize?: number
}

/**
 * Janela dos relatórios: datas de calendário em São Paulo, inclusive nas
 * duas pontas ("YYYY-MM-DD"). O banco converte para instante (037) — assim
 * "hoje" é o dia inteiro, não "as últimas 24 horas".
 */
export interface DateRange {
  from: string
  to: string
}

/** Inverte se vier de trás para frente: o usuário escolheu as duas datas. */
function rangeArgs(range: DateRange): { p_from: string; p_to: string } {
  const [from, to] = range.from <= range.to
    ? [range.from, range.to]
    : [range.to, range.from]
  return { p_from: from, p_to: to }
}

/**
 * Filtros do kanban. A janela recorta pela data de ENTRADA do lead
 * (created_at), o mesmo recorte que a aba Funil dos relatórios chama de
 * "entrada" — e não por stage_changed_at, que o arquivamento (030) e as
 * automações (050) mexem sozinhos de madrugada.
 *
 * Pontas independentes: só `from`, só `to`, as duas ou nenhuma.
 */
export interface BoardFilters {
  channel?: string
  from?: string
  to?: string
}

/** Argumentos de janela para as RPCs do board — null = sem recorte. */
function boardRange(f: BoardFilters) {
  return { p_from: f.from || null, p_to: f.to || null }
}

export const DEFAULT_PAGE_SIZE = 25

/** Cards carregados por coluna do kanban antes do "carregar mais". */
export const BOARD_PAGE_SIZE = 20

/** Canal em uso e quantos contatos vieram dele. */
export interface ChannelCount {
  channel: string
  contact_count: number
}

/** Origem em uso e quantos contatos vieram dela. */
export interface OrigemCount {
  origem: string
  contact_count: number
}

/** Contagem e valor reais de uma etapa — vêm agregados do banco. */
export interface StageStats {
  stage_id: string
  contact_count: number
  total_value_cents: number
}

/**
 * Formas de pagamento, na ordem em que aparecem no seletor — do mais usado
 * para o menos. O `value` é o que vai para o banco (sem acento, sem caixa,
 * validado pelo check da 070); o `label` é só tela.
 */
export const PAYMENT_METHODS: Array<{ value: CrmPaymentMethod; label: string }> = [
  { value: 'pix', label: 'Pix' },
  { value: 'credito', label: 'Crédito' },
  { value: 'debito', label: 'Débito' },
  { value: 'boleto', label: 'Boleto' },
]

/** Rótulo de tela da forma de pagamento. null/desconhecida vira '—'. */
export function paymentLabel(method: string | null | undefined): string {
  return PAYMENT_METHODS.find((m) => m.value === method)?.label ?? '—'
}

/** Paleta das etapas — tons que funcionam sobre o fundo escuro do painel. */
export const STAGE_COLORS = [
  '#64748b', '#3b82f6', '#6366f1', '#a855f7',
  '#ec4899', '#f59e0b', '#0ea5e9', '#ef4444',
] as const

/** 25000 → "R$ 250,00" */
export function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

/**
 * "R$ 250,00" | "250,00" | "250.00" → 25000
 * Aceita o que o usuário digitar; a última vírgula ou ponto vira o decimal.
 */
export function parseBRL(input: string): number {
  const clean = input.replace(/[^\d,.-]/g, '').trim()
  if (!clean) return 0
  const lastComma = clean.lastIndexOf(',')
  const lastDot = clean.lastIndexOf('.')
  const sep = Math.max(lastComma, lastDot)
  // Separador só é decimal se sobrarem no máximo 2 casas depois dele.
  const isDecimal = sep > -1 && clean.length - sep - 1 <= 2
  const intPart = (isDecimal ? clean.slice(0, sep) : clean).replace(/\D/g, '')
  const decPart = isDecimal ? clean.slice(sep + 1).replace(/\D/g, '').padEnd(2, '0') : '00'
  return Number(intPart || '0') * 100 + Number(decPart.slice(0, 2) || '0')
}

/**
 * A origem declara anúncio? Espelha crm_origem_is_ad() do banco (033), que é
 * quem de fato decide o envio — aqui serve só para a tela avisar o que vai
 * acontecer ao salvar. Se mudar a regra lá, mude aqui junto.
 *
 * Palavra inteira, sem acento e sem caixa: "Leads" não pode casar com "ads".
 */
export function isAdOrigem(origem: string | null | undefined): boolean {
  const clean = (origem ?? '')
    // NFD separa a letra do acento; o range abaixo é o dos acentos soltos.
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
  return /(^|[^a-z0-9])(anuncio|anuncios|ads|trafego pago|midia paga)([^a-z0-9]|$)/.test(clean)
}

/** O que identifica o clique do lead — os dois funis de anúncio. */
type AdClick = Pick<CrmContact, 'ctwaclid' | 'fbc' | 'campaign_id'>

/**
 * O contato tem clique de anúncio guardado? É o que permite à Meta dizer de
 * QUAL anúncio a venda veio: ctwaclid no funil de Click-to-WhatsApp, fbc no
 * funil que passa por landing page (071).
 *
 * fbc sozinho não conta. O fbclid também é anexado a link orgânico do
 * Instagram; o id da campanha é o que prova que o clique foi de mídia paga.
 */
export function hasAdClick(contact: AdClick | null | undefined): boolean {
  return (contact?.ctwaclid ?? '').trim() !== ''
    || ((contact?.fbc ?? '').trim() !== '' && (contact?.campaign_id ?? '').trim() !== '')
}

/**
 * O contato veio de anúncio? Espelha crm_is_ad_contact() do banco (071) —
 * a mesma regra que decide o envio da conversão para a Meta e a população
 * do relatório de ADS. Aqui serve só para a tela avisar o que vai acontecer.
 * Se mudar a regra lá, mude aqui junto.
 *
 * A origem vem separada porque as telas avaliam a que está sendo DIGITADA,
 * não a que está salva no contato.
 */
export function isAdContact(
  contact: AdClick | null | undefined,
  origem: string | null | undefined,
): boolean {
  return hasAdClick(contact) || isAdOrigem(origem)
}

/** Telefone só com dígitos, do jeito que a Evolution/Meta esperam. */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '')
}

/** Canal entre aspas, ou o texto de quem não informou canal nenhum. */
export function canalLabel(channel: string | null | undefined): string {
  const c = (channel ?? '').trim()
  return c ? `“${c}”` : 'sem canal'
}

/**
 * Espelha crm_channel_key() do banco (069): canal é texto digitado por gente,
 * então "PH Creative" e "ph creative " são o MESMO canal. Comparar as duas
 * grafias como se fossem canais diferentes faria a tela duplicar cadastro à
 * toa — e o banco, com o índice único na mesma chave, recusaria.
 */
export function channelKey(channel: string | null | undefined): string {
  return (channel ?? '').trim().toLowerCase()
}

/**
 * Espelha crm_phone_key() do banco (044): só dígitos e, no celular brasileiro
 * de 13 dígitos, sem o 9 extra. É a coluna `phone_key` que a busca compara —
 * se a regra mudar lá, mude aqui junto.
 */
export function phoneKey(phone: string): string {
  const d = normalizePhone(phone)
  if (d.length === 13 && d.startsWith('55') && d[4] === '9') return d.slice(0, 4) + d.slice(5)
  return d
}

/**
 * Espelha crm_phone_id() do banco (069): o número local, de 10 ou 11
 * dígitos, ganha o 55 antes de virar phoneKey. É a coluna phone_id da tabela
 * de portfólio (091) — comparar por phoneKey deixaria de fora quem foi
 * registrado sem o 55.
 */
export function phoneId(phone: string): string {
  const d = normalizePhone(phone)
  return phoneKey(d.length === 10 || d.length === 11 ? `55${d}` : d)
}

/**
 * Chaves de telefone que podem corresponder ao que foi digitado.
 *
 * O vendedor digita do jeito que tem na mão: com ou sem o 55, com ou sem o 9
 * do celular, com ou sem formatação. A base tem as duas grafias por motivos
 * históricos (importação antiga, JID do WhatsApp). Então geramos as duas
 * pontas — o número como veio e o número com o 55 na frente, e o inverso para
 * quem digitou com 55 e o cadastro guardou sem — e comparamos por igualdade
 * com phone_key, que já derruba a diferença do 9.
 *
 * Piso de 8 dígitos: abaixo disso não é número, é pedaço — quem cuida do
 * pedaço é a busca por trecho, não a igualdade.
 */
export function phoneKeyVariants(input: string): string[] {
  const d = normalizePhone(input)
  if (!d) return []
  const out = new Set<string>()
  const add = (v: string) => { if (v.length >= 8) out.add(phoneKey(v)) }
  add(d)
  if (!d.startsWith('55')) add(`55${d}`)
  // Forma local (sem o país) do que foi digitado com 55.
  const local = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d
  if (local !== d) add(local)
  // E a local CURTA, sem o 9 do celular: é assim que a importação antiga
  // guardou parte da base (10 dígitos, sem 55 e sem o 9). Sem esta variante o
  // vendedor digitava o número completo e o cadastro não aparecia na lista —
  // o banco reconhecia (crm_phone_id, 069) e a tela não.
  if (local.length === 11 && local[2] === '9') add(local.slice(0, 2) + local.slice(3))
  return [...out]
}

/**
 * Normaliza as linhas de um relatório "por origem/canal" para o formato
 * único CrmReportBreakdownRow, convertendo os bigint/numeric (que chegam
 * como string) em number. `key` é o nome da coluna de rótulo na RPC.
 */
function mapBreakdown(data: unknown, key: 'origem' | 'channel'): CrmReportBreakdownRow[] {
  return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
    label: String(r[key] ?? ''),
    leads: Number(r.leads),
    converted: Number(r.converted),
    conversion_rate: r.conversion_rate == null ? null : Number(r.conversion_rate),
    revenue_cents: Number(r.revenue_cents),
  }))
}

interface ContactQuery {
  or: (f: string) => ContactQuery
  eq: (c: string, v: string | number) => ContactQuery
  gt: (c: string, v: number) => ContactQuery
  ilike: (c: string, v: string) => ContactQuery
  like: (c: string, v: string) => ContactQuery
  not: (c: string, op: string, v: string) => ContactQuery
  is: (c: string, v: null) => ContactQuery
  contains: (c: string, v: string[]) => ContactQuery
}

/**
 * Prepara o texto da busca da aba Contatos. Compartilhada pelo filtro da
 * lista e pela soma de vendas (RPC crm_contacts_sales_sum, 109), que têm de
 * casar as mesmas linhas.
 *
 * Telefone digitado com formatação ("+55 67 8409-0214"): o cadastro guarda
 * só dígitos, então o texto cru nunca casaria. Quando o texto parece
 * telefone, `digits` vem preenchido e telefone/conversation_id são
 * comparados por ele; phone_key (044) também, pelas variantes com/sem 55 e
 * com/sem o 9 do celular. Nome e email seguem com o texto digitado.
 */
function searchParts(search: string): { safe: string; digits: string; keys: string[] } {
  const safe = search.replace(/[%,()"\\:]/g, ' ')
  const digits = /^[\d\s+().-]+$/.test(search) ? normalizePhone(search) : ''
  return { safe, digits, keys: digits ? phoneKeyVariants(digits) : [] }
}

/**
 * Aplica os filtros da aba Contatos a uma consulta. Extraída para a
 * exportação usar EXATAMENTE os mesmos critérios da tela: um CSV que traz
 * linhas diferentes das que estão à vista é pior do que não ter CSV.
 *
 * Genérica no tipo do builder para servir tanto à consulta com `count`
 * quanto à da exportação, que não precisa dele.
 */
function applyContactFilters<T>(query: T, filters: ContactFilters): T {
  // Estrutural e sem genérico recursivo: tipar o builder do PostgREST por
  // extensão fazia o TypeScript estourar em "type instantiation is
  // excessively deep". O que importa aqui são os métodos usados.
  let q = query as unknown as ContactQuery
  const search = filters.search?.trim()
  if (search) {
    const { safe, digits, keys } = searchParts(search)
    if (digits) {
      const ors = [
        `name.ilike.%${safe}%`,
        `email.ilike.%${safe}%`,
        `phone.ilike.%${digits}%`,
        `phone_key.ilike.%${digits}%`,
        `conversation_id.ilike.%${digits}%`,
      ]
      for (const k of keys) ors.push(`phone_key.eq.${k}`)
      q = q.or(ors.join(','))
    } else {
      q = q.or(
        `name.ilike.%${safe}%,email.ilike.%${safe}%,phone.ilike.%${safe}%,conversation_id.ilike.%${safe}%`,
      )
    }
  }
  // contains: o contato precisa ter TODAS as etiquetas selecionadas.
  if (filters.tags?.length) q = q.contains('tags', filters.tags)
  if (filters.stageId) q = q.eq('stage_id', filters.stageId)
  if (filters.outOfFunnel) q = q.is('stage_id', null)
  if (filters.channel) q = q.eq('channel', filters.channel)
  // Mesma definição do relatório (034): campo vazio. Tanto o drawer quanto
  // a API gravam origem já com trim (vira null quando só tem espaço), então
  // null e '' cobrem o caso real — o btrim das RPCs é só reforço.
  if (filters.noOrigem) q = q.or('origem.is.null,origem.eq.')
  // Sem diferenciar caixa, como o agrupamento do seletor (038). O acento o
  // ilike NÃO iguala: se um dia existirem "Anúncio" e "anuncio", o seletor
  // mostra uma opção só (a grafia mais comum) e o filtro acha só os que
  // estão escritos com o mesmo acento. Em 21/10/2026 nenhuma origem tinha
  // duas grafias. % e _ escapados: aqui é igualdade, não padrão.
  if (filters.origem) q = q.ilike('origem', filters.origem.replace(/[\\%_]/g, (m) => `\\${m}`))
  // sales_count é mantido pelo banco (031) a cada venda lançada ou apagada.
  if (filters.sales === 'with') q = q.gt('sales_count', 0)
  return q as unknown as T
}

interface SortableQuery {
  order: (col: string, opts?: { ascending?: boolean }) => SortableQuery
}

/** A ordenação da lista, compartilhada entre a tela e a exportação. */
function applyContactSort<T>(query: T, sort: ContactSort | undefined): T {
  const q = query as unknown as SortableQuery
  switch (sort ?? 'recent') {
    // name_sort = coluna derivada que joga nomes com emoji/símbolo pro fim
    // (migration 021); ordem alfabética real fica com quem começa com letra.
    case 'name': return q.order('name_sort') as unknown as T
    case 'value': return q.order('value_cents', { ascending: false }) as unknown as T
    case 'stage_changed': return q.order('stage_changed_at', { ascending: false }) as unknown as T
    default: return q.order('created_at', { ascending: false }) as unknown as T
  }
}

interface TopQuery {
  order: (c: string) => { limit: (n: number) => Promise<{ data: CrmContact[] | null; error: unknown }> }
}
interface RestQuery {
  range: (a: number, b: number) => Promise<{ data: CrmContact[] | null; error: unknown; count: number | null }>
}

/**
 * Lista da aba Contatos para a busca de 4 dígitos: quem tem o telefone
 * terminando neles aparece primeiro; o restante (casou em outro trecho) vem
 * depois, na ordenação normal e sem repetir os da frente.
 *
 * O PostgREST não ordena por expressão, então são duas consultas: os
 * "terminados em" (poucos — 4 dígitos finais casam com uma fração mínima da
 * base; o teto de 200 é só segurança) e a página do restante, que preenche o
 * que sobrar da página. O offset é aplicado sobre a lista concatenada.
 */
async function listContactsFimTelefone(
  filters: ContactFilters,
  fim: string,
  page: number,
  pageSize: number,
): Promise<{ rows: CrmContact[]; total: number }> {
  const prioridade = applyContactFilters(
    supabase.from('crm_contacts').select('*'),
    filters,
  ) as unknown as ContactQuery
  const { data: topo, error: erroTopo } = await (prioridade.like('phone', `%${fim}`) as unknown as TopQuery)
    .order('id')
    .limit(200)
  if (erroTopo) throw erroTopo
  const frente = topo ?? []

  let resto = applyContactFilters(
    supabase.from('crm_contacts').select('*', { count: 'exact' }),
    filters,
  ) as unknown as ContactQuery
  if (frente.length) resto = resto.not('id', 'in', `(${frente.map((c) => c.id).join(',')})`)

  const offset = page * pageSize
  const daFrente = frente.slice(offset, offset + pageSize)
  const faltam = pageSize - daFrente.length
  const inicio = Math.max(0, offset - frente.length)
  // Mesmo com a página já cheia a consulta roda (pede 1 linha), pelo total.
  const { data, error, count } = await (applyContactSort(resto, filters.sort) as unknown as RestQuery)
    .range(inicio, inicio + Math.max(faltam, 1) - 1)
  if (error) throw error
  return {
    rows: [...daFrente, ...(data ?? []).slice(0, faltam)],
    total: (count ?? 0) + frente.length,
  }
}

/** Quantas linhas o PostgREST devolve por vez na exportação. */
const EXPORT_CHUNK = 1000

export const crmService = {
  // ---------- Etapas ----------

  /** Cria o funil padrão se a organização ainda não tiver etapas. */
  async bootstrap() {
    const { error } = await supabase.rpc('crm_bootstrap')
    if (error) throw error
  },

  async listStages(): Promise<CrmStage[]> {
    const { data, error } = await supabase
      .from('crm_stages')
      .select('*')
      .order('position')
      .returns<CrmStage[]>()
    if (error) throw error
    return data ?? []
  },

  async createStage(opts: {
    organizationId: string
    name: string
    color: string
    position: number
    isConversion?: boolean
  }): Promise<CrmStage> {
    // Etapa de conversão é única por org (índice parcial no banco): se esta
    // vai ser a nova, limpa a anterior antes para não violar a restrição.
    if (opts.isConversion) await clearConversionFlag()

    const { data, error } = await supabase
      .from('crm_stages')
      .insert({
        organization_id: opts.organizationId,
        name: opts.name,
        color: opts.color,
        position: opts.position,
        is_conversion: opts.isConversion ?? false,
      })
      .select()
      .single<CrmStage>()
    if (error) throw error
    return data
  },

  async updateStage(
    id: string,
    patch: Partial<Pick<CrmStage, 'name' | 'color' | 'is_conversion' | 'journey_role'>>,
  ) {
    if (patch.is_conversion) await clearConversionFlag(id)
    // Papel de jornada também é único por organização (060): sem liberar o
    // anterior, o índice recusaria o update com erro de chave duplicada.
    if (patch.journey_role) await clearJourneyRole(patch.journey_role, id)

    const { error } = await supabase.from('crm_stages').update(patch).eq('id', id)
    if (error) throw error
  },

  /** Persiste a nova ordem das colunas em uma transação só. */
  async reorderStages(ids: string[]) {
    const { error } = await supabase.rpc('crm_reorder_stages', { p_ids: ids })
    if (error) throw error
  },

  /**
   * Exclui a etapa. Se ela tiver contatos, moveTo é obrigatório — o banco
   * recusa a exclusão caso contrário, com mensagem pronta para a UI.
   */
  async deleteStage(id: string, opts: { moveTo?: string; unassign?: boolean } = {}) {
    const { error } = await supabase.rpc('crm_delete_stage', {
      p_id: id,
      p_move_to: opts.moveTo ?? null,
      p_unassign: opts.unassign ?? false,
    })
    if (error) throw error
  },

  // ---------- Contatos ----------

  /**
   * Lista paginada com busca, filtro por etiquetas e ordenação.
   * Devolve também o total, para a paginação saber quantas páginas existem.
   */
  async listContacts(filters: ContactFilters = {}): Promise<{ rows: CrmContact[]; total: number }> {
    const page = filters.page ?? 0
    const pageSize = filters.pageSize ?? DEFAULT_PAGE_SIZE

    // Busca de exatamente 4 dígitos: o vendedor costuma ter só o final do
    // número. Quem termina nesses dígitos vem antes do resto, que segue a
    // ordenação escolhida.
    const fim = filters.search?.trim() ?? ''
    if (/^\d{4}$/.test(fim)) return listContactsFimTelefone(filters, fim, page, pageSize)

    let query = applyContactFilters(
      supabase.from('crm_contacts').select('*', { count: 'exact' }),
      filters,
    )

    const { data, error, count } = await applyContactSort(query, filters.sort)
      .range(page * pageSize, page * pageSize + pageSize - 1)
      .returns<CrmContact[]>()
    if (error) throw error
    return { rows: data ?? [], total: count ?? 0 }
  },

  /**
   * Todos os contatos que casam com os filtros, para exportação.
   *
   * Pagina de propósito: o PostgREST corta a resposta em 1000 linhas por
   * padrão, então pedir "tudo" de uma vez devolveria um CSV silenciosamente
   * truncado — o pior tipo de bug num arquivo que a pessoa vai usar para
   * tomar decisão. O laço só para quando um bloco vem incompleto.
   *
   * Usa applyContactFilters, o MESMO construtor da tela: o CSV traz
   * exatamente as linhas que a lista mostra, sem paginação.
   *
   * `onProgress` existe porque uma base grande leva alguns segundos e o
   * botão precisa dizer que está trabalhando.
   */
  async exportContacts(
    filters: ContactFilters = {},
    onProgress?: (carregados: number) => void,
  ): Promise<CrmContact[]> {
    const todos: CrmContact[] = []
    for (let offset = 0; ; offset += EXPORT_CHUNK) {
      const query = applyContactFilters(supabase.from('crm_contacts').select('*'), filters)
      // Mesma ordenação da tela, para o CSV não sair numa ordem que o
      // usuário não pediu. O `.order('id')` no fim NÃO é decorativo: a
      // paginação por offset só é correta com ordem TOTAL, e todas as
      // chaves acima admitem empate (dois contatos com o mesmo valor, mesma
      // data). Sem o desempate, blocos consecutivos repetem e pulam linhas.
      const ordenada = applyContactSort(query, filters.sort).order('id')
      const { data, error } = await ordenada
        .range(offset, offset + EXPORT_CHUNK - 1)
        .returns<CrmContact[]>()
      if (error) throw error
      const bloco = data ?? []
      todos.push(...bloco)
      onProgress?.(todos.length)
      if (bloco.length < EXPORT_CHUNK) return todos
    }
  },

  /**
   * Soma do total de vendas (sales_total_cents) de todos os contatos que
   * casam com os filtros — o "quanto esse filtro vendeu" da lista.
   *
   * Soma no banco (RPC crm_contacts_sales_sum, 109): uma requisição que
   * devolve só o número, em vez de baixar os contatos em blocos de 1000. A
   * função espelha applyContactFilters — mudou um, mude o outro.
   */
  async sumContactsSales(filters: ContactFilters = {}): Promise<number> {
    const search = filters.search?.trim()
    const parts = search ? searchParts(search) : null
    const { data, error } = await supabase.rpc('crm_contacts_sales_sum', {
      p_safe: parts ? parts.safe : null,
      p_digits: parts?.digits || null,
      p_keys: parts?.keys.length ? parts.keys : null,
      p_tags: filters.tags?.length ? filters.tags : null,
      p_stage_id: filters.stageId ?? null,
      p_out_of_funnel: !!filters.outOfFunnel,
      p_channel: filters.channel ?? null,
      p_no_origem: !!filters.noOrigem,
      p_origem: filters.origem ? filters.origem.replace(/[\\%_]/g, (m) => `\\${m}`) : null,
      p_with_sales: filters.sales === 'with',
    })
    if (error) throw error
    return Number(data ?? 0)
  },

  /**
   * Primeira página do kanban: os N primeiros contatos de CADA etapa.
   *
   * Não carrega o funil inteiro de propósito — com uma base grande isso
   * significaria baixar milhares de cards que ninguém vê. Contatos fora do
   * funil (stage_id null) nunca entram aqui.
   */
  async listForBoard(perStage = BOARD_PAGE_SIZE, filters: BoardFilters = {}): Promise<CrmContact[]> {
    const { data, error } = await supabase.rpc('crm_board', {
      p_per_stage: perStage,
      p_channel: filters.channel || null,
      ...boardRange(filters),
    })
    if (error) throw error
    return (data as CrmContact[] | null) ?? []
  },

  /**
   * Contagem e soma reais por etapa, independentes do que foi carregado.
   * Recebe o mesmo canal do board: com filtro ativo, o cabeçalho precisa
   * contar só o que passa no filtro.
   */
  async stageStats(filters: BoardFilters = {}): Promise<StageStats[]> {
    const { data, error } = await supabase.rpc('crm_stage_stats', {
      p_channel: filters.channel || null,
      ...boardRange(filters),
    })
    if (error) throw error
    return (data as StageStats[] | null) ?? []
  },

  /** Canais em uso, para o seletor de filtro do funil. */
  async listChannels(): Promise<ChannelCount[]> {
    const { data, error } = await supabase.rpc('crm_channels')
    if (error) throw error
    return (data as ChannelCount[] | null) ?? []
  },

  /**
   * Origens em uso, para a lista do campo Origem. Já vêm agrupadas sem caixa
   * e sem acento pelo banco (038), com a grafia mais comum como rótulo —
   * então a lista não oferece "Anúncio" e "anuncio" como opções diferentes.
   */
  async listOrigens(): Promise<OrigemCount[]> {
    const { data, error } = await supabase.rpc('crm_origens')
    if (error) throw error
    return (data as OrigemCount[] | null) ?? []
  },

  /**
   * Regras de movimentação automática ativas (050). O funil usa só para
   * avisar na coluna quem sai dela sozinho — quem move é o pg_cron, de hora
   * em hora, e a tela não tem como (nem por que) antecipar isso.
   */
  async listStageAutomations(): Promise<CrmStageAutomation[]> {
    const { data, error } = await supabase.rpc('crm_stage_automations_list')
    if (error) throw error
    return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
      from_stage_id: String(r.from_stage_id),
      to_stage_id: String(r.to_stage_id),
      to_stage_name: String(r.to_stage_name),
      hours: Number(r.hours),
    }))
  },

  // ---------- Relatórios ----------
  // As RPCs devolvem bigint/numeric como string; convertemos para number
  // aqui, na fronteira, para o resto do front lidar só com números.

  /**
   * Dia mais antigo com atividade — início da janela "All-Time". null quando
   * a organização ainda não tem nada registrado.
   */
  async firstActivityDate(): Promise<string | null> {
    const { data, error } = await supabase.rpc('crm_first_activity_date')
    if (error) throw error
    return (data as string | null) ?? null
  },

  /** KPIs de topo do período. channel vazio = todos os canais. */
  async reportOverview(range: DateRange, channel?: string): Promise<CrmReportOverview> {
    const { data, error } = await supabase.rpc('crm_report_overview', { ...rangeArgs(range), p_channel: channel || null })
    if (error) throw error
    const r = (data as Record<string, unknown>[] | null)?.[0]
    return {
      total_leads: Number(r?.total_leads ?? 0),
      converted: Number(r?.converted ?? 0),
      conversion_rate: r?.conversion_rate == null ? null : Number(r.conversion_rate),
      revenue_cents: Number(r?.revenue_cents ?? 0),
      avg_ticket_cents: Number(r?.avg_ticket_cents ?? 0),
      avg_hours_to_convert: r?.avg_hours_to_convert == null ? null : Number(r.avg_hours_to_convert),
    }
  },

  /**
   * Conversões ocorridas na janela (fluxo), venha o lead de quando vier — a
   * contrapartida do `converted` do reportOverview, que é coorte.
   */
  async reportConversionsInPeriod(range: DateRange, channel?: string): Promise<CrmConversionsInPeriod> {
    const { data, error } = await supabase.rpc('crm_report_conversions_in_period', {
      ...rangeArgs(range), p_channel: channel || null,
    })
    if (error) throw error
    const r = (data as Record<string, unknown>[] | null)?.[0]
    return {
      conversions: Number(r?.conversions ?? 0),
      from_older_leads: Number(r?.from_older_leads ?? 0),
      revenue_cents: Number(r?.revenue_cents ?? 0),
      revenue_older_cents: Number(r?.revenue_older_cents ?? 0),
      // Chave ausente = função antiga (048). Zero de verdade vem como 0.
      has_revenue: r != null && r.revenue_cents !== undefined,
    }
  },

  /** Série diária: leads que entraram x conversões ocorridas. */
  async reportTimeseries(range: DateRange, channel?: string): Promise<CrmReportPeriodRow[]> {
    const { data, error } = await supabase.rpc('crm_report_timeseries', { ...rangeArgs(range), p_channel: channel || null })
    if (error) throw error
    return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
      day: String(r.day),
      leads: Number(r.leads),
      conversions: Number(r.conversions),
    }))
  },

  /** Conversão por origem (só origens preenchidas). */
  async reportByOrigem(range: DateRange, channel?: string): Promise<CrmReportBreakdownRow[]> {
    const { data, error } = await supabase.rpc('crm_report_by_origem', { ...rangeArgs(range), p_channel: channel || null })
    if (error) throw error
    return mapBreakdown(data, 'origem')
  },

  /** Conversão por canal (só canais preenchidos). */
  async reportByChannel(range: DateRange, channel?: string): Promise<CrmReportBreakdownRow[]> {
    const { data, error } = await supabase.rpc('crm_report_by_channel', { ...rangeArgs(range), p_channel: channel || null })
    if (error) throw error
    return mapBreakdown(data, 'channel')
  },

  // ---------- Relatório de vendas ----------
  // Fluxo por data da venda (sold_at), somando 1ª venda e recompra. Os
  // relatórios acima são de coorte por criação do lead — perguntas diferentes.

  /** Totais de vendas do período + histórico completo. */
  async reportSales(range: DateRange, channel?: string): Promise<CrmSalesOverview> {
    const { data, error } = await supabase.rpc('crm_report_sales', { ...rangeArgs(range), p_channel: channel || null })
    if (error) throw error
    const r = (data as Record<string, unknown>[] | null)?.[0]
    return {
      sales: Number(r?.sales ?? 0),
      first_sales: Number(r?.first_sales ?? 0),
      repeat_sales: Number(r?.repeat_sales ?? 0),
      clients: Number(r?.clients ?? 0),
      creatives: Number(r?.creatives ?? 0),
      revenue_cents: Number(r?.revenue_cents ?? 0),
      avg_ticket_cents: Number(r?.avg_ticket_cents ?? 0),
      ltv_cents: Number(r?.ltv_cents ?? 0),
      total_sales: Number(r?.total_sales ?? 0),
      total_clients: Number(r?.total_clients ?? 0),
      total_revenue_cents: Number(r?.total_revenue_cents ?? 0),
      total_avg_ticket_cents: Number(r?.total_avg_ticket_cents ?? 0),
      total_ltv_cents: Number(r?.total_ltv_cents ?? 0),
    }
  },

  /** Série diária de vendas: quantidade, faturamento e criativos. */
  async reportSalesTimeseries(range: DateRange, channel?: string): Promise<CrmSalesDayRow[]> {
    const { data, error } = await supabase.rpc('crm_report_sales_timeseries', { ...rangeArgs(range), p_channel: channel || null })
    if (error) throw error
    return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
      day: String(r.day),
      sales: Number(r.sales),
      revenue_cents: Number(r.revenue_cents),
      creatives: Number(r.creatives),
    }))
  },

  // ---------- Relatório de recompra ----------
  // Três recortes que não se comparam (053): fluxo da janela, coorte que
  // estreou nela e a base inteira. Vêm juntos numa chamada só porque a tela
  // mostra os três lado a lado — separá-los em RPCs não mudaria isso.

  async reportRepeatOverview(range: DateRange, channel?: string): Promise<CrmRepeatOverview> {
    const { data, error } = await supabase.rpc('crm_report_repeat_overview', {
      ...rangeArgs(range),
      p_channel: channel || null,
    })
    if (error) throw error
    const r = (data as Record<string, unknown>[] | null)?.[0]
    // As taxas e médias podem ser null de verdade (base vazia, ninguém
    // recomprou ainda) — vira '—' na tela, não zero.
    const opt = (v: unknown) => (v == null ? null : Number(v))
    return {
      sales: Number(r?.sales ?? 0),
      first_sales: Number(r?.first_sales ?? 0),
      repeat_sales: Number(r?.repeat_sales ?? 0),
      revenue_cents: Number(r?.revenue_cents ?? 0),
      first_revenue_cents: Number(r?.first_revenue_cents ?? 0),
      repeat_revenue_cents: Number(r?.repeat_revenue_cents ?? 0),
      first_ticket_cents: Number(r?.first_ticket_cents ?? 0),
      repeat_ticket_cents: Number(r?.repeat_ticket_cents ?? 0),
      cohort_clients: Number(r?.cohort_clients ?? 0),
      cohort_repeaters: Number(r?.cohort_repeaters ?? 0),
      cohort_repeat_rate: opt(r?.cohort_repeat_rate),
      total_clients: Number(r?.total_clients ?? 0),
      repeat_clients: Number(r?.repeat_clients ?? 0),
      once_clients: Number(r?.once_clients ?? 0),
      repeat_rate: opt(r?.repeat_rate),
      avg_orders: opt(r?.avg_orders),
      median_days_to_second: opt(r?.median_days_to_second),
      once_ltv_cents: Number(r?.once_ltv_cents ?? 0),
      repeat_ltv_cents: Number(r?.repeat_ltv_cents ?? 0),
    }
  },

  /** Distribuição por número de compras. Sempre da base inteira. */
  async reportRepeatDistribution(channel?: string): Promise<CrmRepeatBucket[]> {
    const { data, error } = await supabase.rpc('crm_report_repeat_distribution', {
      p_channel: channel || null,
    })
    if (error) throw error
    return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
      bucket: String(r.bucket),
      ord: Number(r.ord),
      clients: Number(r.clients),
      sales: Number(r.sales),
      revenue_cents: Number(r.revenue_cents),
      avg_ltv_cents: Number(r.avg_ltv_cents ?? 0),
    }))
  },

  /** Faturamento por dia, partido em estreia e retorno. */
  async reportRepeatTimeseries(range: DateRange, channel?: string): Promise<CrmRepeatDayRow[]> {
    const { data, error } = await supabase.rpc('crm_report_repeat_timeseries', {
      ...rangeArgs(range),
      p_channel: channel || null,
    })
    if (error) throw error
    return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
      day: String(r.day),
      first_sales: Number(r.first_sales),
      repeat_sales: Number(r.repeat_sales),
      first_revenue_cents: Number(r.first_revenue_cents),
      repeat_revenue_cents: Number(r.repeat_revenue_cents),
    }))
  },

  /** Quem voltou no período, com os números da vida inteira do cliente. */
  async reportRepeatTop(range: DateRange, channel?: string, limit = 15): Promise<CrmRepeatTopRow[]> {
    const { data, error } = await supabase.rpc('crm_report_repeat_top', {
      ...rangeArgs(range),
      p_channel: channel || null,
      p_limit: limit,
    })
    if (error) throw error
    return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
      contact_id: String(r.contact_id),
      name: String(r.name ?? ''),
      channel: r.channel == null ? null : String(r.channel),
      repeat_in_period: Number(r.repeat_in_period),
      total_sales: Number(r.total_sales),
      total_revenue_cents: Number(r.total_revenue_cents),
      first_sale_at: String(r.first_sale_at),
      last_sale_at: String(r.last_sale_at),
      avg_days_between: r.avg_days_between == null ? null : Number(r.avg_days_between),
    }))
  },

  /**
   * Fila de reativação: clientes de uma compra só, parados há mais de
   * `minDays`. Ignora o período do relatório de propósito — "não voltou" é
   * estado da carteira, não evento da janela. `total` é quantos casam com o
   * filtro ignorando o limite: é o que diz se ainda há fila além do bloco.
   */
  async reportRepeatPending(opts: {
    channel?: string
    minDays?: number
    limit?: number
  } = {}): Promise<{ rows: CrmRepeatPendingRow[]; total: number }> {
    const { data, error } = await supabase.rpc('crm_report_repeat_pending', {
      p_channel: opts.channel || null,
      p_min_days: Math.max(0, Math.round(opts.minDays ?? 0)),
      p_limit: opts.limit ?? 15,
    })
    if (error) throw error
    const raw = (data as Record<string, unknown>[] | null) ?? []
    return {
      rows: raw.map((r) => ({
        contact_id: String(r.contact_id),
        name: String(r.name ?? ''),
        phone: r.phone == null ? null : String(r.phone),
        channel: r.channel == null ? null : String(r.channel),
        origem: r.origem == null ? null : String(r.origem),
        value_cents: Number(r.value_cents),
        sold_at: String(r.sold_at),
        days_since: Number(r.days_since),
      })),
      // Sem linhas não há de onde ler o total: é zero mesmo.
      total: Number(raw[0]?.total ?? 0),
    }
  },

  // ---------- Relatório de Jornada (060) ----------
  // Coorte por entrada, como a aba Funil. O que o banco não tem é conversa:
  // "avançou depois do atendimento" ocupa o lugar de "respondeu", e o nome
  // do campo diz isso.

  async reportJourneyOverview(
    range: DateRange,
    channel?: string,
    origem?: string,
  ): Promise<CrmJourneyOverview> {
    const { data, error } = await supabase.rpc('crm_report_journey_overview', {
      ...rangeArgs(range),
      p_channel: channel || null,
      p_origem: origem || null,
    })
    if (error) throw error
    const r = (data as Record<string, unknown>[] | null)?.[0]
    // Taxas e médias podem ser null de verdade (ninguém foi atendido, nenhum
    // orçamento no período) — vira '—' na tela, não zero.
    const opt = (v: unknown) => (v == null ? null : Number(v))
    return {
      total_leads: Number(r?.total_leads ?? 0),
      human_leads: Number(r?.human_leads ?? 0),
      transfer_rate: opt(r?.transfer_rate),
      avg_hours_to_human: opt(r?.avg_hours_to_human),
      median_hours_to_human: opt(r?.median_hours_to_human),
      converted: Number(r?.converted ?? 0),
      human_converted: Number(r?.human_converted ?? 0),
      abandoned_leads: Number(r?.abandoned_leads ?? 0),
      abandon_rate: opt(r?.abandon_rate),
      advanced_after_human: Number(r?.advanced_after_human ?? 0),
      advance_rate: opt(r?.advance_rate),
      budget_leads: Number(r?.budget_leads ?? 0),
      budget_converted: Number(r?.budget_converted ?? 0),
      budget_conversion_rate: opt(r?.budget_conversion_rate),
      avg_hours_budget_to_conv: opt(r?.avg_hours_budget_to_conv),
      median_hours_budget_to_conv: opt(r?.median_hours_budget_to_conv),
      has_triagem_stage: Boolean(r?.has_triagem_stage),
      has_budget_stage: Boolean(r?.has_budget_stage),
      has_loss_stage: Boolean(r?.has_loss_stage),
      stale_days: Number(r?.stale_days ?? 7),
    }
  },

  async reportJourneyByAssignee(
    range: DateRange,
    channel?: string,
    origem?: string,
  ): Promise<CrmJourneyAssigneeRow[]> {
    const { data, error } = await supabase.rpc('crm_report_journey_by_assignee', {
      ...rangeArgs(range),
      p_channel: channel || null,
      p_origem: origem || null,
    })
    if (error) throw error
    return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
      vendedor: r.vendedor == null ? null : String(r.vendedor),
      leads: Number(r.leads),
      converted: Number(r.converted),
      conversion_rate: r.conversion_rate == null ? null : Number(r.conversion_rate),
      revenue_cents: Number(r.revenue_cents),
      avg_hours_to_convert: r.avg_hours_to_convert == null ? null : Number(r.avg_hours_to_convert),
    }))
  },

  /** Motivos de perda deduzidos — não há campo de motivo no banco. */
  async reportJourneyLosses(
    range: DateRange,
    channel?: string,
    origem?: string,
  ): Promise<CrmJourneyLossRow[]> {
    const { data, error } = await supabase.rpc('crm_report_journey_losses', {
      ...rangeArgs(range),
      p_channel: channel || null,
      p_origem: origem || null,
    })
    if (error) throw error
    return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
      motivo: String(r.motivo),
      ord: Number(r.ord),
      leads: Number(r.leads),
      share: r.share == null ? null : Number(r.share),
      via_automacao: Number(r.via_automacao),
      etapa: r.etapa == null ? null : String(r.etapa),
      avg_days: r.avg_days == null ? null : Number(r.avg_days),
      total_perdas: Number(r.total_perdas),
    }))
  },

  /**
   * Quem entrou no portfólio a partir do dia `from` (tabela da 091), como
   * phone_id — a chave de telefone do banco, igual à de phoneId().
   *
   * Só o piso da data: o relatório olha os leads que ENTRARAM no período, e
   * eles só podem ter chegado ao portfólio depois de entrar — mas podem ter
   * chegado depois do fim do período, e isso conta. Paginado porque o
   * PostgREST corta em mil linhas por resposta.
   */
  async listPortfolioPhoneIds(from: string): Promise<string[]> {
    const PAGE = 1000
    const ids: string[] = []
    for (let page = 0; page < 50; page += 1) {
      const { data, error } = await supabase
        .from('crm_portfolio_entries')
        .select('phone_id')
        .gte('entered_at', spDayStartISO(from))
        .order('entered_at')
        .range(page * PAGE, page * PAGE + PAGE - 1)
        .returns<{ phone_id: string }[]>()
      if (error) throw asError(error)
      const rows = data ?? []
      for (const r of rows) ids.push(r.phone_id)
      if (rows.length < PAGE) break
    }
    return ids
  },

  /**
   * Degraus do funil com o vazamento de cada um.
   *
   * `portfolio` são os telefones que entraram no portfólio — desde a 091, os
   * da tabela crm_portfolio_entries; antes, os da etiqueta da conversa. Eles
   * viram um degrau que NÃO é coluna do kanban (083) — nenhum contato muda
   * de etapa por causa disto.
   *
   * Se a 083 ainda não estiver aplicada, o Postgres não acha a função de
   * cinco argumentos e devolve PGRST202. Aí a chamada é refeita sem os
   * números: o funil aparece do jeito antigo, sem o degrau, em vez de a aba
   * inteira cair por causa de uma migration pendente.
   */
  async reportJourneyStageFlow(
    range: DateRange,
    channel?: string,
    origem?: string,
    portfolio?: string[],
  ): Promise<CrmJourneyStageFlowRow[]> {
    const args = {
      ...rangeArgs(range),
      p_channel: channel || null,
      p_origem: origem || null,
    }
    let { data, error } = portfolio?.length
      ? await supabase.rpc('crm_report_journey_stage_flow', { ...args, p_portfolio: portfolio })
      : await supabase.rpc('crm_report_journey_stage_flow', args)

    if (error && (error as { code?: string }).code === 'PGRST202') {
      ({ data, error } = await supabase.rpc('crm_report_journey_stage_flow', args))
    }
    if (error) throw error
    return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
      // Só o degrau de etiqueta vem sem id; String(null) daria a string
      // 'null', que viraria uma chave de React tão válida quanto errada.
      stage_id: r.stage_id == null ? null : String(r.stage_id),
      stage_name: String(r.stage_name),
      color: String(r.color),
      ord: Number(r.ord),
      is_conversion: Boolean(r.is_conversion),
      reached: Number(r.reached),
      dropped: r.dropped == null ? null : Number(r.dropped),
      drop_rate: r.drop_rate == null ? null : Number(r.drop_rate),
      avg_hours_to_reach: r.avg_hours_to_reach == null ? null : Number(r.avg_hours_to_reach),
      // Ausentes enquanto a 083 não estiver aplicada: aí tudo é degrau do CRM.
      source: r.source === 'etiqueta' ? 'etiqueta' : 'crm',
      from_tag: r.from_tag == null ? null : Number(r.from_tag),
    }))
  },

  /**
   * Cruza as etiquetas da conversa (lidas do outro Supabase pelo
   * jornadaService) com os contatos deste CRM. As linhas vão no corpo da
   * chamada porque não existe JOIN entre dois bancos — é o único caminho.
   */
  async reportJourneyTags(
    rows: { n: string; s: string; u: string }[],
    channel?: string,
  ): Promise<CrmJourneyTagRow[]> {
    // Sem etiqueta não há o que cruzar: evita um POST de corpo vazio.
    if (rows.length === 0) return []
    const { data, error } = await supabase.rpc('crm_report_journey_tags', {
      p_rows: rows,
      p_channel: channel || null,
    })
    if (error) throw error
    return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
      stage: String(r.stage),
      leads: Number(r.leads),
      matched: Number(r.matched),
      converted: Number(r.converted),
      conversion_rate: r.conversion_rate == null ? null : Number(r.conversion_rate),
      revenue_cents: Number(r.revenue_cents),
      human_leads: Number(r.human_leads),
      avg_hours_to_convert: r.avg_hours_to_convert == null ? null : Number(r.avg_hours_to_convert),
    }))
  },

  /**
   * Métricas de conversa (061): mensagens até a venda e retorno depois do
   * remarketing. Mesmo banco do CRM — o join com conversation_messages é por
   * telefone canônico.
   *
   * As colunas de "resposta depois de o time assumir" que a RPC ainda
   * devolve não são lidas: elas ancoravam em crm_first_human_touch, que aqui
   * mede quem abriu a tela, não quem atendeu. Quem responde isso agora é
   * reportJourneyConversation (062).
   */
  async reportJourneyMessages(
    range: DateRange,
    channel?: string,
    origem?: string,
  ): Promise<CrmJourneyMessages> {
    const { data, error } = await supabase.rpc('crm_report_journey_messages', {
      ...rangeArgs(range),
      p_channel: channel || null,
      p_origem: origem || null,
    })
    if (error) throw error
    const r = (data as Record<string, unknown>[] | null)?.[0]
    // Médias e taxas podem ser null de verdade (ninguém atendido, nenhuma
    // conversa casada) — vira '—' na tela, não zero.
    const opt = (v: unknown) => (v == null ? null : Number(v))
    return {
      cohort_leads: Number(r?.cohort_leads ?? 0),
      with_messages: Number(r?.with_messages ?? 0),
      leads_sem_telefone: Number(r?.leads_sem_telefone ?? 0),
      client_replied: Number(r?.client_replied ?? 0),
      never_replied: Number(r?.never_replied ?? 0),
      rmkt_leads: Number(r?.rmkt_leads ?? 0),
      rmkt_replied: Number(r?.rmkt_replied ?? 0),
      rmkt_reply_rate: opt(r?.rmkt_reply_rate),
      rmkt_converted: Number(r?.rmkt_converted ?? 0),
      converted_with_messages: Number(r?.converted_with_messages ?? 0),
      avg_msgs_to_convert: opt(r?.avg_msgs_to_convert),
      median_msgs_to_convert: opt(r?.median_msgs_to_convert),
      avg_client_msgs_to_convert: opt(r?.avg_client_msgs_to_convert),
      avg_agent_msgs_to_convert: opt(r?.avg_agent_msgs_to_convert),
      avg_msgs_per_lead: opt(r?.avg_msgs_per_lead),
      median_hours_first_reply: opt(r?.median_hours_first_reply),
      has_rmkt_stage: Boolean(r?.has_rmkt_stage),
      total_messages: Number(r?.total_messages ?? 0),
    }
  },

  /**
   * Visão geral pelo relógio da conversa (062): quantos leads receberam
   * resposta, em quanto tempo, quantos voltaram a falar e quantos andaram no
   * funil depois disso.
   *
   * Substitui as métricas de "toque humano" da 060 — com o n8n escrevendo
   * pela service role, changed_by não separa vendedor de IA. Não afirma quem
   * respondeu: sender_type 'agent' é qualquer saída.
   */
  async reportJourneyConversation(
    range: DateRange,
    channel?: string,
    origem?: string,
  ): Promise<CrmJourneyConversation> {
    const { data, error } = await supabase.rpc('crm_report_journey_conversation', {
      ...rangeArgs(range),
      p_channel: channel || null,
      p_origem: origem || null,
    })
    if (error) throw error
    const r = (data as Record<string, unknown>[] | null)?.[0]
    // Taxas e médias podem ser null de verdade (ninguém falou no período) —
    // vira '—' na tela, não zero.
    const opt = (v: unknown) => (v == null ? null : Number(v))
    return {
      cohort_leads: Number(r?.cohort_leads ?? 0),
      leads_sem_telefone: Number(r?.leads_sem_telefone ?? 0),
      leads_sem_conversa: Number(r?.leads_sem_conversa ?? 0),
      leads_com_fala: Number(r?.leads_com_fala ?? 0),
      answered_leads: Number(r?.answered_leads ?? 0),
      answer_rate: opt(r?.answer_rate),
      unanswered_leads: Number(r?.unanswered_leads ?? 0),
      unanswered_stale: Number(r?.unanswered_stale ?? 0),
      unanswered_rate: opt(r?.unanswered_rate),
      avg_hours_first_reply: opt(r?.avg_hours_first_reply),
      median_hours_first_reply: opt(r?.median_hours_first_reply),
      re_replied_leads: Number(r?.re_replied_leads ?? 0),
      re_reply_rate: opt(r?.re_reply_rate),
      advanced_after_reply: Number(r?.advanced_after_reply ?? 0),
      advance_after_reply_rate: opt(r?.advance_after_reply_rate),
      stale_days: Number(r?.stale_days ?? 7),
    }
  },

  /** Leads sem conversão em que a última mensagem foi nossa (062). */
  async reportJourneySilent(
    range: DateRange,
    channel?: string,
    limit = 15,
    origem?: string,
  ): Promise<{ rows: CrmJourneySilentRow[]; total: number }> {
    const { data, error } = await supabase.rpc('crm_report_journey_silent', {
      ...rangeArgs(range),
      p_channel: channel || null,
      p_limit: limit,
      p_origem: origem || null,
    })
    if (error) throw error
    const raw = (data as Record<string, unknown>[] | null) ?? []
    return {
      rows: raw.map((r) => ({
        contact_id: String(r.contact_id),
        name: String(r.name ?? ''),
        phone: r.phone == null ? null : String(r.phone),
        channel: r.channel == null ? null : String(r.channel),
        origem: r.origem == null ? null : String(r.origem),
        stage_name: r.stage_name == null ? null : String(r.stage_name),
        assignee: r.assignee == null ? null : String(r.assignee),
        // ?? '' porque a 062 pode não estar aplicada: a versão antiga da RPC
        // devolve human_at no lugar, e a coluna não é exibida na tela.
        last_agent_at: String(r.last_agent_at ?? ''),
        last_client_at: r.last_client_at == null ? null : String(r.last_client_at),
        days_silent: r.days_silent == null ? null : Number(r.days_silent),
        msgs: Number(r.msgs),
        total: Number(r.total),
      })),
      total: Number(raw[0]?.total ?? 0),
    }
  },

  /** Fila de uma etapa da jornada, do mais parado para o mais recente. */
  async reportJourneyTagContacts(opts: {
    rows: { n: string; s: string; u: string }[]
    stage: string
    channel?: string
    origem?: string
    limit?: number
  }): Promise<{ rows: CrmJourneyTagContactRow[]; total: number }> {
    if (opts.rows.length === 0) return { rows: [], total: 0 }
    const { data, error } = await supabase.rpc('crm_report_journey_tag_contacts', {
      p_rows: opts.rows,
      p_stage: opts.stage,
      p_channel: opts.channel || null,
      p_origem: opts.origem || null,
      p_limit: opts.limit ?? 15,
    })
    if (error) throw error
    const raw = (data as Record<string, unknown>[] | null) ?? []
    return {
      rows: raw.map((r) => ({
        numero: String(r.numero),
        contact_id: r.contact_id == null ? null : String(r.contact_id),
        name: r.name == null ? null : String(r.name),
        phone: r.phone == null ? null : String(r.phone),
        channel: r.channel == null ? null : String(r.channel),
        origem: r.origem == null ? null : String(r.origem),
        stage_name: r.stage_name == null ? null : String(r.stage_name),
        assignee: r.assignee == null ? null : String(r.assignee),
        days_idle: r.days_idle == null ? null : Number(r.days_idle),
        converted: Boolean(r.converted),
        total: Number(r.total),
      })),
      total: Number(raw[0]?.total ?? 0),
    }
  },

  // ---------- Relatório de Meta ADS (lado do CRM) ----------
  // Só o que o banco sabe: leads, vendas e receita dos contatos que vieram
  // de anúncio (crm_is_ad_contact, 052/071 — a mesma regra que decide o envio
  // da conversão para a Meta). O CUSTO vem da Marketing API, por
  // metaAdsService.

  /** Leads, vendas, receita, ticket e LTV dos clientes de anúncio. */
  async reportAdsOverview(range: DateRange, channel?: string): Promise<CrmAdsOverview> {
    const { data, error } = await supabase.rpc('crm_report_ads_overview', {
      ...rangeArgs(range),
      p_channel: channel || null,
    })
    if (error) throw error
    const r = (data as Record<string, unknown>[] | null)?.[0]
    return {
      leads: Number(r?.leads ?? 0),
      leads_ctwa: Number(r?.leads_ctwa ?? 0),
      leads_all: Number(r?.leads_all ?? 0),
      conversions: Number(r?.conversions ?? 0),
      new_clients: Number(r?.new_clients ?? 0),
      clients: Number(r?.clients ?? 0),
      sales: Number(r?.sales ?? 0),
      first_sales: Number(r?.first_sales ?? 0),
      repeat_sales: Number(r?.repeat_sales ?? 0),
      creatives: Number(r?.creatives ?? 0),
      revenue_cents: Number(r?.revenue_cents ?? 0),
      avg_ticket_cents: Number(r?.avg_ticket_cents ?? 0),
      ltv_period_cents: Number(r?.ltv_period_cents ?? 0),
      total_clients: Number(r?.total_clients ?? 0),
      total_sales: Number(r?.total_sales ?? 0),
      total_revenue_cents: Number(r?.total_revenue_cents ?? 0),
      total_avg_ticket_cents: Number(r?.total_avg_ticket_cents ?? 0),
      total_ltv_cents: Number(r?.total_ltv_cents ?? 0),
    }
  },

  /** Série diária de anúncio, para sobrepor investimento e retorno. */
  async reportAdsTimeseries(range: DateRange, channel?: string): Promise<CrmAdsDayRow[]> {
    const { data, error } = await supabase.rpc('crm_report_ads_timeseries', {
      ...rangeArgs(range),
      p_channel: channel || null,
    })
    if (error) throw error
    return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
      day: String(r.day),
      leads: Number(r.leads),
      conversions: Number(r.conversions),
      sales: Number(r.sales),
      revenue_cents: Number(r.revenue_cents),
    }))
  },

  /** Receita de anúncio pelo rótulo da origem — a quebra possível do lado CRM. */
  async reportAdsByOrigem(range: DateRange, channel?: string): Promise<CrmAdsOrigemRow[]> {
    const { data, error } = await supabase.rpc('crm_report_ads_by_origem', {
      ...rangeArgs(range),
      p_channel: channel || null,
    })
    if (error) throw error
    return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
      origem: String(r.origem ?? ''),
      leads: Number(r.leads),
      clients: Number(r.clients),
      sales: Number(r.sales),
      revenue_cents: Number(r.revenue_cents),
      avg_ticket_cents: Number(r.avg_ticket_cents ?? 0),
    }))
  },

  /** Quem mais comprou no período. */
  async reportSalesByContact(range: DateRange, channel?: string, limit = 20): Promise<CrmSalesContactRow[]> {
    const { data, error } = await supabase.rpc('crm_report_sales_by_contact', {
      ...rangeArgs(range),
      p_channel: channel || null,
      p_limit: limit,
    })
    if (error) throw error
    return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
      contact_id: String(r.contact_id),
      name: String(r.name ?? ''),
      channel: r.channel == null ? null : String(r.channel),
      sales: Number(r.sales),
      creatives: Number(r.creatives),
      revenue_cents: Number(r.revenue_cents),
      first_sale_at: String(r.first_sale_at),
      last_sale_at: String(r.last_sale_at),
    }))
  },

  /**
   * Os convertidos da coorte, para a lista que abre no card "Conversões".
   *
   * Mesmo recorte de crm_report_overview — se um dia divergirem, o card e a
   * lista passam a contar populações diferentes na mesma tela.
   */
  async reportConvertedContacts(
    range: DateRange,
    channel?: string,
    limit = 100,
  ): Promise<{ rows: CrmConvertedContactRow[]; total: number }> {
    const { data, error } = await supabase.rpc('crm_report_converted_contacts', {
      ...rangeArgs(range),
      p_channel: channel || null,
      p_limit: limit,
    })
    if (error) throw error
    const raw = (data as Record<string, unknown>[] | null) ?? []
    return {
      rows: raw.map((r) => ({
        contact_id: String(r.contact_id),
        name: r.name == null ? null : String(r.name),
        phone: r.phone == null ? null : String(r.phone),
        channel: r.channel == null ? null : String(r.channel),
        origem: r.origem == null ? null : String(r.origem),
        created_at: String(r.created_at),
        converted_at: String(r.converted_at),
        hours_to_conv: r.hours_to_conv == null ? null : Number(r.hours_to_conv),
        value_cents: Number(r.value_cents ?? 0),
        sales_count: Number(r.sales_count ?? 0),
        total: Number(r.total ?? 0),
      })),
      total: Number(raw[0]?.total ?? 0),
    }
  },

  /**
   * Faturamento da janela por origem ou por canal do contato (076).
   *
   * Recorta pela data da VENDA e conta recompra — não é a mesma quebra do
   * Funil, que é coorte de leads criados na janela.
   */
  async reportSalesBreakdown(
    range: DateRange,
    dim: 'origem' | 'canal',
    channel?: string,
  ): Promise<CrmSalesBreakdownRow[]> {
    const { data, error } = await supabase.rpc('crm_report_sales_breakdown', {
      ...rangeArgs(range),
      p_channel: channel || null,
      p_dim: dim,
    })
    if (error) throw error
    return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
      label: r.label == null ? null : String(r.label),
      sales: Number(r.sales ?? 0),
      first_sales: Number(r.first_sales ?? 0),
      repeat_sales: Number(r.repeat_sales ?? 0),
      clients: Number(r.clients ?? 0),
      revenue_cents: Number(r.revenue_cents ?? 0),
      avg_ticket_cents: Number(r.avg_ticket_cents ?? 0),
      share: r.share == null ? null : Number(r.share),
    }))
  },

  /**
   * Vendas reembolsadas no período, pela data do REEMBOLSO (101) — uma venda
   * de agosto reembolsada em setembro desconta em setembro. `total`/`cents`
   * valem para o período inteiro, mesmo quando a lista é cortada no limite.
   */
  async reportRefunds(
    range: DateRange,
    channel?: string,
    limit = 200,
  ): Promise<{ rows: CrmRefundRow[]; total: number; cents: number }> {
    const { data, error } = await supabase.rpc('crm_report_refunds', {
      ...rangeArgs(range),
      p_channel: channel || null,
      p_limit: limit,
    })
    if (error) throw asError(error)
    const raw = (data as Record<string, unknown>[] | null) ?? []
    return {
      rows: raw.map((r) => ({
        sale_id: String(r.sale_id),
        contact_id: String(r.contact_id),
        name: String(r.name ?? ''),
        phone: r.phone == null ? null : String(r.phone),
        channel: r.channel == null ? null : String(r.channel),
        value_cents: Number(r.value_cents ?? 0),
        // Antes da 102 a função não devolve refund_cents: todo reembolso é total.
        refund_cents: Number(r.refund_cents ?? r.value_cents ?? 0),
        partial: r.partial === true,
        sold_at: String(r.sold_at),
        refunded_at: String(r.refunded_at),
        refunded_by_name: r.refunded_by_name == null ? null : String(r.refunded_by_name),
      })),
      total: Number(raw[0]?.total_count ?? 0),
      cents: Number(raw[0]?.total_cents ?? 0),
    }
  },

  /** Próxima página de uma coluna do kanban ("carregar mais"). */
  async listStageContacts(
    stageId: string, offset: number, limit = BOARD_PAGE_SIZE, filters: BoardFilters = {},
  ): Promise<CrmContact[]> {
    let q = supabase.from('crm_contacts').select('*').eq('stage_id', stageId)
    if (filters.channel) q = q.eq('channel', filters.channel)
    // Mesmo recorte da 1ª página (crm_board, 057): sem isto o "carregar
    // mais" traria cards de fora do período e a coluna passaria a mostrar
    // mais do que o próprio cabeçalho conta.
    if (filters.from) q = q.gte('created_at', spDayStartISO(filters.from))
    if (filters.to) q = q.lt('created_at', spDayStartISO(addDaysISO(filters.to, 1)))
    // Mesma ordem de crm_board: entrada na etapa primeiro, com created_at e
    // id como desempate. A paginação por offset só bate com a 1ª página se
    // as duas consultas ordenam igual (ver migration 024).
    const { data, error } = await q
      .order('stage_changed_at', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id')
      .range(offset, offset + limit - 1)
      .returns<CrmContact[]>()
    if (error) throw error
    return data ?? []
  },

  /**
   * Busca geral do kanban: todos os contatos DENTRO do funil que casam com
   * o termo, por nome ou telefone, atravessando todas as colunas de uma vez.
   *
   * Não é paginado por etapa como o board normal — a busca já estreita o
   * resultado, então trazemos tudo (teto de segurança) e o Pipeline
   * distribui nas colunas. Contatos fora do funil (stage_id null) ficam de
   * fora: eles vivem na aba Contatos, não no kanban.
   */
  async searchBoard(term: string, filters: BoardFilters = {}): Promise<CrmContact[]> {
    // Escapa curingas do ilike e vírgula (que separa termos no .or()).
    const safe = term.replace(/[%,()"\\:]/g, ' ').trim()
    if (!safe) return []
    const digits = term.replace(/\D/g, '')
    const ors = [`name.ilike.%${safe}%`]
    // Telefone é guardado só com dígitos: casa pelo que o usuário digitou.
    if (digits) ors.push(`phone.ilike.%${digits}%`)

    let q = supabase.from('crm_contacts').select('*')
      .not('stage_id', 'is', null)
      .or(ors.join(','))
    if (filters.channel) q = q.eq('channel', filters.channel)
    if (filters.from) q = q.gte('created_at', spDayStartISO(filters.from))
    if (filters.to) q = q.lt('created_at', spDayStartISO(addDaysISO(filters.to, 1)))

    const { data, error } = await q
      .order('stage_id')
      .order('stage_changed_at', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id')
      .limit(500)
      .returns<CrmContact[]>()
    if (error) throw error
    return data ?? []
  },

  /**
   * Sugestão de contatos por nome OU número, para o lançamento de venda.
   *
   * Diferente de searchBoard: entra TODO contato, dentro ou fora do funil —
   * cliente antigo, arquivado depois de converter (030) ou vindo da
   * importação continua podendo comprar de novo, e ele precisa aparecer aqui
   * ou o vendedor cria um contato duplicado sem saber.
   *
   * O número casa mesmo digitado sem o 55 ou sem o 9 do celular: além do
   * trecho literal, comparamos phone_key (044) com as variantes do que foi
   * digitado. Sem isso, "11 99999-9999" não encontrava o cadastro salvo como
   * "5511999999999" — e a venda ia parar num contato novo, contando como
   * primeira compra de um cliente que já era cliente.
   *
   * Ordem: quem já comprou primeiro e, entre iguais, o mais recente. Os
   * contatos da importação antiga não têm venda e carregam data de 2025-01-01,
   * então afundam sozinhos na lista em vez de disputar o topo.
   */
  async searchContacts(term: string, limit = 8): Promise<CrmContact[]> {
    // Escapa curingas do ilike e vírgula/parênteses, que separam os termos
    // dentro do .or() do PostgREST.
    const safe = term.replace(/[%,()"\\:]/g, ' ').trim()
    const digits = normalizePhone(term)
    const ors: string[] = []
    if (safe) ors.push(`name.ilike.%${safe}%`)
    if (digits.length >= 3) {
      // Trecho literal: atende quem digita só os últimos dígitos.
      ors.push(`phone.ilike.%${digits}%`)
      ors.push(`phone_key.ilike.%${digits}%`)
      // Número inteiro, em qualquer das grafias que circulam.
      for (const k of phoneKeyVariants(digits)) ors.push(`phone_key.eq.${k}`)
    }
    if (!ors.length) return []

    const { data, error } = await supabase
      .from('crm_contacts')
      .select('*')
      .or(ors.join(','))
      .order('sales_count', { ascending: false })
      // Origem preenchida antes do cadastro cego — a mesma preferência que o
      // banco usa para escolher o dono do número (069). Aqui ela só ordena:
      // quem decide é o vendedor, olhando a lista.
      .order('origem', { nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(limit)
      .returns<CrmContact[]>()
    if (error) throw error
    return data ?? []
  },

  /** Usuários ativos da organização, para atribuir/filtrar responsável. */
  async listOrgUsers(): Promise<UserProfile[]> {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('is_active', true)
      .order('full_name')
      .returns<UserProfile[]>()
    if (error) throw error
    return data ?? []
  },

  /**
   * Etiquetas já usadas na organização, para escolher no lugar de redigitar.
   *
   * Agrega no cliente a partir dos contatos mais recentes: o PostgREST devolve
   * no máximo 1000 linhas por consulta, então varrer a tabela inteira não é
   * opção — e etiqueta que ninguém usa há milhares de contatos não é a que
   * alguém procura numa lista de sugestão.
   */
  async listTags(): Promise<string[]> {
    const { data, error } = await supabase
      .from('crm_contacts')
      .select('tags')
      .order('created_at', { ascending: false })
      .limit(1000)
      .returns<Array<{ tags: string[] }>>()
    if (error) throw error
    const all = new Set<string>()
    for (const row of data ?? []) for (const tag of row.tags ?? []) all.add(tag)
    return [...all].sort((a, b) => a.localeCompare(b, 'pt-BR'))
  },

  async createContact(opts: {
    organizationId: string
    /** null = criar fora do funil (não aparece no kanban). */
    stageId: string | null
    name: string
    email?: string
    phone?: string
    conversationId?: string
    channel?: string
    ctwaclid?: string
    sourceId?: string
    origem?: string
    tags?: string[]
    valueCents?: number
    description?: string
    assignedTo?: string
  }): Promise<CrmContact> {
    const { data, error } = await supabase
      .from('crm_contacts')
      .insert({
        organization_id: opts.organizationId,
        stage_id: opts.stageId,
        name: opts.name,
        email: opts.email || null,
        phone: opts.phone ? normalizePhone(opts.phone) : null,
        conversation_id: opts.conversationId || null,
        channel: opts.channel || null,
        ctwaclid: opts.ctwaclid || null,
        source_id: opts.sourceId || null,
        origem: opts.origem || null,
        tags: opts.tags ?? [],
        value_cents: opts.valueCents ?? 0,
        description: opts.description || null,
        assigned_to: opts.assignedTo || null,
      })
      .select()
      .single<CrmContact>()
    if (error) throw asError(error)
    return data
  },

  /**
   * Garante que existe UM contato para o número naquele canal (RPC do 069).
   *
   * Diferente de createContact, que insere e pronto: aqui o banco procura e
   * cria na MESMA transação, com trava na chave do número. É o caminho para
   * quem cria contato a partir de um telefone — o mesmo que a API usa — e é
   * o que impede dois cadastros para o mesmo cliente quando duas pessoas (ou
   * duas automações) lançam ao mesmo tempo.
   *
   * `created: false` significa que o número já era de alguém: quem chamou
   * precisa olhar o contato devolvido antes de tratar a venda como primeira.
   */
  async claimContact(opts: {
    organizationId: string
    phone?: string
    conversationId?: string
    name: string
    /** null = fora do funil (a 1ª venda leva para a conversão por trigger). */
    stageId?: string | null
    origem?: string
    channel?: string
  }): Promise<{ contactId: string; created: boolean; matchedBy: string }> {
    const { data, error } = await supabase.rpc('crm_contact_claim', {
      p_org: opts.organizationId,
      p_phone: opts.phone || null,
      p_conversation_id: opts.conversationId || null,
      p_name: opts.name,
      p_stage_id: opts.stageId ?? null,
      p_origem: opts.origem || null,
      p_channel: opts.channel || null,
    })
    if (error) throw asError(error)
    const row = (data as Array<{
      contact_id: string
      created: boolean
      matched_by: string
    }> | null)?.[0]
    if (!row) throw new Error('Não foi possível localizar ou criar o contato')
    return { contactId: row.contact_id, created: row.created, matchedBy: row.matched_by }
  },

  /**
   * O contato daquele número NAQUELE canal (RPC do 080).
   *
   * Irmã do claim, com a resposta diferente para o caso que motivou a 080: o
   * número existe, mas em OUTRO canal. O claim criaria um cadastro pelado;
   * este duplica o que já se sabe do cliente — nome, e-mail, etiquetas e os
   * dados de anúncio (ctwa_clid, source_id e o bloco do site inteiro) —, que
   * é o que mantém a venda atribuível.
   *
   * `copiedFrom` é o cadastro de onde veio a cópia: quem chamou usa para
   * dizer na tela que um segundo cadastro foi aberto, e não para outra coisa.
   */
  async contactForChannel(opts: {
    organizationId: string
    phone: string
    channel: string
    /** Faltando, o nome vem do cadastro copiado. Obrigatório se for cliente novo. */
    name?: string
    /** null = fora do funil (a 1ª venda leva para a conversão por trigger). */
    stageId?: string | null
    origem?: string
  }): Promise<{
    contactId: string
    created: boolean
    copiedFrom: string | null
    /** canal | canal-em-branco | copiado | novo */
    matchedBy: string
  }> {
    const { data, error } = await supabase.rpc('crm_contact_for_channel', {
      p_org: opts.organizationId,
      p_phone: opts.phone,
      p_channel: opts.channel || null,
      p_name: opts.name || null,
      p_stage_id: opts.stageId ?? null,
      p_origem: opts.origem || null,
    })
    if (error) throw asError(error)
    const row = (data as Array<{
      contact_id: string
      created: boolean
      copied_from: string | null
      matched_by: string
    }> | null)?.[0]
    if (!row) throw new Error('Não foi possível abrir o contato neste canal')
    return {
      contactId: row.contact_id,
      created: row.created,
      copiedFrom: row.copied_from,
      matchedBy: row.matched_by,
    }
  },

  /**
   * Move as vendas escolhidas para o cadastro do número naquele canal (089).
   *
   * O canal mora no CONTATO, não na venda (080), então mover de canal é
   * mover de cadastro: o de destino é criado na hora se não existir, e o de
   * origem fica com as vendas que sobraram. O aviso ao n8n sai do banco,
   * pela trigger da 088 — nada a disparar daqui.
   *
   * Os dados de anúncio da origem acompanham quando o destino não tem os
   * dele: sem isso a venda movida sairia órfã de atribuição e não viraria
   * Purchase atribuído na Meta.
   *
   * Todas as vendas têm de ser do mesmo contato; o banco recusa o resto.
   */
  async moveSalesToChannel(saleIds: string[], channel: string): Promise<{
    moved: number
    eventsMoved: number
    /** Conversões que voltaram para a fila da Meta com os dados do dono novo. */
    conversionsQueued: number
    targetContactId: string
    targetCreated: boolean
    /** canal | canal-em-branco | copiado | novo */
    targetMatchedBy: string
    /** O destino estava sem anúncio e herdou o da origem (081/089). */
    adsInherited: boolean
    sourceContactId: string
    /** 0 = o cadastro de origem ficou sem venda nenhuma. */
    sourceSalesLeft: number
  }> {
    const { data, error } = await supabase.rpc('crm_move_sales_to_channel', {
      p_sale_ids: saleIds,
      p_channel: channel,
    })
    if (error) throw asError(error)
    const row = (data as Array<{
      moved: number
      events_moved: number
      conversions_queued: number
      target_contact_id: string
      target_created: boolean
      target_matched_by: string
      ads_inherited: boolean
      source_contact_id: string
      source_sales_left: number
    }> | null)?.[0]
    if (!row) throw new Error('Não foi possível mover as vendas de canal')
    return {
      moved: row.moved,
      eventsMoved: row.events_moved,
      conversionsQueued: row.conversions_queued,
      targetContactId: row.target_contact_id,
      targetCreated: row.target_created,
      targetMatchedBy: row.target_matched_by,
      adsInherited: row.ads_inherited,
      sourceContactId: row.source_contact_id,
      sourceSalesLeft: row.source_sales_left,
    }
  },

  /**
   * Quem já ocupa (telefone, canal) — a chave do índice único da 069.
   *
   * A pergunta que a tela do contato faz ANTES de aceitar a troca de canal, e
   * de novo DEPOIS do 409, para dizer de quem é o cadastro que está no
   * caminho. Roda com os direitos de quem chama: contato que a RLS esconde
   * volta como null, e aí a tela fala em termos genéricos.
   */
  async channelConflict(phone: string, channel: string, ignoreId?: string): Promise<{
    id: string
    name: string
    salesCount: number
    channel: string | null
  } | null> {
    const { data, error } = await supabase.rpc('crm_channel_conflict', {
      p_phone: phone,
      p_channel: channel || null,
      p_ignore: ignoreId ?? null,
    })
    if (error) throw asError(error)
    const row = (data as Array<{
      contact_id: string
      contact_name: string
      sales_count: number
      channel: string | null
    }> | null)?.[0]
    return row
      ? { id: row.contact_id, name: row.contact_name, salesCount: row.sales_count, channel: row.channel }
      : null
  },

  /**
   * Herda os dados de anúncio do cadastro deste número em outro canal (081).
   *
   * Chamada logo depois de criar um contato à mão: se o cliente já existe no
   * outro WhatsApp com ctwa_clid (ou com o clique da landing), o cadastro
   * novo nasceria sem atribuição nenhuma e a venda que saísse dele não
   * chegaria à Meta ligada ao anúncio que trouxe o cliente.
   *
   * A regra inteira mora no banco e a função se guarda sozinha: cadastro que
   * já tem anúncio próprio, cadastro sem telefone e cadastro que não é mais
   * recém-criado não herdam nada. Devolve o contato de onde copiou, ou null
   * quando não havia o que fazer — quem chama não precisa decidir.
   */
  async inheritAds(contactId: string): Promise<string | null> {
    const { data, error } = await supabase.rpc('crm_contact_inherit_ads', {
      p_contact: contactId,
    })
    if (error) throw asError(error)
    return (data as string | null) ?? null
  },

  async updateContact(id: string, patch: {
    name?: string
    email?: string | null
    phone?: string | null
    conversationId?: string | null
    channel?: string | null
    ctwaclid?: string | null
    sourceId?: string | null
    origem?: string | null
    tags?: string[]
    valueCents?: number
    description?: string | null
    /** null = tirar do funil; undefined = não mexer na etapa. */
    stageId?: string | null
    /** null = tirar o responsável; undefined = não mexer. */
    assignedTo?: string | null
  }) {
    const row: Record<string, unknown> = {}
    if (patch.name !== undefined) row.name = patch.name
    if (patch.email !== undefined) row.email = patch.email || null
    if (patch.phone !== undefined) row.phone = patch.phone ? normalizePhone(patch.phone) : null
    if (patch.conversationId !== undefined) row.conversation_id = patch.conversationId || null
    if (patch.channel !== undefined) row.channel = patch.channel || null
    if (patch.ctwaclid !== undefined) row.ctwaclid = patch.ctwaclid || null
    if (patch.sourceId !== undefined) row.source_id = patch.sourceId || null
    if (patch.origem !== undefined) row.origem = patch.origem || null
    if (patch.tags !== undefined) row.tags = patch.tags
    if (patch.valueCents !== undefined) row.value_cents = patch.valueCents
    if (patch.description !== undefined) row.description = patch.description || null
    if (patch.stageId !== undefined) row.stage_id = patch.stageId || null
    if (patch.assignedTo !== undefined) row.assigned_to = patch.assignedTo || null

    // .select() é obrigatório aqui: sem ele o PostgREST responde 204 mesmo
    // quando a RLS barra a linha, e o painel dizia "Contato atualizado" sem
    // ter gravado nada. Com o retorno, zero linhas vira erro visível.
    const { data, error } = await supabase
      .from('crm_contacts')
      .update(row)
      .eq('id', id)
      .select('id')
    if (error) throw asError(error)
    if (!data?.length) {
      throw new Error('Nada foi gravado — seu usuário não tem permissão para editar este contato.')
    }
  },

  /**
   * Move um contato de etapa. O histórico e o evento de conversão são
   * gerados por trigger no banco — aqui só o update é necessário.
   */
  async moveContact(id: string, stageId: string, position = 0) {
    const { data, error } = await supabase
      .from('crm_contacts')
      .update({ stage_id: stageId, position })
      .eq('id', id)
      .select('id')
    if (error) throw error
    if (!data?.length) {
      throw new Error('Nada foi gravado — seu usuário não tem permissão para mover este contato.')
    }
  },

  async deleteContact(id: string) {
    const { data, error } = await supabase
      .from('crm_contacts')
      .delete()
      .eq('id', id)
      .select('id')
    if (error) throw error
    if (!data?.length) {
      throw new Error('Nada foi excluído — seu usuário não tem permissão para excluir este contato.')
    }
  },

  /**
   * Relê um contato. Usado depois de registrar/excluir venda: o banco pode
   * ter movido o contato para a etapa de conversão e recalculado os valores,
   * e a tela precisa refletir isso sem fechar o painel.
   */
  async getContact(id: string): Promise<CrmContact> {
    const { data, error } = await supabase
      .from('crm_contacts')
      .select('*')
      .eq('id', id)
      .single<CrmContact>()
    if (error) throw error
    return data
  },

  // ---------- Vendas ----------
  // Regras de negócio ficam no banco (migration 031): a trigger recalcula os
  // totais do contato e, na PRIMEIRA venda, move o contato para a etapa de
  // conversão — o que dispara o evento na Meta pelo caminho já existente.
  // Recompra não mexe em etapa nenhuma. O front só insere/exclui a linha.

  /** Vendas do contato, da mais antiga para a mais nova (a 1ª é a conversão). */
  async listSales(contactId: string): Promise<CrmSale[]> {
    const { data, error } = await supabase
      .from('crm_sales')
      .select('*')
      .eq('contact_id', contactId)
      // Mesma ordem da trigger e dos relatórios: sold_at com created_at e id
      // de desempate. É ela que define qual venda é a primeira.
      .order('sold_at')
      .order('created_at')
      .order('id')
      .returns<CrmSale[]>()
    if (error) throw error
    return data ?? []
  },

  /**
   * Registra uma venda. organization_id não é enviado de propósito: a
   * trigger crm_sales_stamp copia do contato, então não há como lançar venda
   * no contato de outra organização.
   */
  async addSale(opts: {
    contactId: string
    creatives: number
    valueCents: number
    /** ISO date/datetime; ausente = agora. */
    soldAt?: string
    note?: string
    /** Como o cliente pagou. Ausente = não informada. */
    paymentMethod?: CrmPaymentMethod | null
  }): Promise<CrmSale> {
    const { data, error } = await supabase
      .from('crm_sales')
      .insert({
        contact_id: opts.contactId,
        creatives: opts.creatives,
        value_cents: opts.valueCents,
        ...(opts.soldAt ? { sold_at: opts.soldAt } : {}),
        note: opts.note || null,
        payment_method: opts.paymentMethod || null,
      })
      .select()
      .single<CrmSale>()
    if (error) throw error
    return data
  },

  async updateSale(id: string, patch: {
    creatives?: number
    valueCents?: number
    soldAt?: string
    note?: string | null
    /** null limpa (volta a "não informada"); undefined não mexe. */
    paymentMethod?: CrmPaymentMethod | null
  }) {
    const row: Record<string, unknown> = {}
    if (patch.creatives !== undefined) row.creatives = patch.creatives
    if (patch.valueCents !== undefined) row.value_cents = patch.valueCents
    if (patch.soldAt !== undefined) row.sold_at = patch.soldAt
    if (patch.note !== undefined) row.note = patch.note || null
    if (patch.paymentMethod !== undefined) row.payment_method = patch.paymentMethod || null

    const { data, error } = await supabase
      .from('crm_sales')
      .update(row)
      .eq('id', id)
      .select('id')
    if (error) throw error
    if (!data?.length) {
      throw new Error('Nada foi gravado — seu usuário não tem permissão para editar vendas.')
    }
  },

  /**
   * Exclui a venda. Se era a primeira, a conversão já registrada NÃO é
   * desfeita (o histórico é durável e o evento já foi para a Meta) — a venda
   * seguinte passa a ser o valor da conversão.
   */
  async deleteSale(id: string) {
    const { data, error } = await supabase
      .from('crm_sales')
      .delete()
      .eq('id', id)
      .select('id')
    if (error) throw error
    if (!data?.length) {
      throw new Error('Nada foi excluído — seu usuário não tem permissão para excluir vendas.')
    }
  },

  /**
   * Marca (ou desmarca) a venda como reembolsada (101). A venda FICA: não
   * dispara o webhook de exclusão nem o de alteração. Data e autor quem põe
   * é o banco — aqui só se diz sim ou não.
   *
   * `cents` é o valor devolvido no reembolso parcial (102); sem ele, ou com o
   * valor inteiro da venda, o reembolso é total — o banco normaliza.
   *
   * `note` é a nota do reembolso (103). undefined não mexe nela — é o que o
   * desfazer manda, para a nota voltar se a venda for marcada de novo.
   */
  async setSaleRefunded(
    id: string,
    refunded: boolean,
    cents: number | null = null,
    note?: string | null,
  ) {
    const { data, error } = await supabase
      .from('crm_sales')
      .update({
        refunded_at: refunded ? new Date().toISOString() : null,
        refunded_cents: refunded ? cents : null,
        ...(note !== undefined && { refund_note: note?.trim() || null }),
      })
      .eq('id', id)
      .select('id')
    if (error) throw asError(error)
    if (!data?.length) {
      throw new Error('Nada foi gravado — seu usuário não tem permissão para editar vendas.')
    }
  },

  /**
   * Detalhe do reembolso de uma venda (103) — o card que abre ao clicar no
   * reembolso, no drawer ou no relatório. null = a venda não está mais
   * reembolsada (ou não é visível para este usuário).
   */
  async getRefundDetail(saleId: string): Promise<CrmRefundDetail | null> {
    const { data, error } = await supabase.rpc('crm_sale_refund_detail', { p_sale_id: saleId })
    if (error) throw asError(error)
    const r = (data as Record<string, unknown>[] | null)?.[0]
    if (!r) return null
    return {
      sale_id: String(r.sale_id),
      contact_id: String(r.contact_id),
      name: String(r.name ?? ''),
      phone: r.phone == null ? null : String(r.phone),
      channel: r.channel == null ? null : String(r.channel),
      value_cents: Number(r.value_cents ?? 0),
      refund_cents: Number(r.refund_cents ?? 0),
      partial: r.partial === true,
      sold_at: String(r.sold_at),
      refunded_at: String(r.refunded_at),
      refunded_by_name: r.refunded_by_name == null ? null : String(r.refunded_by_name),
      refund_note: r.refund_note == null ? null : String(r.refund_note),
    }
  },

  async listRefundFiles(saleId: string): Promise<CrmRefundFile[]> {
    const { data, error } = await supabase
      .from('crm_sale_refund_files')
      .select('id, sale_id, path, name, size_bytes, original_bytes, mime_type, encoding, created_at')
      .eq('sale_id', saleId)
      .order('created_at')
    if (error) throw asError(error)
    return (data ?? []) as CrmRefundFile[]
  },

  /**
   * Espaço do storage do projeto (103). A cota é do projeto inteiro — mídias
   * de envio inclusas —, não só dos anexos.
   */
  async storageUsage(): Promise<{ used: number; limit: number }> {
    const { data, error } = await supabase.rpc('crm_storage_usage')
    if (error) throw asError(error)
    const r = (data as Record<string, unknown>[] | null)?.[0]
    return { used: Number(r?.used_bytes ?? 0), limit: Number(r?.limit_bytes ?? 0) }
  },

  /**
   * Anexa um arquivo, já comprimido (compressAttachment), ao reembolso (103).
   * Sobe no bucket privado e só depois grava a linha; se a linha falhar, o
   * arquivo sai do bucket para não ficar órfão.
   */
  async addRefundFile(saleId: string, organizationId: string, file: CompressedFile): Promise<void> {
    if (file.blob.size > REFUND_FILE_MAX) throw new Error(refundTooBig(file.name, file.blob.size))
    const safeName = file.name.replace(/[^\w.\-]+/g, '_')
    const path = `${organizationId}/${saleId}/${Date.now()}-${safeName}${file.encoding === 'gzip' ? '.gz' : ''}`
    const { error: upErr } = await supabase.storage.from(REFUND_BUCKET).upload(path, file.blob, {
      contentType: file.contentType,
      upsert: false,
    })
    if (upErr) throw new Error(storageErrorMessage(file.name, upErr.message))
    const { error } = await supabase.from('crm_sale_refund_files').insert({
      organization_id: organizationId,
      sale_id: saleId,
      path,
      name: file.name,
      size_bytes: file.blob.size,
      original_bytes: file.originalBytes,
      mime_type: file.mimeType,
      encoding: file.encoding,
    })
    if (error) {
      await supabase.storage.from(REFUND_BUCKET).remove([path])
      throw asError(error)
    }
  },

  async removeRefundFile(file: CrmRefundFile): Promise<void> {
    const { data, error } = await supabase
      .from('crm_sale_refund_files')
      .delete()
      .eq('id', file.id)
      .select('id')
    if (error) throw asError(error)
    if (!data?.length) {
      throw new Error('Nada foi removido — seu usuário não tem permissão para editar vendas.')
    }
    // A linha já saiu: um arquivo que fique no bucket não aparece mais em lugar nenhum.
    await supabase.storage.from(REFUND_BUCKET).remove([file.path])
  },

  /**
   * Conteúdo do anexo, pronto para mostrar (103). O bucket é privado, então
   * baixa com a sessão do usuário; PDF gravado em gzip sai descompactado.
   */
  async refundFileBlob(file: CrmRefundFile): Promise<Blob> {
    const { data, error } = await supabase.storage.from(REFUND_BUCKET).download(file.path)
    if (error || !data) throw new Error(error?.message ?? 'Falha ao baixar o anexo')
    const type = file.mime_type || data.type || 'application/octet-stream'
    if (file.encoding === 'gzip') return gunzipBlob(data, type)
    return data.type === type ? data : new Blob([data], { type })
  },

  /**
   * Unifica dois cadastros do mesmo cliente (RPC crm_merge_contacts, 077).
   *
   * O caso é a venda que chega do gateway com um número diferente do que o
   * cliente usa no WhatsApp: a automação não acha o cadastro, cria outro, e a
   * venda nasce separada da história — e sem ir para a Meta, porque o
   * cadastro novo não tem o clique do anúncio.
   *
   * Tudo acontece no banco, numa transação só: as vendas e os eventos mudam
   * de dono, o cadastro que sai é apagado, e só então o que ainda não foi
   * enviado entra na fila. O que já foi para a Meta não vai de novo — os
   * eventos `sent` viajam junto justamente para continuarem sendo a trava
   * anti-duplicata daquela venda.
   *
   * `survivorId` é quem FICA. Não dá para desfazer.
   */
  async mergeContacts(survivorId: string, loserId: string): Promise<CrmMergeResult> {
    const { data, error } = await supabase.rpc('crm_merge_contacts', {
      p_survivor: survivorId,
      p_loser: loserId,
    })
    if (error) throw error
    const r = (data as Record<string, unknown>[] | null)?.[0]
    if (!r) {
      throw new Error('A unificação não devolveu resultado — confira os dois cadastros antes de repetir.')
    }
    return {
      survivor_id: String(r.survivor_id),
      survivor_name: String(r.survivor_name ?? ''),
      sales_moved: Number(r.sales_moved ?? 0),
      events_moved: Number(r.events_moved ?? 0),
      events_already_sent: Number(r.events_already_sent ?? 0),
      conversions_queued: Number(r.conversions_queued ?? 0),
    }
  },

  /**
   * Avisa o n8n de uma venda lançada à mão (RPC crm_sale_webhook, 068).
   *
   * Quem faz o POST é o banco, pelo pg_net: o webhook do n8n não responde
   * CORS, então um fetch daqui morreria no preflight e a venda ficaria
   * gravada sem ninguém do outro lado saber.
   *
   * Devolve o id da requisição do pg_net — o envio é assíncrono, então
   * "chamou" não é "entregou". Quem responde isso é saleWebhookStatus().
   */
  async notifySaleWebhook(saleId: string, opts: { newContact?: boolean } = {}): Promise<number | null> {
    const { data, error } = await supabase.rpc('crm_sale_webhook', {
      p_sale_id: saleId,
      p_new_contact: opts.newContact ?? false,
    })
    if (error) throw error
    return data == null ? null : Number(data)
  },

  /** Resultado do POST. null = ainda em voo (ou já expurgado pelo pg_net). */
  async saleWebhookStatus(requestId: number): Promise<{
    status_code: number | null
    timed_out: boolean
    error_msg: string | null
  } | null> {
    const { data, error } = await supabase.rpc('crm_sale_webhook_status', { p_request_id: requestId })
    if (error) throw error
    const r = (data as Record<string, unknown>[] | null)?.[0]
    if (!r) return null
    return {
      status_code: r.status_code == null ? null : Number(r.status_code),
      timed_out: Boolean(r.timed_out),
      error_msg: r.error_msg == null ? null : String(r.error_msg),
    }
  },

  /** Histórico de movimentações de um contato, do mais recente ao mais antigo. */
  async listHistory(contactId: string): Promise<CrmStageHistory[]> {
    const { data, error } = await supabase
      .from('crm_stage_history')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .returns<CrmStageHistory[]>()
    if (error) throw error
    return data ?? []
  },

  // ---------- Configurações ----------

  async getSettings(): Promise<CrmSettings> {
    const { data, error } = await supabase.rpc('crm_settings_get')
    if (error) throw error
    const row = (data as CrmSettings[] | null)?.[0]
    return row ?? {
      meta_pixel_id: null,
      has_token: false,
      meta_test_event_code: null,
      meta_page_id: null,
      meta_ad_account_id: null,
      has_ads_token: false,
    }
  },

  /**
   * Salva pixel, tokens e conta de anúncios.
   *
   * Os dois tokens seguem a mesma regra, e ela é o motivo de `undefined` e
   * `''` significarem coisas opostas: a tela nunca recebe um token, então
   * campo em branco não pode querer dizer "apague".
   *
   *   undefined → não mexe no que está salvo
   *   ''        → apaga de fato
   *
   * A conta de anúncios não é segredo e a tela sempre a devolve preenchida,
   * então ela vai como string normal.
   */
  async saveSettings(pixel: string, opts: {
    token?: string
    testCode?: string
    adAccount?: string
    adsToken?: string
  } = {}) {
    const { error } = await supabase.rpc('crm_settings_save', {
      p_pixel: pixel,
      p_token: opts.token ?? null,
      p_test_code: opts.testCode ?? null,
      p_ad_account: opts.adAccount ?? null,
      p_ads_token: opts.adsToken ?? null,
    })
    if (error) throw error
  },

  // ---------- Contas de anúncios ----------
  //
  // Uma org lê mais de uma conta no relatório de Meta ADS (058). A lista é
  // pública dentro da org — a tela precisa dos rótulos para montar o
  // seletor —, mas o token de cada conta nunca sai do banco: a RPC devolve
  // só has_token. Escrita é de admin, recusada pela própria RPC.

  async listAdAccounts(): Promise<CrmAdAccount[]> {
    const { data, error } = await supabase.rpc('crm_ad_accounts_list')
    if (error) throw error
    return (data as CrmAdAccount[] | null) ?? []
  },

  /**
   * Cria (id ausente) ou atualiza uma conta.
   *
   * O token segue a regra dos outros segredos do projeto, e pelo mesmo
   * motivo — a tela nunca o recebe de volta:
   *
   *   undefined → não mexe no que está salvo
   *   ''        → apaga
   *
   * `active` segue a metade de cima dessa regra: ausente não mexe. O
   * formulário de edição não manda o campo, e ausente não pode significar
   * "desligue a conta".
   */
  async saveAdAccount(opts: {
    id?: string
    accountId: string
    label?: string
    token?: string
    active?: boolean
  }): Promise<string> {
    const { data, error } = await supabase.rpc('crm_ad_account_save', {
      p_id: opts.id ?? null,
      p_account: opts.accountId,
      p_label: opts.label ?? null,
      p_token: opts.token ?? null,
      p_active: opts.active ?? null,
    })
    if (error) throw error
    return data as string
  },

  async deleteAdAccount(id: string) {
    const { error } = await supabase.rpc('crm_ad_account_delete', { p_id: id })
    if (error) throw error
  },

  // ---------- Campanhas fora do relatório ----------
  //
  // Campanha que gasta na conta e não gera lead no CRM — recrutamento é o
  // caso — inflava o custo do funil de vendas. A lista é da ORGANIZAÇÃO
  // (059): leitura livre por RLS, escrita só de admin pela RPC. Aqui não há
  // segredo nenhum, então a leitura vai direto na tabela.

  async listExcludedCampaigns(): Promise<CrmExcludedCampaign[]> {
    const { data, error } = await supabase
      .from('crm_ad_excluded_campaigns')
      .select('id, campaign_id, campaign_name, account_id, note, created_at')
      .order('created_at')
      .returns<CrmExcludedCampaign[]>()
    if (error) throw error
    return data ?? []
  },

  /**
   * Tira a campanha dos totais de Meta ADS.
   *
   * Só use em campanha que comprovadamente não gera lead no CRM. Tirar o
   * custo de campanha que traz lead infla o ROAS, porque a receita dela
   * continua no caixa.
   */
  async excludeCampaign(opts: {
    campaignId: string
    campaignName?: string | null
    accountId?: string | null
    note?: string | null
  }) {
    const { error } = await supabase.rpc('crm_campaign_exclude', {
      p_campaign_id: opts.campaignId,
      p_campaign_name: opts.campaignName ?? null,
      p_account_id: opts.accountId ?? null,
      p_note: opts.note ?? null,
    })
    if (error) throw error
  },

  async includeCampaign(campaignId: string) {
    const { error } = await supabase.rpc('crm_campaign_include', { p_campaign_id: campaignId })
    if (error) throw error
  },

  // ---------- Chaves de API ----------

  async listApiKeys(): Promise<CrmApiKey[]> {
    const { data, error } = await supabase
      .from('crm_api_keys')
      .select('*')
      .order('created_at', { ascending: false })
      .returns<CrmApiKey[]>()
    if (error) throw error
    return data ?? []
  },

  /** Devolve a chave em texto puro — é a única vez que ela existe fora do hash. */
  async createApiKey(name: string): Promise<string> {
    const { data, error } = await supabase.rpc('crm_api_key_create', { p_name: name })
    if (error) throw error
    return data as string
  },

  async revokeApiKey(id: string) {
    const { error } = await supabase.rpc('crm_api_key_revoke', { p_id: id })
    if (error) throw error
  },
}

/** Solta o papel de jornada das demais etapas (só um de cada por org). */
async function clearJourneyRole(role: CrmJourneyRole, exceptId: string) {
  const { error } = await supabase
    .from('crm_stages')
    .update({ journey_role: null })
    .eq('journey_role', role)
    .neq('id', exceptId)
  if (error) throw error
}

/** Tira a marca de conversão das demais etapas (só uma por org). */
async function clearConversionFlag(exceptId?: string) {
  let query = supabase.from('crm_stages').update({ is_conversion: false }).eq('is_conversion', true)
  if (exceptId) query = query.neq('id', exceptId)
  const { error } = await query
  if (error) throw error
}
