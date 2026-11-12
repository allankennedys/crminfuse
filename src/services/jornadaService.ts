/**
 * jornadaService — as etiquetas da conversa, que vivem no OUTRO Supabase.
 *
 * A tabela `etapas_phcreative` (projeto do bot, lido por supabaseExterno) é
 * um registro por número de WhatsApp com um array de etiquetas: é o que a
 * IA e as automações vão marcando enquanto a conversa acontece.
 *
 *   ARRAY['Rmkt','PagamentoPendente','rmkt1recebido','rmktdia3recebido']
 *
 * Dois bancos diferentes não fazem JOIN. Então a divisão de trabalho é:
 * aqui a gente LÊ e CLASSIFICA as etiquetas, e manda para o Postgres do CRM
 * a lista {número, etapa} já resolvida, que casa com os contatos por
 * telefone e devolve conversão e receita (060).
 *
 * A ORDEM DO ARRAY É INFORMAÇÃO
 *
 * As automações fazem append: a etiqueta nova entra no fim. É isso que
 * permite responder "o lead voltou DEPOIS do remarketing?" sem ter
 * histórico de etiqueta — basta ver se alguma etiqueta de progresso aparece
 * depois da última de remarketing. Não é tão forte quanto um timestamp por
 * etiqueta (que a tabela não tem), e o relatório diz isso na tela.
 */

import { supabaseExterno } from '@/lib/supabaseExterno'
import { addDaysISO, spDayStartISO } from '@/lib/datetime'
import { phoneId, type DateRange } from '@/services/crmService'

/** Linha crua de `etapas_phcreative`. */
interface EtapaRow {
  number: string | null
  tags: string[] | null
  created_at: string
  updated_at: string | null
}

/**
 * Etapa da jornada, do começo ao fim. `sem_etapa` é o lead que só tem
 * etiqueta de remarketing ou nenhuma que a gente reconheça — ele existe,
 * mas não chegou nem a ser triado.
 */
export type JourneyStage =
  | 'sem_etapa' | 'triagem' | 'portfolio' | 'orcamento' | 'pagamento' | 'comprou'

/** Ordem da escada. Comparar por este número é o que define "chegou até". */
export const STAGE_RANK: Record<JourneyStage, number> = {
  sem_etapa: 0,
  triagem: 1,
  portfolio: 2,
  orcamento: 3,
  pagamento: 4,
  comprou: 5,
}

export const STAGE_LABEL: Record<JourneyStage, string> = {
  sem_etapa: 'Sem etiqueta de etapa',
  triagem: 'Em triagem pela IA',
  portfolio: 'Portfólio enviado',
  orcamento: 'Orçamento enviado',
  pagamento: 'Pagamento pendente',
  comprou: 'Comprou',
}

/** Quantas linhas por requisição e o teto total, para não travar a aba. */
const PAGE = 1000
const MAX_ROWS = 20_000

/** Etiqueta sem acento, sem espaço e em minúscula: 'Orçamento ' → 'orcamento'. */
function normalizeTag(tag: string): string {
  return tag
    .normalize('NFD')
    // Faixa dos acentos combinantes: o 'ç' de "orçamento" vira 'c'.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
}

/**
 * O que cada família de etiqueta significa. Tudo que não casar com nenhum
 * padrão vai para `unknownTags` e aparece na tela — é assim que a gente
 * descobre que a automação começou a marcar algo novo, em vez de o
 * relatório ignorar calado.
 */
const RE_COMPROU = /^comprou(\d*)$/
const RE_RMKT = /^rmkt/
const RE_PAGAMENTO = /^pagamentopendente/
const RE_ORCAMENTO = /^orcamento/
/**
 * Etiqueta de portfólio. DESDE A 091 ELA NÃO CONTA: quem diz que o lead
 * entrou no portfólio é a tabela crm_portfolio_entries, aplicada por
 * marcarPortfolio(). O padrão continua aqui só para a etiqueta ser
 * reconhecida — sem ele, ela cairia em "etiquetas desconhecidas" na tela.
 * O 'i' opcional cobre "portifólio", que é como meio mundo escreve.
 */
const RE_PORTFOLIO = /^porti?folio/
const RE_TRIAGEM = /^(triagem|qualificacao)/
/** Etiqueta de remarketing que já foi ENTREGUE ao lead ('rmkt1recebido'). */
const RE_RMKT_ENTREGUE = /recebido/
/**
 * Um disparo entregue, com o dia dele. O 'dia' é opcional porque a
 * automação não é coerente: o primeiro é 'rmkt1recebido', do 3 ao 30 é
 * 'rmktdia3recebido', e o 45 e o 90 voltam a ser 'rmkt45recebido'. As três
 * grafias existem na base hoje, e este padrão cobre as três.
 */
const RE_RMKT_DISPARO = /^rmkt(?:dia)?(\d+)recebido$/

export interface LeadJourney {
  number: string
  tags: string[]
  createdAt: string
  updatedAt: string | null
  /** A etapa mais avançada que as etiquetas alcançaram. */
  stage: JourneyStage
  /**
   * As etapas cuja etiqueta REALMENTE apareceu na conversa.
   *
   * `stage` sozinho não responde "recebeu o portfólio?": ele guarda só o
   * rank máximo, então quem recebeu o portfólio e depois o orçamento vira
   * 'orcamento' e o portfólio some. Contar por `stage >= portfolio` devolve
   * o contrário — inclui quem pulou o portfólio e foi direto ao orçamento.
   * Nenhuma das duas leituras responde a pergunta; esta lista responde.
   */
  stagesSeen: JourneyStage[]
  /** N de 'comprouN' — a própria etiqueta conta as compras. */
  purchases: number
  /** Entrou na trilha de remarketing (tem qualquer etiqueta rmkt*). */
  rmkt: boolean
  /** Quantos disparos de remarketing chegaram nele. */
  rmktTouches: number
  /** Os dias dos disparos entregues, crescente: [1, 3, 5]. */
  rmktDays: number[]
  /**
   * Alguma etiqueta de progresso aparece depois da última de remarketing:
   * o lead voltou a andar. Vale a ressalva da ordem do array, no topo.
   */
  returnedAfterRmkt: boolean
  unknownTags: string[]
}

/** Classifica uma linha da tabela de etiquetas. */
export function classify(row: EtapaRow): LeadJourney | null {
  // Sem número não há como casar com o CRM nem com quem falar: a linha não
  // descreve lead nenhum.
  if (!row.number) return null

  const tags = row.tags ?? []
  let stage: JourneyStage = 'sem_etapa'
  const stagesSeen = new Set<JourneyStage>()
  let purchases = 0
  let rmktTouches = 0
  const rmktDays: number[] = []
  let rmkt = false
  let lastRmktIdx = -1
  let lastProgressIdx = -1
  const unknownTags: string[] = []

  tags.forEach((raw, i) => {
    const t = normalizeTag(raw)
    const comprou = RE_COMPROU.exec(t)

    if (comprou) {
      // 'comprou' sem número é a primeira compra; 'comprou3' são três.
      purchases = Math.max(purchases, comprou[1] ? Number(comprou[1]) : 1)
      stagesSeen.add('comprou')
      if (STAGE_RANK[stage] < STAGE_RANK.comprou) stage = 'comprou'
      lastProgressIdx = i
    } else if (RE_PAGAMENTO.test(t)) {
      stagesSeen.add('pagamento')
      if (STAGE_RANK[stage] < STAGE_RANK.pagamento) stage = 'pagamento'
      lastProgressIdx = i
    } else if (RE_ORCAMENTO.test(t)) {
      stagesSeen.add('orcamento')
      if (STAGE_RANK[stage] < STAGE_RANK.orcamento) stage = 'orcamento'
      lastProgressIdx = i
    } else if (RE_PORTFOLIO.test(t)) {
      // Reconhecida e ignorada (091): o portfólio vem da tabela.
    } else if (RE_TRIAGEM.test(t)) {
      stagesSeen.add('triagem')
      if (STAGE_RANK[stage] < STAGE_RANK.triagem) stage = 'triagem'
    } else if (RE_RMKT.test(t)) {
      rmkt = true
      lastRmktIdx = i
      if (RE_RMKT_ENTREGUE.test(t)) rmktTouches += 1
      const disparo = RE_RMKT_DISPARO.exec(t)
      // Contado uma vez por dia: a mesma etiqueta repetida na conversa não
      // pode fazer o lead aparecer duas vezes no mesmo degrau da trilha.
      if (disparo) {
        const dia = Number(disparo[1])
        if (!rmktDays.includes(dia)) rmktDays.push(dia)
      }
    } else {
      unknownTags.push(raw)
    }
  })

  return {
    number: row.number,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stage,
    stagesSeen: [...stagesSeen],
    purchases,
    rmkt,
    rmktTouches,
    rmktDays: rmktDays.sort((a, b) => a - b),
    returnedAfterRmkt: rmkt && lastRmktIdx >= 0 && lastProgressIdx > lastRmktIdx,
    unknownTags,
  }
}

/**
 * Marca quem entrou no portfólio pela tabela da 091 (`ids` = phone_id).
 *
 * A etiqueta não conta mais, então este é o único caminho para um lead
 * chegar à etapa 'portfolio'. Quem já está adiante (orçamento, pagamento,
 * comprou) continua lá: o portfólio entra só em `stagesSeen`.
 *
 * Não mexe em returnedAfterRmkt: aquele cálculo usa a ORDEM do array de
 * etiquetas, e o registro da tabela não tem lugar nessa ordem.
 */
export function marcarPortfolio(leads: LeadJourney[], ids: Set<string>): LeadJourney[] {
  if (ids.size === 0) return leads
  return leads.map((l) => {
    if (!ids.has(phoneId(l.number))) return l
    return {
      ...l,
      stage: STAGE_RANK[l.stage] < STAGE_RANK.portfolio ? 'portfolio' : l.stage,
      stagesSeen: l.stagesSeen.includes('portfolio') ? l.stagesSeen : [...l.stagesSeen, 'portfolio'],
    }
  })
}

/** Um degrau do funil de etiquetas. `dropped` é quanta gente ficou nele. */
export interface JourneyFunnelStep {
  id: string
  label: string
  /** Ajuda a ler o degrau: o que a etiqueta significa na prática. */
  hint: string
  reached: number
  dropped: number
  dropRate: number | null
}

export interface JourneyTagSummary {
  total: number
  steps: JourneyFunnelStep[]
  /** O degrau que perde mais gente em número absoluto. */
  biggestLeak: JourneyFunnelStep | null
  stageCounts: Record<JourneyStage, number>
  rmktLeads: number
  rmktTouched: number
  rmktReturned: number
  rmktReturnRate: number | null
  rmktBought: number
  /** A trilha de remarketing, disparo a disparo, do menor dia em diante. */
  rmktTrack: RmktStep[]
  /** Entrou na trilha e nenhum disparo saiu ainda. */
  rmktSemDisparo: number
  paymentPending: number
  /** Etiquetas que nenhum padrão reconheceu, das mais frequentes primeiro. */
  unknownTags: { tag: string; leads: number }[]
}

/**
 * Monta o funil e acha o vazamento.
 *
 * A escada NÃO é cumulativa (087): cada degrau conta quem ENTROU nele. A
 * série pode subir no meio — quando o time pula uma coluna, o degrau
 * seguinte fica maior que o anterior —, e isso é o dado, não erro de
 * cálculo. Por isso "quantos pararam ali" não é mais a diferença entre dois
 * degraus vizinhos: é contado por lead, quem entrou aqui e não entrou em
 * nenhuma etapa posterior. Mesma escolha da régua de remarketing abaixo, e
 * pelo mesmo motivo — a subtração só valeria se ninguém pulasse degrau.
 *
 * Pagamento pendente NÃO é degrau, de propósito: quem paga na hora nunca
 * recebe essa etiqueta, então tratá-la como obrigatória inventaria um
 * vazamento que não existe. Ela vira card separado — é a fila mais fácil
 * de recuperar que existe.
 */
/** Um disparo da régua de remarketing. */
export interface RmktStep {
  /** O dia da régua: 1, 3, 5, 7, 15, 20, 30, 45, 90… */
  dia: number
  /** Quantos RECEBERAM este disparo (acumulado: quem tem o 5 tem o 3). */
  leads: number
  /**
   * Quantos PARARAM aqui — este é o último disparo que eles têm.
   *
   * Contado pelo último disparo de cada lead, não por `leads[i] -
   * leads[i+1]`. A subtração parece equivalente e não é: ela só valeria se
   * a régua fosse perfeitamente encaixada, e não é. Na base de hoje há um
   * lead que entrou pelo dia 3 sem ter o do dia 1, e dois que pularam do 20
   * e do 30 direto para o 90 — com buraco no meio, a subtração atribui a
   * queda ao degrau errado. São 3 em 1.234, mas a conta certa custa o
   * mesmo.
   */
  parados: number
}

/**
 * A trilha de remarketing, um degrau por dia de disparo.
 *
 * A régua sai dos dias que EXISTEM no dado, não de uma lista fixa: hoje a
 * automação dispara em 1, 3, 5, 7, 15, 20, 30, 45 e 90, e no dia em que
 * mexerem nisso o relatório acompanha sozinho em vez de mostrar um degrau
 * fantasma ou esconder um novo.
 *
 * CUIDADO COM O QUE "PARADO" SIGNIFICA AQUI
 *
 * No funil do CRM, quem não avançou desistiu. Aqui não: um lead que entrou
 * ontem tem só o disparo do dia 1 porque o do dia 3 AINDA NÃO CHEGOU — ele
 * está a caminho, não abandonado. "Parado no dia N" é só "o dia N é o
 * último disparo que ele tem", e a tela precisa dizer isso com essas
 * palavras. Separar "saiu da trilha" de "ainda não venceu o próximo"
 * exigiria a data de cada etiqueta, que a tabela do bot não guarda.
 */
function montarTrilhaRmkt(leads: LeadJourney[]): RmktStep[] {
  const receberam = new Map<number, number>()
  const pararam = new Map<number, number>()

  for (const l of leads) {
    for (const d of l.rmktDays) receberam.set(d, (receberam.get(d) ?? 0) + 1)
    // rmktDays já vem crescente, então o último é o disparo mais avançado.
    const ultimo = l.rmktDays[l.rmktDays.length - 1]
    if (ultimo !== undefined) pararam.set(ultimo, (pararam.get(ultimo) ?? 0) + 1)
  }

  return [...receberam.keys()]
    .sort((a, b) => a - b)
    .map((dia) => ({
      dia,
      leads: receberam.get(dia) ?? 0,
      parados: pararam.get(dia) ?? 0,
    }))
}

export function summarize(leads: LeadJourney[]): JourneyTagSummary {
  const total = leads.length
  const stageCounts: Record<JourneyStage, number> = {
    sem_etapa: 0, triagem: 0, portfolio: 0, orcamento: 0, pagamento: 0, comprou: 0,
  }
  for (const l of leads) stageCounts[l.stage] += 1

  /**
   * Quantos leads RECEBERAM a etiqueta desta etapa. Não é cumulativo — a
   * mesma virada da 087 no lado do CRM.
   *
   * Pela lista de etiquetas vistas, não por `stage`: as duas leituras
   * possíveis com `stage` erram para lados opostos. `>= portfolio` conta
   * quem pulou o portfólio e foi direto ao orçamento; `=== portfolio` perde
   * quem recebeu o portfólio e avançou. Só a etiqueta em si responde.
   */
  const entraram = (st: JourneyStage) =>
    leads.filter((l) => l.stagesSeen.includes(st)).length

  /**
   * Recebeu a etiqueta desta etapa e não avançou além dela. `stage` é o rank
   * máximo do lead, então a igualdade já significa "daqui ele não saiu".
   */
  const pararam = (st: JourneyStage) =>
    leads.filter((l) => l.stagesSeen.includes(st) && l.stage === st).length

  const steps: JourneyFunnelStep[] = [
    // "Entrou" não tem etiqueta própria: é ter registro. Quem para aqui é
    // quem nunca recebeu etiqueta de etapa nenhuma.
    {
      id: 'entrou', label: 'Entrou na conversa', hint: 'tem registro de etiquetas',
      reached: total, dropped: stageCounts.sem_etapa,
    },
    {
      id: 'triagem', label: 'Triagem pela IA', hint: 'etiqueta triagem',
      reached: entraram('triagem'), dropped: pararam('triagem'),
    },
    {
      id: 'portfolio', label: 'Portfólio enviado', hint: 'registrado na tabela de portfólio',
      reached: entraram('portfolio'), dropped: pararam('portfolio'),
    },
    {
      id: 'orcamento', label: 'Orçamento', hint: 'etiqueta orçamento',
      reached: entraram('orcamento'), dropped: pararam('orcamento'),
    },
    // Último degrau não vaza: quem comprou chegou ao fim da jornada.
    {
      id: 'comprou', label: 'Comprou', hint: 'etiqueta comprouN',
      reached: entraram('comprou'), dropped: 0,
    },
  ].map((d, i, todos) => ({
    ...d,
    dropRate: d.reached > 0 && i < todos.length - 1
      ? Math.round((d.dropped / d.reached) * 1000) / 10
      : null,
  }))

  const vazamentos = steps.filter((s) => s.dropped > 0)
  const biggestLeak = vazamentos.length > 0
    ? vazamentos.reduce((a, b) => (b.dropped > a.dropped ? b : a))
    : null

  const rmktLeads = leads.filter((l) => l.rmkt).length
  const rmktReturned = leads.filter((l) => l.returnedAfterRmkt).length

  const contagem = new Map<string, number>()
  for (const l of leads) {
    // Por LEAD, não por etiqueta: a mesma etiqueta repetida na conversa não
    // deve parecer duas descobertas.
    for (const t of new Set(l.unknownTags)) contagem.set(t, (contagem.get(t) ?? 0) + 1)
  }

  return {
    total,
    steps,
    biggestLeak,
    stageCounts,
    rmktLeads,
    rmktTouched: leads.filter((l) => l.rmktTouches > 0).length,
    rmktReturned,
    rmktReturnRate: rmktLeads > 0 ? Math.round((rmktReturned / rmktLeads) * 1000) / 10 : null,
    rmktBought: leads.filter((l) => l.rmkt && l.stage === 'comprou').length,
    rmktTrack: montarTrilhaRmkt(leads),
    rmktSemDisparo: leads.filter((l) => l.rmkt && l.rmktDays.length === 0).length,
    paymentPending: stageCounts.pagamento,
    unknownTags: [...contagem.entries()]
      .map(([tag, l]) => ({ tag, leads: l }))
      .sort((a, b) => b.leads - a.leads)
      .slice(0, 12),
  }
}

export interface EtapasResult {
  leads: LeadJourney[]
  /** Bateu o teto de MAX_ROWS: os números falam de uma amostra. */
  truncated: boolean
  /** Falha de leitura (tabela sem policy para a chave anon, por exemplo). */
  error: string | null
}

export const jornadaService = {
  /**
   * Lê as etiquetas dos leads que ENTRARAM na janela (created_at da tabela
   * externa), no fuso de São Paulo — o mesmo recorte "entrada" das outras
   * abas de relatório.
   *
   * Erro não derruba a aba: a parte do CRM continua valendo, e a tela
   * mostra o que falta. O caso mais comum é a tabela não ter policy de
   * select para a role anon — de fora, isso chega como zero linha.
   */
  async listEtapas(range: DateRange): Promise<EtapasResult> {
    const [from, to] = range.from <= range.to ? [range.from, range.to] : [range.to, range.from]
    const leads: LeadJourney[] = []
    let truncated = false

    try {
      for (let page = 0; page * PAGE < MAX_ROWS; page += 1) {
        const { data, error } = await supabaseExterno
          .from('etapas_phcreative')
          .select('number, tags, created_at, updated_at')
          .gte('created_at', spDayStartISO(from))
          .lt('created_at', spDayStartISO(addDaysISO(to, 1)))
          .order('created_at')
          .range(page * PAGE, page * PAGE + PAGE - 1)
          .returns<EtapaRow[]>()

        if (error) throw error
        const rows = data ?? []
        for (const r of rows) {
          const lead = classify(r)
          if (lead) leads.push(lead)
        }
        // Página incompleta = fim da tabela. Página cheia no último giro
        // permitido = ainda tem dado lá, e a tela precisa avisar.
        if (rows.length < PAGE) break
        if ((page + 1) * PAGE >= MAX_ROWS) truncated = true
      }
      return { leads, truncated, error: null }
    } catch (err) {
      return {
        leads,
        truncated,
        error: err instanceof Error ? err.message : 'Falha ao ler as etiquetas da conversa',
      }
    }
  },

  /**
   * Formato que as RPCs da 060 esperam: número, etapa e o instante da
   * última mexida (para ordenar a fila do mais parado para o mais recente).
   */
  toRpcRows(leads: LeadJourney[]): { n: string; s: JourneyStage; u: string }[] {
    return leads.map((l) => ({ n: l.number, s: l.stage, u: l.updatedAt ?? l.createdAt }))
  },
}
