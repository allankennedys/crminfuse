import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  AreaChart, Area, Bar, ComposedChart, Legend, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import {
  Award, Tag, TrendingUp, Users, Target, DollarSign, CalendarClock, CheckCircle2, ChevronDown,
  Clock, CalendarDays, CalendarRange, Eye, EyeOff, Layers, Megaphone, MessageCircle, MousePointerClick,
  Receipt, Repeat, RotateCcw, ShoppingBag, TriangleAlert, UserCheck, Wallet,
} from 'lucide-react'
import { WhatsAppIcon } from '@/components/icons/WhatsAppIcon'
import {
  BreakdownCard, CollapsibleCard, ScopeTag, fmtDec, fmtInt, fmtPct, formatDuration,
} from './reportKit'
import {
  SkelChart, SkelChartCard, SkelKpis, SkelRows, SkelValue,
} from './skeletons'
import { JourneyNative } from './JourneyNative'
import { crmService, formatBRL } from '@/services/crmService'
import { metaAdsService } from '@/services/metaAdsService'
import type { DateRange } from '@/services/crmService'
import { Loader, EmptyState } from '@/components/ui'
import { ContactDrawer } from './ContactDrawer'
import { SaleDrawer } from './SaleDrawer'
import { RefundDetailDialog, refundTargetFromDetail } from './RefundDetailDialog'
import { RefundEditDialog, type RefundTarget } from './RefundEditDialog'
import { useAuthStore, useCan } from '@/store/authStore'
import { toast } from '@/store/toastStore'
import { confirmDialog } from '@/store/confirmStore'
import { addDaysISO as addDays, formatSP, nowSPDatetimeLocal } from '@/lib/datetime'
import type {
  CrmAdsDayRow, CrmAdsOverview, CrmContact, CrmConvertedContactRow,
  CrmRefundRow, CrmSalesBreakdownRow,
  CrmRepeatBucket, CrmRepeatDayRow, CrmRepeatOverview, CrmRepeatPendingRow, CrmRepeatTopRow,
  CrmAdAccount, CrmReportBreakdownRow, CrmReportOverview, CrmReportPeriodRow,
  CrmExcludedCampaign, CrmSalesContactRow, CrmSalesDayRow, CrmSalesOverview, CrmStage,
  MetaAdsAccountResult, MetaAdsInsights, MetaAdsRow,
} from '@/types'
import type { ChannelCount, OrigemCount } from '@/services/crmService'
import { AtendimentoReport } from '@/components/atendimento/AtendimentoReport'

const tooltipStyle = {
  background: '#18181b',
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: 10,
  fontSize: 12,
} as const
const tooltipLabel = { color: '#a1a1aa' }

/**
 * Quantas linhas de anúncio a tabela mostra antes do botão. A quebra por
 * campanha aparece inteira (uma conta tem dezenas), mas a de anúncio tem
 * facilmente centenas — e a partir de certo ponto a cauda é toda de gasto
 * irrelevante, ordenada por investimento.
 */
const ADS_PAGE = 15

/** Mesmo tamanho de bloco para a fila de reativação da aba Recompra. */
const REPEAT_PAGE = 15

/**
 * Teto da lista de convertidos. Maior que os blocos acima porque ela não é
 * um ranking com cauda desinteressante: é a lista completa de quem fechou, e
 * quem abre quer varrer todo mundo. O banco corta em 500 (074).
 */
const CONV_LISTA_LIMITE = 200

/**
 * Teto de pontos do MiniBars. Nenhum preset fixo chega perto disso (o maior,
 * "30 dias", dá 30 pontos), então o corte só entra em ação em intervalos
 * personalizados longos.
 */
const SPARK_POINTS = 90

/**
 * Presets do seletor. `days: 1` é "hoje" — o dia de calendário inteiro em São
 * Paulo, não as últimas 24h (quem resolve isso é a janela do banco, 037).
 *
 * `back` recua o FIM da janela: é o que permite "ontem" (um dia, terminando
 * ontem) conviver com os demais, que terminam hoje. Sem ele o preset teria de
 * virar caso especial no cálculo do intervalo.
 */
const PERIODS = [
  { id: 'hoje', days: 1, back: 0, label: 'Hoje' },
  { id: 'ontem', days: 1, back: 1, label: 'Ontem' },
  { id: '7', days: 7, back: 0, label: '7 dias' },
  { id: '30', days: 30, back: 0, label: '30 dias' },
] as const

/**
 * 'mes' e 'custom' ficam fora de PERIODS porque não são "os últimos N dias":
 * um começa sempre no dia 1 e cresce ao longo do mês (o tamanho da janela
 * muda todo dia, então não há `days` fixo a declarar) e o outro nasce das
 * duas datas escolhidas à mão.
 */
type PeriodId = (typeof PERIODS)[number]['id'] | 'mes' | 'custom'

/**
 * Abas do relatório. Cada uma responde uma pergunta diferente e não se
 * compara com as outras — juntas numa página só, davam a impressão de que
 * os números deveriam bater entre si.
 */
const REPORT_TABS = [
  { id: 'atendimento', label: 'Atendimento', sub: 'Volume, tempos de resposta e de atendimento, motivos de conclusão e desempenho por atendente' },
  { id: 'vendas', label: 'Vendas', sub: 'Faturamento por data da venda, com recompras' },
  { id: 'funil', label: 'Funil', sub: 'Leads criados no período e o que fechou nele, por origem e canal' },
  { id: 'jornada', label: 'Jornada', sub: 'O caminho do lead: por quais etapas passou, como foi a conversa e se comprou' },
  { id: 'recompra', label: 'Recompra', sub: 'O cliente volta? Taxa de recompra, tempo até a 2ª compra e quem ainda não voltou' },
  { id: 'ads', label: 'Meta ADS', sub: 'Investimento da Meta contra a receita dos clientes de anúncio: ROAS, CAC, ticket e LTV' },
] as const

type ReportTab = (typeof REPORT_TABS)[number]['id']

/** Hoje em São Paulo no formato do <input type="date">. */
function todaySP(): string {
  return nowSPDatetimeLocal().slice(0, 10)
}

/** Nenhum dado do CRM é anterior a isto; serve de piso para o personalizado. */
const DATA_MINIMA = '2000-01-01'

/** Data completa e dentro de [DATA_MINIMA, hoje] — o resto é digitação em curso. */
function dataAceitavel(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && v >= DATA_MINIMA && v <= todaySP()
}

/** Dia 1 do mês corrente em São Paulo — início da janela "Este Mês". */
function monthStartSP(): string {
  return `${todaySP().slice(0, 7)}-01`
}

/** "2026-07-30" → "30/07" */
function shortDate(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
}

/** "2026-07-30" → "30/07/2026" — o ano importa quando a janela cruza anos. */
/**
 * Reduz uma série a no máximo `max` pontos, somando os dias de cada balde.
 * O MiniBars desenha um elemento por ponto — num personalizado de dois anos
 * seriam centenas de barras sub-pixel dentro de um card de 200px. Somar (em vez de amostrar) preserva o total e o formato da
 * curva; o que se perde é o detalhe diário, que nesse tamanho não era legível
 * de qualquer jeito.
 */
function downsample(values: number[], max: number): number[] {
  if (values.length <= max) return values
  const size = Math.ceil(values.length / max)
  const out: number[] = []
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size).reduce((a, b) => a + b, 0))
  }
  return out
}

/** Quantos dias o intervalo cobre, contando as duas pontas. */
function rangeDays(range: DateRange): number {
  const a = Date.parse(`${range.from}T00:00:00Z`)
  const b = Date.parse(`${range.to}T00:00:00Z`)
  return Math.abs(Math.round((b - a) / 86_400_000)) + 1
}

/** Rótulo curto do período, usado nos títulos dos blocos. */
function rangeLabel(range: DateRange, preset: PeriodId): string {
  if (preset === 'hoje') return 'hoje'
  if (preset === 'ontem') return `ontem, ${shortDate(range.from)}`
  // Diz o recorte, não quantos dias: "últimos 21 dias" é verdade no dia 21 do
  // mês, mas não é a pergunta que quem clicou em "Este Mês" fez.
  if (preset === 'mes') return `este mês, ${shortDate(range.from)} a ${shortDate(range.to)}`
  if (preset === 'custom') {
    return range.from === range.to
      ? shortDate(range.from)
      : `${shortDate(range.from)} a ${shortDate(range.to)}`
  }
  return `últimos ${rangeDays(range)} dias`
}

/** "3,4×" — ROAS, LTV/CAC, frequência: proporções, não dinheiro. */
function fmtRatio(v: number): string {
  return `${v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}×`
}

/**
 * Dinheiro da Meta. Diferente do formatBRL do CRM em duas coisas: chega em
 * unidade inteira (reais, não centavos) e na moeda da CONTA DE ANÚNCIOS,
 * que nem sempre é BRL. Forçar "R$" num gasto em USD seria mentira barata.
 */
function fmtMoney(v: number, currency: string | null | undefined): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: currency || 'BRL' })
}

/**
 * Moeda de uma linha de campanha ou anúncio.
 *
 * Com várias contas a linha carrega o id da conta dela, e é a moeda DESSA
 * conta que vale — a tabela mistura contas, e formatar tudo com a moeda
 * comum imprimiria "R$" num gasto em dólar. Com uma conta só, ou quando a
 * linha não diz de onde veio, cai na moeda geral.
 */
function moedaDaLinha(
  row: { account_id: string | null },
  contas: MetaAdsAccountResult[],
  fallback: string | null,
): string | null {
  if (!row.account_id) return fallback
  return contas.find((c) => c.id === row.account_id)?.currency ?? fallback
}

/**
 * A janela de mesmo tamanho logo antes da selecionada: 7 dias compara com os
 * 7 anteriores, "hoje" com ontem, um intervalo personalizado de 12 dias com os
 * 12 que o antecedem.
 */
function previousRange(range: DateRange): DateRange {
  const dias = rangeDays(range)
  return { from: addDays(range.from, -dias), to: addDays(range.from, -1) }
}

/**
 * A mesma FATIA do mês passado: 01/08 a 21/08 compara com 01/07 a 21/07.
 *
 * Não serve o previousRange genérico aqui. Ele recua o tamanho da janela em
 * dias corridos, o que no dia 21 daria 11/07 a 31/07 — 21 dias de julho, sim,
 * mas a fatia errada do mês. E comparar com julho INTEIRO seria pior ainda:
 * 21 dias contra 31 faz todo mês parecer queda até o último dia.
 *
 * O `min` existe por causa de fevereiro: em 31/03 não há "dia 31" no mês
 * anterior, e a janela termina no último dia que existe.
 */
function previousMonthRange(range: DateRange): DateRange {
  const [ano, mes] = range.from.split('-').map(Number)
  const y = mes === 1 ? ano - 1 : ano
  const m = mes === 1 ? 12 : mes - 1
  // Dia 0 do mês seguinte = último dia de `m`. Date.UTC conta meses de 0, e é
  // por isso que passar `m` (1-based) já aponta para o mês seguinte.
  const ultimoDia = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const dia = Math.min(Number(range.to.slice(8, 10)), ultimoDia)
  const pad = (n: number) => String(n).padStart(2, '0')
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(dia)}` }
}

/** Janela contra a qual os badges de variação comparam, escolhida pelo preset. */
function comparisonRange(range: DateRange, preset: PeriodId): DateRange {
  return preset === 'mes' ? previousMonthRange(range) : previousRange(range)
}

/** Os presets "últimos N dias" — os únicos que divergem do Gerenciador. */
function ehUltimosNDias(preset: PeriodId): boolean {
  return preset === '7' || preset === '30'
}

/**
 * A mesma janela que o Gerenciador de Anúncios usa para o preset escolhido.
 *
 * "Últimos 7 dias" na Meta termina ONTEM; o preset daqui termina hoje
 * (PERIODS, `back: 0`). Sobram 6 dias em comum de 7 — o CRM troca o primeiro
 * dia da janela pelo dia de hoje, que ainda está correndo e sobe de hora em
 * hora. Lado a lado com o Gerenciador isso não se lê como "duas janelas
 * diferentes", se lê como "o relatório está errado", e foi exatamente essa a
 * dúvida que chegou do cliente.
 *
 * Então a aba Meta ADS recua a janela um dia inteiro: com hoje = 17/08, os
 * "7 dias" viram 10/08 a 16/08, que é o que o Gerenciador mostra.
 *
 * SÓ A ABA ADS. As outras continuam indo até hoje, porque lá o dia corrente é
 * informação legítima — venda de hoje é venda. É aqui que existe um número
 * externo para conferir.
 *
 * Não vale para todo preset: 'hoje' e 'ontem' já são idênticos nos dois lados,
 * "Este Mês" também é o mesmo preset lá (dia 1 até hoje, com o dia corrente
 * incluído), e no personalizado as datas são do usuário — recuar o que ele
 * digitou seria responder outra pergunta.
 */
function adsRange(range: DateRange, preset: PeriodId): DateRange {
  if (!ehUltimosNDias(preset)) return range
  return { from: addDays(range.from, -1), to: addDays(range.to, -1) }
}

/**
 * Variação % de um total contra o mesmo total do período anterior.
 *
 * Antes daqui comparava-se a 1ª metade da série com a 2ª metade DELA MESMA,
 * o que economizava uma consulta mas respondia outra pergunta: em janela
 * longa virava "a segunda metade do período contra a primeira", número que a
 * data de importação em lote sozinha já jogava para -90% e poucos.
 *
 * null esconde o badge, por não haver comparação honesta a fazer: sem período
 * anterior carregado, ou quando o anterior foi zero — de zero para qualquer
 * coisa é crescimento infinito, não "100%".
 */
function growthVsPrev(atual: number, anterior: number | null | undefined): number | null {
  if (anterior == null || anterior === 0) return null
  return Math.round(((atual - anterior) / anterior) * 100)
}

function GrowthBadge({ pct, anterior }: { pct: number | null; anterior?: string }) {
  if (pct === null) return null
  const up = pct >= 0
  return (
    <span
      className={`kpi-badge ${up ? 'kpi-badge-up' : 'kpi-badge-down'}`}
      title={anterior ? `Período anterior: ${anterior}` : undefined}
    >
      {up ? '↑' : '↓'} {Math.abs(pct)}%
    </span>
  )
}

/**
 * Quebra o total de um card nas duas parcelas que o compõem, com a barra como
 * leitura instantânea da proporção.
 *
 * Nasceu no funil (coorte do período x leads anteriores) e hoje sobrou só na
 * aba Recompra: lá as duas parcelas respondem à MESMA pergunta do card
 * (faturamento de quem já era cliente x de quem estreou). No funil a divisão
 * saiu — os cards passaram a mostrar direto a parcela da coorte, e a legenda
 * no topo da aba diz isso uma vez para todos eles.
 */
function ScopeSplit({ periodo, anteriores, format, labelA, labelB }: {
  periodo: number
  anteriores: number
  format: (v: number) => string
  labelA: string
  labelB: string
}) {
  const total = periodo + anteriores
  // Sem nada no período a barra fica vazia em vez de dividir por zero.
  const pct = total > 0 ? Math.round((periodo / total) * 100) : 0
  return (
    <div className="kpi-split">
      <div className="kpi-split-bar" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="kpi-split-legend">
        <span><b>{format(periodo)}</b> {labelA}</span>
        <span className="kpi-split-older"><b>{format(anteriores)}</b> {labelB}</span>
      </div>
    </div>
  )
}

/** Barras verticais reais (não decorativas) com a série de conversões por dia. */
function MiniBars({ values: raw }: { values: number[] }) {
  const values = downsample(raw, SPARK_POINTS)
  if (values.length === 0) return null
  const max = Math.max(...values, 1)
  return (
    <div className="kpi-bars" aria-hidden="true">
      {values.map((v, i) => (
        <span key={i} style={{ height: `${Math.max(6, (v / max) * 100)}%` }} />
      ))}
    </div>
  )
}

interface ReportData {
  overview: CrmReportOverview
  timeseries: CrmReportPeriodRow[]
  byOrigem: CrmReportBreakdownRow[]
  byChannel: CrmReportBreakdownRow[]
  sales: CrmSalesOverview
  salesSeries: CrmSalesDayRow[]
  salesByContact: CrmSalesContactRow[]
  /**
   * Mesmos totais, da janela imediatamente anterior (comparisonRange) — é
   * contra ela que os badges de variação comparam. null quando a consulta do
   * período anterior falhou.
   */
  prev: {
    overview: CrmReportOverview
    sales: CrmSalesOverview
    /** Fluxo compara com fluxo: usar o `converted` de coorte daqui mediria outra coisa. */
    } | null
}

/**
 * Aba Relatórios do CRM. Todas as agregações vêm de RPCs (crm_report_*);
 * aqui só orquestramos o carregamento e desenhamos.
 *
 * Tudo neste bloco é a MESMA coorte: os leads criados no período. Somar a
 * série diária dá exatamente os cards de cima — leads, conversões e a taxa
 * entre eles falam da mesma população, com a mesma janela.
 *
 * A janela é um intervalo de datas (hoje, presets ou personalizado) enviado
 * às RPCs como p_from/p_to; quem converte para instante é o banco, no fuso
 * de São Paulo (037). Um lugar só decide o que "hoje" significa.
 *
 * O relatório de VENDAS, mais abaixo, é a outra pergunta: dinheiro por data
 * da venda, venha o cliente de quando vier. Lá também os cards e o gráfico
 * usam a mesma janela.
 */
export function CrmReports({ stages }: { stages: CrmStage[] }) {
  const can = useCan()
  /**
   * O gestor enxerga os relatórios sem enxergar os contatos (preset da 056).
   * Sem esta checagem, as linhas continuariam com cara de clicável e o clique
   * morreria num erro de RLS — pior do que não convidar ao clique.
   */
  const podeAbrirContato = can('crm.contatos.ver')
  // Tirar campanha do relatório não é permissão de catálogo: é decisão de
  // admin, como as credenciais da Meta (054) — muda o número que todo mundo lê.
  const isAdmin = useAuthStore((s) => s.profile)?.role === 'admin'
  // Abre na primeira aba da barra (Vendas): destacar uma e abrir outra deixa
  // a barra com duas "primeiras".
  const [tab, setTab] = useState<ReportTab>(REPORT_TABS[0].id)
  // Contato aberto a partir de uma linha do relatório. null = fechado; o
  // drawer trata null como "novo contato", então ele só é montado com dado.
  const [openContact, setOpenContact] = useState<CrmContact | null>(null)
  /**
   * Lista de convertidos que abre pelo card "Conversões", logo abaixo dos
   * KPIs. Painel na própria página, não modal: a pergunta é "quem são esses
   * N", e cobrir o card que gerou a pergunta com uma tela cheia tira
   * justamente o número que se está conferindo.
   */
  const [convListaAberta, setConvListaAberta] = useState(false)
  const [convLista, setConvLista] =
    useState<{ rows: CrmConvertedContactRow[]; total: number; erro: string | null } | null>(null)
  // Lançamento rápido de venda, o mesmo da tela inicial. Só quem pode lançar
  // vê o botão — a RLS recusaria o insert de qualquer forma (055).
  const podeLancarVenda = can('crm.vendas.editar')
  const [launchingSale, setLaunchingSale] = useState(false)
  // Abre no dia corrente: a pergunta de quem entra no relatório é "como está
  // hoje". Os períodos maiores ficam a um clique, e o dia de hoje é a janela
  // mais barata de consultar.
  const [preset, setPreset] = useState<PeriodId>('hoje')
  // Datas do modo personalizado. Só entram em uso com preset === 'custom',
  // mas nascem preenchidas para o seletor abrir com algo válido.
  const [customFrom, setCustomFrom] = useState(() => addDays(todaySP(), -6))
  const [customTo, setCustomTo] = useState(() => todaySP())
  // O que está no campo, separado do que vale para a consulta: digitando o
  // ano, o Chrome emite 0002-, 0020-, 0202- a cada tecla, e cada um virava
  // uma rodada de consultas — a comparação recuava para antes do ano zero
  // (400) e a série diária de 2 mil anos estourava o tempo (500).
  const [customFromInput, setCustomFromInput] = useState(customFrom)
  const [customToInput, setCustomToInput] = useState(customTo)
  // '' = todos os canais. Aplicado no servidor, como o filtro do funil.
  const [channel, setChannel] = useState('')
  const [channels, setChannels] = useState<ChannelCount[]>([])
  // '' = todas as origens. Só a aba Jornada consulta com ela, então o
  // seletor também só aparece lá — filtro visível que não muda a tela é
  // pior do que filtro ausente.
  const [origem, setOrigem] = useState('')
  const [origens, setOrigens] = useState<OrigemCount[]>([])
  const [data, setData] = useState<ReportData | null>(null)

  // A janela é derivada do preset; 'custom' usa as duas datas escolhidas.
  // Tudo na aba (funil, vendas, sem origem) consulta com este mesmo intervalo.
  const range: DateRange = preset === 'custom'
    ? { from: customFrom, to: customTo }
    : preset === 'mes'
      ? { from: monthStartSP(), to: todaySP() }
      : (() => {
          const p = PERIODS.find((x) => x.id === preset)
          const fim = addDays(todaySP(), -(p?.back ?? 0))
          return { from: addDays(fim, -((p?.days ?? 30) - 1)), to: fim }
        })()
  const { from, to } = range
  const label = rangeLabel(range, preset)
  // Janela da aba Meta ADS. Derivada do mesmo preset, mas recuada para bater
  // com o Gerenciador de Anúncios — ver adsRange.
  const adsWindow = adsRange(range, preset)

  const refresh = useCallback(async () => {
    try {
      // Duas consultas a mais trazem os totais da janela anterior, que é o
      // que alimenta os badges de variação — só os dois overviews, não as
      // séries, que não entram na conta.
      const anterior = comparisonRange({ from, to }, preset)

      const [
        overview, timeseries, byOrigem, byChannel, sales, salesSeries, salesByContact,
        prevOverview, prevSales,
      ] = await Promise.all([
        crmService.reportOverview({ from, to }, channel),
        crmService.reportTimeseries({ from, to }, channel),
        crmService.reportByOrigem({ from, to }, channel),
        crmService.reportByChannel({ from, to }, channel),
        crmService.reportSales({ from, to }, channel),
        crmService.reportSalesTimeseries({ from, to }, channel),
        crmService.reportSalesByContact({ from, to }, channel),
        crmService.reportOverview(anterior, channel),
        crmService.reportSales(anterior, channel),
      ])
      setData({
        overview, timeseries, byOrigem, byChannel, sales, salesSeries, salesByContact,
        prev: prevOverview && prevSales ? { overview: prevOverview, sales: prevSales } : null,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao carregar os relatórios')
    }
  }, [from, to, channel, preset])

  useEffect(() => { refresh() }, [refresh])

  // Só busca com a lista aberta — e refaz a busca quando o período ou o
  // canal mudam, senão a lista mostraria a janela anterior sob o card novo.
  useEffect(() => {
    if (!convListaAberta) return
    let cancelado = false
    setConvLista(null)
    crmService.reportConvertedContacts({ from, to }, channel, CONV_LISTA_LIMITE)
      .then((r) => { if (!cancelado) setConvLista({ ...r, erro: null }) })
      .catch((err) => {
        if (!cancelado) {
          setConvLista({
            rows: [],
            total: 0,
            erro: err instanceof Error ? err.message : 'falha desconhecida',
          })
        }
      })
    return () => { cancelado = true }
  }, [convListaAberta, from, to, channel])

  // Abre o painel do contato a partir do relatório: é lá que a venda é
  // editada, em vez de duplicar o formulário aqui.
  const openById = useCallback(async (id: string) => {
    try {
      setOpenContact(await crmService.getContact(id))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao abrir o contato')
    }
  }, [])

  // Lista de canais para o seletor — igual ao do funil.
  useEffect(() => {
    crmService.listChannels().then(setChannels).catch(() => setChannels([]))
    crmService.listOrigens().then(setOrigens).catch(() => setOrigens([]))
  }, [])

  if (!data) return <Loader />

  const {
    overview, timeseries, byOrigem, byChannel, sales, salesSeries, salesByContact,
    prev,
  } = data
  const chartDays = timeseries.map((r) => ({
    ...r,
    label: r.day.slice(8, 10) + '/' + r.day.slice(5, 7),
  }))
  const hasMovement = timeseries.some((r) => r.leads > 0 || r.conversions > 0)

  return (
    <div className="crm-panel crm-reports">
      <div className="page-header">
        <div>
          <h1 style={{ fontSize: 20 }}>Relatórios</h1>
          <p>{REPORT_TABS.find((t) => t.id === tab)?.sub}</p>
        </div>
        {/* wrap porque a barra passou a ter 7 controles (canal + 6 períodos):
            sem ele, .flex é nowrap e a fileira vaza a página para o lado em
            tela estreita em vez de descer para a linha de baixo. */}
        <div className="flex" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {channels.length > 0 && (
            <label className="channel-filter">
              <WhatsAppIcon size={14} color="#3b82f6" />
              <select value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="">Todos os vendedores</option>
                {channels.map((c) => (
                  <option key={c.channel} value={c.channel}>
                    {c.channel} ({c.contact_count})
                  </option>
                ))}
              </select>
            </label>
          )}
          {tab === 'jornada' && origens.length > 0 && (
            <label className="channel-filter">
              <Tag size={14} />
              <select value={origem} onChange={(e) => setOrigem(e.target.value)}>
                <option value="">Todas as origens</option>
                {origens.map((o) => (
                  <option key={o.origem} value={o.origem}>
                    {o.origem} ({o.contact_count})
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
            {PERIODS.map((p) => (
              <button
                key={p.id}
                className={`btn btn-sm ${preset === p.id ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setPreset(p.id)}
              >
                {p.label}
              </button>
            ))}
            <button
              className={`btn btn-sm ${preset === 'mes' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setPreset('mes')}
              title="Do dia 1 até hoje. Compara com a mesma fatia do mês passado."
            >
              <CalendarDays size={14} /> Este Mês
            </button>
            <button
              className={`btn btn-sm ${preset === 'custom' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setPreset('custom')}
            >
              <CalendarRange size={14} /> Personalizado
            </button>
          </div>
        </div>
      </div>

      {preset === 'custom' && (
        <div className="crm-range">
          <label>
            <span>De</span>
            <input
              className="input"
              type="date"
              value={customFromInput}
              min={DATA_MINIMA}
              max={todaySP()}
              onChange={(e) => {
                setCustomFromInput(e.target.value)
                if (dataAceitavel(e.target.value)) setCustomFrom(e.target.value)
              }}
            />
          </label>
          <label>
            <span>Até</span>
            <input
              className="input"
              type="date"
              value={customToInput}
              min={DATA_MINIMA}
              max={todaySP()}
              onChange={(e) => {
                setCustomToInput(e.target.value)
                if (dataAceitavel(e.target.value)) setCustomTo(e.target.value)
              }}
            />
          </label>
          <span className="text-muted" style={{ fontSize: 12 }}>
            {/* O banco inverte se vier de trás para frente, mas dizer isso
                aqui evita o usuário achar que o relatório zerou. */}
            {rangeDays(range)} dia(s), incluindo as duas datas
            {customFrom > customTo && ' — datas invertidas, considerando o intervalo entre elas'}
          </span>
        </div>
      )}

      {/* Período e canal ficam FORA das abas: valem para as três, e
          repetir o seletor em cada uma faria o usuário reconfigurar a cada
          troca. */}
      <div className="report-tabs">
        {REPORT_TABS.map((t) => (
          <button
            key={t.id}
            className={`report-tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'funil' && (
        <>
          {/* ---------- Legenda geral da aba ----------
              Todos os cards abaixo falam da MESMA população: os leads criados
              dentro da janela. Os cards de conversão mostravam antes o total
              que fechou no período (viesse o lead de quando viesse) e quebravam
              embaixo quanto era de lead antigo — duas populações na mesma tela,
              e a soma dos cards nunca fechava com a série logo abaixo. */}
          <div className="report-legend">
            <CalendarRange size={15} />
            <p>
              Tudo nesta aba conta apenas <b>leads que entraram no período selecionado</b>
              {' '}({label}). Conversões e valores de leads mais antigos, mesmo que tenham
              fechado dentro desta janela, não entram aqui — para o total faturado no
              período, veja a aba Vendas.
            </p>
          </div>

          {/* ---------- KPIs ---------- */}
          <div className="crm-kpis">
            <div className="kpi-card kpi-pattern-grid">
              <div className="kpi-card-bg" aria-hidden="true" />
              <div className="kpi-card-top">
                <span className="kpi-icon"><Users size={16} /></span>
                <div className="kpi-top-right">
                  <ScopeTag kind="entrada" />
                  <GrowthBadge
                    pct={growthVsPrev(overview.total_leads, prev?.overview.total_leads)}
                    anterior={prev ? `${prev.overview.total_leads.toLocaleString('pt-BR')} leads` : undefined}
                  />
                </div>
              </div>
              <div className="kpi-title">Leads</div>
              <div className="kpi-value">{overview.total_leads.toLocaleString('pt-BR')}</div>
              <div className="kpi-desc">entraram no período</div>
            </div>

            <div className="kpi-card kpi-pattern-radar">
              <div className="kpi-card-bg" aria-hidden="true" />
              <div className="kpi-card-top">
                <span className="kpi-icon kpi-icon-money"><Target size={16} /></span>
                <ScopeTag kind="entrada" />
              </div>
              <div className="kpi-title">Taxa de conversão</div>
              <div className="kpi-value kpi-value-money">{fmtPct(overview.conversion_rate)}</div>
              <div className="kpi-desc">dos leads do período</div>
            </div>

            {/* O único KPI que abre lista: os outros são taxas e médias, e
                "quem são os 42%" não é pergunta. Aqui é gente com nome. */}
            <button
              type="button"
              className={`kpi-card kpi-pattern-grid kpi-card-click${convListaAberta ? ' kpi-card-open' : ''}`}
              onClick={() => setConvListaAberta((v) => !v)}
              disabled={overview.converted === 0}
              aria-expanded={convListaAberta}
              title={overview.converted === 0
                ? undefined
                : convListaAberta ? 'Fechar a lista' : 'Ver quem converteu'}
            >
              <div className="kpi-card-bg" aria-hidden="true" />
              <div className="kpi-card-top">
                <span className="kpi-icon kpi-icon-money"><CheckCircle2 size={16} /></span>
                <div className="kpi-top-right">
                  <ScopeTag kind="entrada" />
                  <GrowthBadge
                    pct={growthVsPrev(overview.converted, prev?.overview.converted)}
                    anterior={prev
                      ? `${prev.overview.converted.toLocaleString('pt-BR')} conversões`
                      : undefined}
                  />
                </div>
              </div>
              <div className="kpi-title">Conversões</div>
              <div
                className="kpi-value kpi-value-money"
                title={'Dos leads criados no período, quantos chegaram à etapa de '
                  + 'conversão — inclusive os que fecharam depois do fim da janela. '
                  + 'Cada cliente conta uma vez: reentrar na etapa não conta de novo.'}
              >
                {overview.converted.toLocaleString('pt-BR')}
              </div>
              <div className="kpi-desc">
                {overview.converted === 0
                  ? 'de leads que entraram no período'
                  : convListaAberta
                    ? 'de leads que entraram no período · clique para fechar a lista'
                    : 'de leads que entraram no período · clique para ver quem são'}
              </div>
            </button>

            <div className="kpi-card kpi-card-featured kpi-pattern-mesh">
              <div className="kpi-card-bg" aria-hidden="true" />
              <div className="kpi-featured-row">
                <div>
                  <div className="kpi-card-top">
                    <span className="kpi-icon kpi-icon-money kpi-icon-lg"><DollarSign size={18} /></span>
                    <div className="kpi-top-right">
                      <ScopeTag kind="entrada" />
                      <GrowthBadge
                        pct={growthVsPrev(overview.revenue_cents, prev?.overview.revenue_cents)}
                        anterior={prev ? formatBRL(prev.overview.revenue_cents) : undefined}
                      />
                    </div>
                  </div>
                  <div className="kpi-title">Valor convertido</div>
                  <div
                    className="kpi-value kpi-value-money kpi-value-lg"
                    title={'Soma do valor da 1ª venda dos leads que entraram no período e '
                      + 'converteram. Cada cliente soma uma vez.\n\n'
                      + 'A aba Vendas responde outra pergunta — quanto foi faturado DENTRO '
                      + 'da janela, incluindo recompra e cliente antigo —, então os dois '
                      + 'números não precisam bater.'}
                  >
                    {formatBRL(overview.revenue_cents)}
                  </div>
                  <div className="kpi-desc">de leads que entraram no período</div>
                </div>
              </div>
            </div>

            {/* Ticket do mesmo total do card ao lado (valor ÷ conversões): com
                outro recorte aqui, a divisão dos dois cards vizinhos não
                fecharia. */}
            <div className="kpi-card kpi-pattern-blur">
              <div className="kpi-card-bg" aria-hidden="true" />
              <div className="kpi-card-top">
                <span className="kpi-icon kpi-icon-money"><DollarSign size={16} /></span>
                <ScopeTag kind="entrada" />
              </div>
              <div className="kpi-title">Ticket médio</div>
              <div className="kpi-value kpi-value-money">
                {overview.converted > 0 ? formatBRL(overview.avg_ticket_cents ?? 0) : '—'}
              </div>
              <div className="kpi-desc">por cliente que entrou no período</div>
            </div>

            <div className="kpi-card kpi-pattern-topo">
              <div className="kpi-card-bg" aria-hidden="true" />
              <div className="kpi-card-top">
                <span className="kpi-icon"><Clock size={16} /></span>
                <ScopeTag kind="entrada" />
              </div>
              <div className="kpi-title">Tempo até converter</div>
              <div className="kpi-value">{formatDuration(overview.avg_hours_to_convert)}</div>
              <div className="kpi-desc">média criação → conversão</div>
            </div>
          </div>

          {/* ---------- Lista de convertidos (abre pelo card) ----------
              Vem logo depois da fileira de KPIs, colada no card que a abriu:
              é a resposta de "quem são esses N" e some junto com o clique. */}
          {convListaAberta && (
            <div className="card mb-16">
              <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div>
                  <div className="card-title" style={{ marginBottom: 4 }}>
                    <CheckCircle2 size={14} /> Quem converteu — {label}
                  </div>
                  <p className="text-muted" style={{ fontSize: 11.5, marginBottom: 14 }}>
                    Os mesmos {fmtInt(overview.converted)} leads do card: entraram no
                    período e chegaram à etapa de conversão · do mais recente para o
                    mais antigo
                  </p>
                </div>
                <button className="btn btn-sm btn-ghost" onClick={() => setConvListaAberta(false)}>
                  Fechar
                </button>
              </div>

              {!convLista ? (
                <SkelRows rows={6} />
              ) : convLista.erro ? (
                /* Lista vazia calada seria pior: o card ao lado diz que há
                   conversões, então "nenhuma" só pode ser falha. */
                <div className="journey-warn">
                  <TriangleAlert size={15} />
                  <div>
                    <strong>Não foi possível carregar a lista.</strong>
                    <p>{convLista.erro}</p>
                  </div>
                </div>
              ) : convLista.rows.length === 0 ? (
                <EmptyState icon={<CheckCircle2 />} text="Nenhum lead do período converteu." />
              ) : (
                <>
                  <div className="table-wrap" style={{ border: 'none', background: 'transparent' }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Cliente</th>
                          <th>Canal</th>
                          <th>Origem</th>
                          <th>Entrou</th>
                          <th>Converteu</th>
                          <th style={{ textAlign: 'right' }}>Levou</th>
                          <th style={{ textAlign: 'right' }}>Valor</th>
                        </tr>
                      </thead>
                      <tbody>
                        {convLista.rows.map((r) => (
                          <tr
                            key={r.contact_id}
                            className={podeAbrirContato ? 'row-clickable' : undefined}
                            onClick={podeAbrirContato ? () => openById(r.contact_id) : undefined}
                          >
                            <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {r.name || r.phone || '—'}
                              {r.sales_count > 1 && (
                                <span className="journey-chip">{fmtInt(r.sales_count)} vendas</span>
                              )}
                            </td>
                            <td>{r.channel ?? '—'}</td>
                            <td style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {r.origem ?? '—'}
                            </td>
                            <td>{formatSP(r.created_at)}</td>
                            <td>{formatSP(r.converted_at)}</td>
                            <td style={{ textAlign: 'right' }}>
                              {/* Negativo = venda lançada com data anterior à
                                  entrada do lead. "—" em vez de "-3 d". */}
                              {r.hours_to_conv == null || r.hours_to_conv < 0
                                ? '—'
                                : formatDuration(r.hours_to_conv)}
                            </td>
                            <td style={{ textAlign: 'right' }}>{formatBRL(r.value_cents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {convLista.total > convLista.rows.length && (
                    <p className="text-muted" style={{ fontSize: 11.5, marginTop: 10 }}>
                      Mostrando {fmtInt(convLista.rows.length)} de {fmtInt(convLista.total)} —
                      escolha um período menor para ver o resto.
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {/* ---------- Série temporal ---------- */}
          <div className="card mb-16">
            <div className="card-title" style={{ marginBottom: 4 }}>
              Leads e conversões — {label}
            </div>
            {/* As duas séries são a mesma coorte dos cards de cima: somar as
                barras dá exatamente Leads e Convertidos do período. */}
            <p className="text-muted" style={{ fontSize: 11.5, marginBottom: 18 }}>
              Leads criados por dia e, dos mesmos leads, quando converteram
            </p>
            {!hasMovement ? (
              <EmptyState icon={<TrendingUp />} text="Nenhum lead ou conversão no período." />
            ) : (
              <div style={{ width: '100%', height: 280 }}>
                <ResponsiveContainer>
                  <AreaChart data={chartDays} margin={{ top: 5, right: 5, bottom: 0, left: -20 }}>
                    <defs>
                      <linearGradient id="crmLeadsFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="crmConvFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#4da3ff" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#4da3ff" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="label" stroke="#52525b" fontSize={11} tickLine={false} axisLine={false} />
                    {/* Eixos separados: conversões normalmente são uma fração dos
                        leads, e dividir a mesma escala achatava a linha verde
                        perto do zero. A cor do eixo casa com a cor da linha, pra
                        ficar claro qual escala é de qual série. */}
                    <YAxis yAxisId="leads" stroke="#38bdf8" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                    <YAxis yAxisId="conv" orientation="right" stroke="#4da3ff" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip contentStyle={tooltipStyle} labelStyle={tooltipLabel} />
                    {/* Com um dia só não existe segmento de reta: sem o
                        ponto marcado, o gráfico parece vazio mesmo tendo
                        dado. Com vários dias o ponto vira sujeira visual. */}
                    <Area yAxisId="leads" type="monotone" dataKey="leads" name="Leads" stroke="#38bdf8" strokeWidth={2} fill="url(#crmLeadsFill)" dot={chartDays.length === 1 ? { r: 4 } : false} />
                    <Area yAxisId="conv" type="monotone" dataKey="conversions" name="Conversões" stroke="#4da3ff" strokeWidth={2} fill="url(#crmConvFill)" dot={chartDays.length === 1 ? { r: 4 } : false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* ---------- Origem x Canal ---------- */}
          <div className="grid-2">
            <BreakdownCard
              title="Conversão por origem"
              colHead="Origem"
              icon={<Tag size={14} />}
              emptyText="Nenhum contato com origem preenchida no período."
              rows={byOrigem}
            />
            <BreakdownCard
              title="Conversão por canal"
              colHead="Canal"
              icon={<WhatsAppIcon size={14} color="#3b82f6" />}
              emptyText="Nenhum contato com canal preenchido no período."
              rows={byChannel}
            />
          </div>

        </>
      )}

      {tab === 'vendas' && (
        <SalesReport
          label={label}
          range={range}
          channel={channel}
          overview={sales}
          series={salesSeries}
          byContact={salesByContact}
          onOpenContact={podeAbrirContato ? openById : undefined}
          onLaunchSale={podeLancarVenda ? () => setLaunchingSale(true) : undefined}
          prevRevenueCents={prev?.sales.revenue_cents ?? null}
          onRefundChanged={can('crm.vendas.editar') ? refresh : undefined}
        />
      )}

      {tab === 'atendimento' && <AtendimentoReport label={label} range={range} />}

      {tab === 'jornada' && (
        <JourneyNative label={label} range={range} channel={channel} origem={origem} />
      )}

      {tab === 'recompra' && (
        <RepeatReport
          label={label}
          range={range}
          channel={channel}
          onOpenContact={podeAbrirContato ? openById : undefined}
        />
      )}

      {tab === 'ads' && (
        <AdsReport
          label={label}
          preset={preset}
          // Janela própria: a do Gerenciador de Anúncios, que nos presets de
          // "últimos N dias" termina ontem (adsRange). Todo o resto da tela
          // continua com `range`.
          range={adsWindow}
          // Mesma regra do resto da tela: "Este Mês" compara com a fatia
          // equivalente do mês passado, o resto com a janela de igual tamanho
          // imediatamente anterior.
          previous={comparisonRange(adsWindow, preset)}
          channel={channel}
          isAdmin={isAdmin}
        />
      )}

      {launchingSale && (
        <SaleDrawer
          stages={stages}
          onClose={() => setLaunchingSale(false)}
          // Recarrega os números do relatório: a venda que acabou de entrar
          // muda o faturamento que está na tela atrás do drawer.
          onSaved={refresh}
        />
      )}

      {openContact && (
        <ContactDrawer
          contact={openContact}
          stages={stages}
          onClose={() => setOpenContact(null)}
          // Não fecha ao salvar: registrar ou editar venda mantém o painel
          // aberto (é o próprio drawer que fecha quando o contato é salvo).
          onSaved={refresh}
        />
      )}
    </div>
  )
}

/**
 * Aba Recompra — o cliente volta?
 *
 * A aba Vendas já dizia quantas vendas do período foram recompra. Isso
 * responde "quanto entrou". Aqui a pergunta é outra: a carteira recompra, em
 * quanto tempo, e quanto vale um cliente que volta contra um que não volta.
 *
 * TRÊS POPULAÇÕES NA MESMA TELA, E ELAS NÃO SE COMPARAM
 *
 *   base inteira → taxa de recompra, compras por cliente, tempo até a 2ª
 *                  compra, LTV. Ignoram o período de propósito: são
 *                  propriedades do cliente, não da janela. Levam a marca
 *                  "base inteira" no card.
 *   janela       → receita e ticket de estreia contra os de retorno.
 *   coorte       → dos que estrearam na janela, quantos já voltaram.
 *
 * A coorte é a que engana: ela é enviesada para baixo por construção, porque
 * quem estreou ontem ainda não teve tempo de voltar. O card diz isso — sem o
 * aviso, "3% de recompra" num filtro de 7 dias parece catástrofe quando é só
 * o calendário.
 */
function RepeatReport({ label, range, channel, onOpenContact }: {
  label: string
  range: DateRange
  channel: string
  /** undefined = sem permissão de ver contato: a linha não convida ao clique. */
  onOpenContact?: (id: string) => void
}) {
  const [data, setData] = useState<{
    overview: CrmRepeatOverview
    buckets: CrmRepeatBucket[]
    series: CrmRepeatDayRow[]
    top: CrmRepeatTopRow[]
  } | null>(null)
  const [pending, setPending] = useState<{ rows: CrmRepeatPendingRow[]; total: number } | null>(null)
  const [pendingLimit, setPendingLimit] = useState(REPEAT_PAGE)
  /**
   * A fila começa cortada pelo tempo típico de retorno. Desmarcar mostra
   * todo mundo com uma compra só — inclusive quem comprou ontem, que não
   * sumiu, só ainda não voltou.
   */
  const [onlyOverdue, setOnlyOverdue] = useState(true)

  const { from, to } = range

  useEffect(() => {
    let cancelado = false
    Promise.all([
      crmService.reportRepeatOverview({ from, to }, channel),
      crmService.reportRepeatDistribution(channel),
      crmService.reportRepeatTimeseries({ from, to }, channel),
      crmService.reportRepeatTop({ from, to }, channel),
    ])
      .then(([overview, buckets, series, top]) => {
        if (!cancelado) setData({ overview, buckets, series, top })
      })
      .catch((err) => {
        if (!cancelado) toast.error(err instanceof Error ? err.message : 'Falha ao carregar o relatório de recompra')
      })
    return () => { cancelado = true }
  }, [from, to, channel])

  // Mediana de dias até a 2ª compra: é o corte da fila de reativação, e só
  // existe depois que o overview chega. Por isso a fila carrega em separado,
  // em vez de entrar no Promise.all acima.
  const medianDays = Math.round(data?.overview.median_days_to_second ?? 0)
  const minDays = onlyOverdue ? medianDays : 0

  useEffect(() => {
    if (!data) return
    let cancelado = false
    crmService.reportRepeatPending({ channel, minDays, limit: pendingLimit })
      .then((r) => { if (!cancelado) setPending(r) })
      .catch(() => { if (!cancelado) setPending({ rows: [], total: 0 }) })
    return () => { cancelado = true }
  }, [data, channel, minDays, pendingLimit])

  // Trocar o filtro volta ao primeiro bloco: manter 45 linhas de um recorte
  // anterior confunde a leitura do resultado novo.
  useEffect(() => { setPendingLimit(REPEAT_PAGE) }, [channel, onlyOverdue])

  if (!data) return <Loader />

  const { overview: o, buckets, series, top } = data

  // ---------- Derivados ----------
  // Fatia do faturamento da janela que veio de quem já era cliente.
  const shareRepeat = o.revenue_cents > 0
    ? Math.round((o.repeat_revenue_cents / o.revenue_cents) * 100)
    : null
  // Recompra mais cara ou mais barata que a estreia? A diferença é o que
  // decide se vale empurrar upsell no retorno.
  const ticketDelta = o.first_ticket_cents > 0 && o.repeat_ticket_cents > 0
    ? Math.round(((o.repeat_ticket_cents - o.first_ticket_cents) / o.first_ticket_cents) * 100)
    : null
  // Quantas vezes vale um cliente que volta. É o número que justifica
  // gastar em reativação em vez de só em mídia.
  const ltvMult = o.once_ltv_cents > 0 && o.repeat_ltv_cents > 0
    ? o.repeat_ltv_cents / o.once_ltv_cents
    : null

  const chartDays = series.map((r) => ({
    label: shortDate(r.day),
    primeira: r.first_revenue_cents / 100,
    recompra: r.repeat_revenue_cents / 100,
  }))
  const temGrafico = chartDays.some((d) => d.primeira > 0 || d.recompra > 0)
  const maxBucket = Math.max(...buckets.map((b) => b.clients), 1)

  return (
    <>
      <div className="page-header">
        <div>
          <h2 style={{ fontSize: 17 }}>Recompra</h2>
          <p>
            Quanto da carteira volta a comprar, em quanto tempo, e quem ainda
            não voltou · {label}
          </p>
        </div>
      </div>

      {o.total_clients === 0 ? (
        <div className="card">
          <EmptyState icon={<Repeat />} text="Nenhum cliente com venda registrada ainda." />
        </div>
      ) : (
        <>
          <div className="crm-kpis crm-kpis-dense">
            {/* Primeiro o que muda com o período, depois o que é da base
                inteira — trocar o filtro mexe na primeira fileira. */}
            <div className="kpi-card kpi-pattern-grid">
              <div className="kpi-card-bg" aria-hidden="true" />
              <div className="kpi-card-top">
                <span className="kpi-icon kpi-icon-money"><DollarSign size={16} /></span>
                <ScopeTag kind="conversao" />
              </div>
              <div className="kpi-title">Receita de recompra</div>
              <div className="kpi-value kpi-value-money">{formatBRL(o.repeat_revenue_cents)}</div>
              {/* A barra mostra o quanto do faturamento do período veio de
                  quem já era cliente — mesmo desenho do ScopeSplit do funil. */}
              <ScopeSplit
                periodo={o.repeat_revenue_cents}
                anteriores={o.first_revenue_cents}
                format={formatBRL}
                labelA="de quem já era cliente"
                labelB="de clientes novos"
              />
              <div className="kpi-desc">
                {shareRepeat == null
                  ? 'nenhuma venda no período'
                  : `${shareRepeat}% do faturamento de ${label}`}
              </div>
            </div>

            <div className="kpi-card kpi-pattern-blur">
              <div className="kpi-card-bg" aria-hidden="true" />
              <div className="kpi-card-top">
                <span className="kpi-icon kpi-icon-money"><Receipt size={16} /></span>
                <ScopeTag kind="conversao" />
              </div>
              <div className="kpi-title">Ticket da recompra</div>
              <div className="kpi-value kpi-value-money">
                {o.repeat_sales > 0 ? formatBRL(o.repeat_ticket_cents) : '—'}
              </div>
              <div className="kpi-desc">
                {ticketDelta == null
                  ? `${o.repeat_sales.toLocaleString('pt-BR')} recompra(s) no período`
                  : `${formatBRL(o.first_ticket_cents)} na 1ª venda · `
                    + `${ticketDelta >= 0 ? '+' : ''}${ticketDelta}% no retorno`}
              </div>
            </div>

            {/* A pergunta-título da aba. Featured porque é a resposta, e da
                base inteira porque taxa de recompra num recorte de 7 dias
                não descreve carteira nenhuma. */}
            <div className="kpi-card kpi-card-featured kpi-pattern-mesh">
              <div className="kpi-card-bg" aria-hidden="true" />
              <div className="kpi-featured-row">
                <div>
                  <div className="kpi-card-top">
                    <span className="kpi-icon kpi-icon-money kpi-icon-lg"><Repeat size={18} /></span>
                    <ScopeTag kind="base" />
                  </div>
                  <div className="kpi-title">Taxa de recompra</div>
                  <div
                    className="kpi-value kpi-value-money kpi-value-lg"
                    title={'Clientes com 2 ou mais compras ÷ todos os clientes que já '
                      + 'compraram. Da base inteira: um cliente que comprou em janeiro e '
                      + 'voltou em julho conta como recomprador em qualquer filtro.'}
                  >
                    {fmtPct(o.repeat_rate)}
                  </div>
                  <div className="kpi-desc">
                    {o.repeat_clients.toLocaleString('pt-BR')} de{' '}
                    {o.total_clients.toLocaleString('pt-BR')} clientes voltaram
                    {' · '}
                    {o.once_clients.toLocaleString('pt-BR')} compraram uma vez só
                  </div>
                </div>
              </div>
            </div>

            <div className="kpi-card kpi-pattern-topo">
              <div className="kpi-card-bg" aria-hidden="true" />
              <div className="kpi-card-top">
                <span className="kpi-icon"><Clock size={16} /></span>
                <ScopeTag kind="base" />
              </div>
              <div className="kpi-title">Tempo até a 2ª compra</div>
              <div
                className="kpi-value"
                title={'Mediana, não média: um cliente que voltou dois anos depois '
                  + 'puxaria a média para um número que não descreve ninguém. Metade '
                  + 'de quem volta, volta em até este prazo — e é este o corte da fila '
                  + 'de reativação lá embaixo.'}
              >
                {o.median_days_to_second == null
                  ? '—'
                  : `${fmtDec(o.median_days_to_second, 0)} d`}
              </div>
              <div className="kpi-desc">
                {o.median_days_to_second == null
                  ? 'nenhum cliente recomprou ainda'
                  : 'mediana — metade volta antes disso'}
              </div>
            </div>

            <div className="kpi-card kpi-pattern-radar">
              <div className="kpi-card-bg" aria-hidden="true" />
              <div className="kpi-card-top">
                <span className="kpi-icon"><ShoppingBag size={16} /></span>
                <ScopeTag kind="base" />
              </div>
              <div className="kpi-title">Compras por cliente</div>
              <div className="kpi-value">
                {o.avg_orders == null ? '—' : fmtDec(o.avg_orders)}
              </div>
              <div className="kpi-desc">média de toda a carteira</div>
            </div>

            {/* O par que justifica a aba existir. Se quem volta vale 3× quem
                não volta, reativação deixa de ser tarefa de sobra. */}
            <div className="kpi-card kpi-pattern-blur">
              <div className="kpi-card-bg" aria-hidden="true" />
              <div className="kpi-card-top">
                <span className="kpi-icon kpi-icon-money"><Award size={16} /></span>
                <ScopeTag kind="base" />
              </div>
              <div className="kpi-title">LTV de quem volta</div>
              <div className="kpi-value kpi-value-money">
                {o.repeat_clients > 0 ? formatBRL(o.repeat_ltv_cents) : '—'}
              </div>
              <div className="kpi-desc">
                {ltvMult == null
                  ? 'sem base de comparação ainda'
                  : `${formatBRL(o.once_ltv_cents)} de quem comprou uma vez · `
                    + `${fmtRatio(ltvMult)} mais`}
              </div>
            </div>
          </div>

          {/* ---------- Estreia x retorno por dia ---------- */}
          <div className="card mb-16">
            <div className="card-title" style={{ marginBottom: 4 }}>
              Faturamento por dia: 1ª venda x recompra — {label}
            </div>
            {!temGrafico ? (
              <EmptyState icon={<Receipt />} text="Nenhuma venda no período selecionado." />
            ) : (
              <div style={{ width: '100%', height: 260 }}>
                <ResponsiveContainer>
                  <ComposedChart data={chartDays} margin={{ top: 5, right: 5, bottom: 0, left: -20 }}>
                    <XAxis dataKey="label" stroke="#52525b" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis stroke="#52525b" fontSize={11} tickLine={false} axisLine={false} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      labelStyle={tooltipLabel}
                      formatter={(v) => formatBRL(Math.round(Number(v) * 100))}
                    />
                    <Legend wrapperStyle={{ fontSize: 11.5 }} />
                    {/* Empilhadas, não lado a lado: a leitura que interessa é
                        a fatia de cada uma dentro do total do dia. */}
                    <Bar stackId="rev" dataKey="primeira" name="1ª venda" fill="#38bdf8" radius={[0, 0, 0, 0]} />
                    <Bar stackId="rev" dataKey="recompra" name="Recompra" fill="#1f7aeb" radius={[3, 3, 0, 0]} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* ---------- Distribuição + quem voltou ---------- */}
          <div className="grid-2">
            <div className="card">
              <div className="card-title" style={{ marginBottom: 4 }}>
                <Layers size={14} /> Clientes por número de compras
              </div>
              <p className="text-muted" style={{ fontSize: 11.5, marginBottom: 14 }}>
                Base inteira — a forma da carteira não depende do período
              </p>
              <div className="table-wrap" style={{ border: 'none', background: 'transparent' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Compras</th>
                      <th style={{ textAlign: 'right' }}>Clientes</th>
                      <th style={{ textAlign: 'right' }}>Receita</th>
                      <th style={{ textAlign: 'right' }}>LTV médio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {buckets.map((b) => (
                      <tr key={b.ord}>
                        <td>{b.bucket === '1' ? '1 compra' : `${b.bucket} compras`}</td>
                        <td style={{ textAlign: 'right', minWidth: 110 }}>
                          {/* Barra proporcional ao maior balde: a distribuição
                              é sempre muito torta, e só o número não mostra
                              o tamanho do degrau. */}
                          <div className="rate-cell">
                            <div className="rate-bar">
                              <span style={{ width: `${(b.clients / maxBucket) * 100}%` }} />
                            </div>
                            <span className="rate-num">{fmtInt(b.clients)}</span>
                          </div>
                        </td>
                        <td style={{ textAlign: 'right' }}>{formatBRL(b.revenue_cents)}</td>
                        <td style={{ textAlign: 'right' }} className="text-muted">
                          {formatBRL(b.avg_ltv_cents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <CollapsibleCard
              icon={<UserCheck size={14} />}
              title={`Quem voltou — ${label}`}
              hint={`${fmtInt(top.length)} cliente(s)`}
            >
              {top.length === 0 ? (
                <p className="text-muted" style={{ fontSize: 13 }}>
                  Nenhuma recompra no período selecionado.
                </p>
              ) : (
                <div className="table-wrap" style={{ border: 'none', background: 'transparent' }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Cliente</th>
                        <th style={{ textAlign: 'right' }}>Compras</th>
                        <th style={{ textAlign: 'right' }}>Total</th>
                        <th style={{ textAlign: 'right' }}>A cada</th>
                      </tr>
                    </thead>
                    <tbody>
                      {top.map((r) => (
                        <tr
                          key={r.contact_id}
                          className={onOpenContact ? 'row-clickable' : undefined}
                          onClick={onOpenContact && (() => onOpenContact(r.contact_id))}
                          title={onOpenContact ? 'Abrir contato para ver e editar as vendas' : undefined}
                        >
                          <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {r.name}
                            <span className="text-muted" style={{ fontSize: 11, marginLeft: 6 }}>
                              {r.repeat_in_period} no período
                            </span>
                          </td>
                          <td style={{ textAlign: 'right' }}>{fmtInt(r.total_sales)}</td>
                          <td style={{ textAlign: 'right' }}>{formatBRL(r.total_revenue_cents)}</td>
                          <td style={{ textAlign: 'right' }} className="text-muted">
                            {r.avg_days_between == null ? '—' : `${fmtDec(r.avg_days_between, 0)} d`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CollapsibleCard>
          </div>

          {/* ---------- Fila de reativação ---------- */}
          <CollapsibleCard
            icon={<CalendarClock size={14} />}
            title="Compraram uma vez e não voltaram"
            hint={pending === null ? undefined : `${fmtInt(pending.total)} cliente(s)`}
            style={{ marginTop: 16 }}
            subtitle={<>
              {/* Ordenado por valor, não por tempo parado: quem comprou há
                  dois anos está mais parado, mas quem gastou mais é quem
                  vale a ligação. */}
              Do maior gasto para o menor
              {onlyOverdue && medianDays > 0
                ? ` — só quem já passou dos ${medianDays} dias em que metade dos clientes costuma voltar`
                : ' — toda a carteira de uma compra só'}
            </>}
          >
            {/* O corte só faz sentido quando existe mediana: sem ninguém que
                tenha recomprado, não há "tempo típico" a ultrapassar. Fica no
                corpo, e não no cabeçalho: clicar nele não pode encolher o
                card que ele filtra. */}
            {medianDays > 0 && (
              <label className="channel-filter" style={{ gap: 8, cursor: 'pointer', marginBottom: 4 }}>
                <input
                  type="checkbox"
                  checked={onlyOverdue}
                  onChange={(e) => setOnlyOverdue(e.target.checked)}
                />
                <span style={{ fontSize: 12 }}>Só quem passou do prazo</span>
              </label>
            )}

            {pending === null ? (
              <p className="text-muted" style={{ fontSize: 13, marginTop: 12 }}>Carregando…</p>
            ) : pending.rows.length === 0 ? (
              <p className="text-muted" style={{ fontSize: 13, marginTop: 12 }}>
                {onlyOverdue
                  ? 'Ninguém de uma compra só passou do prazo típico de retorno.'
                  : 'Todos os clientes já recompraram pelo menos uma vez.'}
              </p>
            ) : (
              <>
                <div className="table-wrap" style={{ border: 'none', background: 'transparent', marginTop: 12 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Cliente</th>
                        <th>Origem</th>
                        <th>Canal</th>
                        <th style={{ textAlign: 'right' }}>Gastou</th>
                        <th style={{ textAlign: 'right' }}>Comprou em</th>
                        <th style={{ textAlign: 'right' }}>Parado há</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pending.rows.map((r) => (
                        <tr
                          key={r.contact_id}
                          className={onOpenContact ? 'row-clickable' : undefined}
                          onClick={onOpenContact && (() => onOpenContact(r.contact_id))}
                          title={onOpenContact ? 'Abrir contato para registrar a recompra' : undefined}
                        >
                          <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {r.name}
                            {r.phone && (
                              <span className="text-muted mono" style={{ fontSize: 11, marginLeft: 6 }}>{r.phone}</span>
                            )}
                          </td>
                          <td className="text-muted" style={{ fontSize: 12 }}>{r.origem ?? '—'}</td>
                          <td className="text-muted" style={{ fontSize: 12 }}>{r.channel ?? '—'}</td>
                          <td style={{ textAlign: 'right' }}>{formatBRL(r.value_cents)}</td>
                          <td style={{ textAlign: 'right' }} className="text-muted">{formatSP(r.sold_at)}</td>
                          <td style={{ textAlign: 'right' }}>{fmtInt(r.days_since)} d</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="table-foot">
                  <span className="text-muted" style={{ fontSize: 12 }}>
                    Mostrando {pending.rows.length} de {pending.total.toLocaleString('pt-BR')}
                  </span>
                  {pending.rows.length < pending.total && (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setPendingLimit((n) => n + REPEAT_PAGE)}
                    >
                      <ChevronDown size={14} />
                      Mostrar mais {Math.min(REPEAT_PAGE, pending.total - pending.rows.length)}
                    </button>
                  )}
                </div>
              </>
            )}
          </CollapsibleCard>
        </>
      )}
    </>
  )
}

/**
 * Aba Meta ADS — o que a mídia paga custou e o que ela devolveu.
 *
 * Os números vêm de DOIS lugares, e isso é a coisa mais importante a saber
 * ao ler esta tela:
 *
 *   CUSTO e ENTREGA  → Marketing API da Meta, pela Edge Function meta-ads.
 *   RECEITA, TICKET  → banco (crm_report_ads_*, 052), sobre os contatos que
 *   LTV e CLIENTES     vieram de anúncio.
 *
 * ROAS, CAC e CPL são divisões de um pelo outro, feitas aqui. Se o lado
 * da Meta faltar — conta não configurada, token sem ads_read, API fora —, os
 * cards de receita continuam de pé e os de custo dizem o que falta, em vez de
 * mostrarem zero como se fosse resultado. É a diferença entre "não gastei" e
 * "não sei quanto gastei".
 *
 * A JANELA DAQUI TERMINA ONTEM
 *
 * Nos presets de "últimos N dias" esta aba consulta um dia antes das demais,
 * porque é assim que o Gerenciador de Anúncios conta — ver adsRange. É a
 * única aba com um número externo para conferir, e ela ganha o formato de
 * quem confere.
 *
 * POR QUE A RECEITA DAQUI NÃO É A DO GERENCIADOR DE ANÚNCIOS
 *
 * A Meta só atribui o que ela conseguiu casar: evento com ctwa_clid, dentro
 * da janela de atribuição dela. O CRM sabe de todas as vendas dos clientes de
 * anúncio, inclusive as recompras e as de quem foi marcado como anúncio na
 * mão, sem clique capturado. Os dois números convivem na tela de propósito —
 * a tabela por campanha mostra o da Meta, os cards mostram o do caixa.
 *
 * "Cliente de anúncio" é a mesma regra que decide o envio da conversão
 * (crm_is_ad_contact, 052/071): com ctwa_clid, com clique de mídia paga na
 * landing (fbc + campanha) ou com a origem declarando mídia paga. Não
 * existe segunda definição.
 *
 * VÁRIAS CONTAS DE ANÚNCIOS (058)
 *
 * A org lê três contas. Os cards mostram a SOMA delas, e o seletor no topo
 * permite olhar uma de cada vez. Filtrar tira ROAS, CAC e CPL da tela,
 * de propósito: a receita do CRM não se divide por conta — nada no contato
 * diz de qual conta veio o lead —, então dividir o caixa inteiro pelo gasto
 * de uma conta só produziria um ROAS três vezes maior que o real. Com a
 * seleção parcial a tela vira "entrega da conta X", e os cards de retorno
 * dizem por que sumiram.
 */
function AdsReport({ label, preset, range, previous, channel, isAdmin }: {
  label: string
  /** Avisa que o gasto de "hoje" ainda está correndo e qual janela está na
      tela — a daqui é a do Gerenciador, não a das outras abas (adsRange). */
  preset: PeriodId
  /** Já recuada pelo adsRange: nos presets de "últimos N dias", termina ontem. */
  range: DateRange
  /** Janela anterior de mesmo tamanho, para os badges. null no All-Time. */
  previous: DateRange | null
  channel: string
  /** Tirar campanha do relatório muda o que TODOS veem — mesma regra das
      credenciais da Meta (054), que também é exclusiva de admin. */
  isAdmin: boolean
}) {
  const [crm, setCrm] = useState<{
    overview: CrmAdsOverview
    series: CrmAdsDayRow[]
    prevOverview: CrmAdsOverview | null
  } | null>(null)
  /** Consulta ao banco em andamento. Enquanto for true a tela mostra
      esqueleto, nunca o número do filtro anterior — ver skeletons.tsx. */
  const [crmLoading, setCrmLoading] = useState(true)
  const [meta, setMeta] = useState<MetaAdsInsights | null>(null)
  const [metaLoading, setMetaLoading] = useState(true)
  const [adsLimit, setAdsLimit] = useState(ADS_PAGE)
  /** Tabelas por campanha e por anúncio: fechadas por padrão. Guardado aqui,
      e não dentro do card, porque o relatório inteiro vira esqueleto a cada
      troca de filtro — no card, a escolha voltaria a "fechado" toda vez. */
  const [verCampanhas, setVerCampanhas] = useState(false)
  const [verAnuncios, setVerAnuncios] = useState(false)
  /** Contas cadastradas, para montar o seletor. Vem do banco, não da Meta. */
  const [roster, setRoster] = useState<CrmAdAccount[]>([])
  /** Contas escolhidas no seletor. Vazio = todas — é o padrão e o único
      estado em que ROAS, CAC e CPL fazem sentido. */
  const [selecionadas, setSelecionadas] = useState<string[]>([])
  /** Campanhas fora do relatório. Configuração da org, não filtro local. */
  const [ignoradas, setIgnoradas] = useState<CrmExcludedCampaign[]>([])
  /** Recarrega o lado da Meta quando a lista de ignoradas muda. */
  const [ignoradasVersao, setIgnoradasVersao] = useState(0)

  const { from, to } = range
  // Desmontado em primitivos: `previous` é um objeto novo a cada render do
  // pai, e como dependência de efeito ele recarregaria tudo sem parar.
  const prevFrom = previous?.from ?? null
  const prevTo = previous?.to ?? null

  // Lado do banco. Separado do lado da Meta de propósito: a consulta externa
  // é a lenta e a que pode falhar, e não faz sentido a receita esperar por
  // ela (nem sumir junto quando o token estiver errado).
  useEffect(() => {
    let cancelado = false
    setCrmLoading(true)
    const anterior = prevFrom && prevTo ? { from: prevFrom, to: prevTo } : null
    Promise.all([
      crmService.reportAdsOverview({ from, to }, channel),
      crmService.reportAdsTimeseries({ from, to }, channel),
      anterior ? crmService.reportAdsOverview(anterior, channel) : null,
    ])
      .then(([overview, series, prevOverview]) => {
        if (!cancelado) setCrm({ overview, series, prevOverview })
      })
      .catch((err) => {
        if (!cancelado) toast.error(err instanceof Error ? err.message : 'Falha ao carregar o relatório de anúncios')
      })
      .finally(() => { if (!cancelado) setCrmLoading(false) })
    return () => { cancelado = true }
  }, [from, to, prevFrom, prevTo, channel])

  // Contas cadastradas. Separado da consulta à Meta porque o seletor precisa
  // da lista INTEIRA mesmo quando a consulta está filtrada — se ele viesse da
  // resposta, escolher uma conta apagaria as outras do próprio seletor.
  useEffect(() => {
    let cancelado = false
    crmService.listAdAccounts()
      .then((r) => { if (!cancelado) setRoster(r) })
      .catch(() => { if (!cancelado) setRoster([]) })
    return () => { cancelado = true }
  }, [])

  // Campanhas ignoradas. Vem do banco em vez da resposta da Meta porque
  // campanha pausada não aparece na janela consultada — e ela precisa
  // continuar listada para dar para trazer de volta.
  useEffect(() => {
    let cancelado = false
    crmService.listExcludedCampaigns()
      .then((r) => { if (!cancelado) setIgnoradas(r) })
      .catch(() => { if (!cancelado) setIgnoradas([]) })
    return () => { cancelado = true }
  }, [ignoradasVersao])

  // Lado da Meta. Erro esperado volta da Edge Function com ok: false e a
  // mensagem dela inteira — é isso que a tela mostra, em vez de um toast
  // genérico que some antes de o usuário ler.
  const contasQuery = selecionadas.join(',')
  useEffect(() => {
    let cancelado = false
    setMetaLoading(true)
    metaAdsService
      .insights({
        range: { from, to },
        previous: prevFrom && prevTo ? { from: prevFrom, to: prevTo } : null,
        accounts: contasQuery ? contasQuery.split(',') : [],
      })
      .then((r) => { if (!cancelado) setMeta(r) })
      .catch((err) => {
        if (!cancelado) {
          setMeta({
            ok: false,
            configured: true,
            error: err instanceof Error ? err.message : 'Falha ao consultar a Meta',
          })
        }
      })
      .finally(() => { if (!cancelado) setMetaLoading(false) })
    return () => { cancelado = true }
  }, [from, to, prevFrom, prevTo, contasQuery, ignoradasVersao])

  // Trocar o período volta a tabela de anúncios ao primeiro bloco: manter 60
  // linhas abertas de um período que não é mais o da tela confunde a leitura.
  useEffect(() => { setAdsLimit(ADS_PAGE) }, [from, to, channel])

  /**
   * Tira a campanha dos totais — para sempre e para todo mundo, até alguém
   * trazê-la de volta. A confirmação não é cerimônia: é onde fica a única
   * regra que torna a exclusão honesta, e ela precisa ser lida antes, não
   * descoberta depois num ROAS que não fecha.
   */
  async function ignorarCampanha(row: MetaAdsRow) {
    if (!row.campaign_id) return
    const ok = await confirmDialog({
      title: 'Tirar do relatório',
      message: `"${row.campaign_name ?? row.campaign_id}" sai do investimento, da `
        + 'entrega e do ROAS, para todos os usuários.\n\n'
        + 'Faça isso só se ela NÃO gera lead no CRM — recrutamento, vaga, '
        + 'institucional. Se ela traz cliente, as vendas dele continuam no caixa '
        + 'e tirar só o custo deixaria o ROAS maior do que é.',
      confirmLabel: 'Tirar do relatório',
    })
    if (!ok) return
    try {
      await crmService.excludeCampaign({
        campaignId: row.campaign_id,
        campaignName: row.campaign_name,
        accountId: row.account_id,
      })
      toast.success('Campanha fora do relatório')
      setIgnoradasVersao((v) => v + 1)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao alterar o relatório')
    }
  }

  async function voltarCampanha(campanha: CrmExcludedCampaign) {
    try {
      await crmService.includeCampaign(campanha.campaign_id)
      toast.success('Campanha de volta no relatório')
      setIgnoradasVersao((v) => v + 1)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao alterar o relatório')
    }
  }

  // ---------- Os dois lados ----------
  // O que depende SÓ da Meta vem antes da guarda do `crm`: o cabeçalho com o
  // seletor de contas fica na tela enquanto o banco responde. Sumir com o
  // seletor no instante seguinte ao clique nele seria o pior momento
  // possível para a tela piscar.
  const totals = meta?.ok ? meta.totals ?? null : null
  // Resposta anterior à 058 não traz `accounts`. Sintetizar uma entrada a
  // partir de `account` mantém avisos de fuso e de conta inativa de pé na
  // janela entre o deploy da Edge Function e o desta tela.
  const contas: MetaAdsAccountResult[] = meta?.accounts ?? (
    meta?.ok && meta.account
      ? [{
        ...meta.account,
        label: null,
        ok: true,
        error: null,
        hint: null,
        totals: meta.totals ?? null,
      }]
      : []
  )
  const contasOk = contas.filter((c) => c.ok)
  const contasComFalha = contas.filter((c) => !c.ok)
  // Compat com uma resposta anterior à 058, que só tinha `account`.
  const currency = meta?.currency ?? meta?.account?.currency ?? null

  /**
   * O cabeçalho é o único pedaço que NÃO vira esqueleto: título, período e
   * seletor de contas não dependem de consulta nenhuma, e o seletor é
   * justamente o que a pessoa acabou de clicar. Ele fica de pé enquanto o
   * resto recarrega.
   */
  const cabecalho = (
    <div className="page-header">
      <div>
        <h2 style={{ fontSize: 17 }}>Meta ADS</h2>
        <p>
          Investimento na Meta contra a receita dos clientes que vieram de
          anúncio · {label}
        </p>
        {/* A janela desta aba não é a das outras (adsRange). Sem dizer isso na
            tela, trocaríamos uma confusão por outra: o gasto de "7 dias" aqui
            passaria a diferir do faturamento de "7 dias" na aba Vendas. */}
        {/* Cor no inline porque `.page-header p` vence a classe .text-muted na
            especificidade — sem isso a linha sairia do mesmo tom da de cima e
            competiria com ela em vez de ficar em segundo plano. */}
        {ehUltimosNDias(preset) && (
          <p style={{ fontSize: 11.5, marginTop: 4, color: 'var(--text-muted)' }}>
            {shortDate(from)} a {shortDate(to)} — a mesma janela do Gerenciador
            de Anúncios, que termina ontem. Hoje fica de fora só aqui; nas
            outras abas ele entra.
          </p>
        )}
      </div>
      {/* Seletor de contas. Com uma conta só ele vira a etiqueta de antes:
          não há o que escolher, mas continua importante dizer de qual conta
          saiu cada número da tela. */}
      {roster.length > 1 ? (
        <div className="ads-accounts-picker">
          <button
            className={`ads-account-chip${selecionadas.length === 0 ? ' active' : ''}`}
            onClick={() => setSelecionadas([])}
            title="Soma das contas — é a única visão em que ROAS e CAC fecham com a receita"
          >
            <Megaphone size={12} /> Todas
          </button>
          {roster.map((a) => {
            const ativa = selecionadas.includes(a.account_id)
            const resultado = contas.find((c) => c.id === a.account_id)
            return (
              <button
                key={a.id}
                className={`ads-account-chip${ativa ? ' active' : ''}`}
                title={a.account_id}
                onClick={() => setSelecionadas((atual) => (
                  ativa
                    ? atual.filter((id) => id !== a.account_id)
                    : [...atual, a.account_id]
                ))}
              >
                {a.label ?? resultado?.name ?? a.account_id}
                {resultado && !resultado.ok && <TriangleAlert size={12} />}
              </button>
            )
          })}
        </div>
      ) : meta?.account && (
        <div className="ads-account" title={`Conta ${meta.account.id}`}>
          <Megaphone size={13} />
          <span>{roster[0]?.label ?? meta.account.name ?? meta.account.id}</span>
          {meta.account.currency && <span className="ads-account-sep">{meta.account.currency}</span>}
          {/* Qualquer status diferente de 1 explica sozinho um gasto zerado
              — sem isso o usuário procura erro no relatório. */}
          {meta.account.status != null && meta.account.status !== 1 && (
            <span className="badge badge-gray">conta inativa</span>
          )}
        </div>
      )}
    </div>
  )

  /**
   * Lado do banco carregando — primeira vez ou troca de filtro, o mesmo
   * tratamento. Não existe "mostra o de antes enquanto vem o novo": o
   * relatório inteiro depende do período, e número do período errado não se
   * anuncia como errado.
   */
  if (!crm || crmLoading) {
    return (
      <>
        {cabecalho}
        <SkelKpis n={11} />
        <SkelChartCard />
      </>
    )
  }

  const { overview, series, prevOverview } = crm

  /**
   * Seleção parcial de contas: os números da Meta são só das escolhidas, mas
   * a receita do CRM continua sendo de TODA a org — ela não se divide por
   * conta (nada no contato diz de qual conta veio o lead). Dividir uma pela
   * outra daria um ROAS inflado, então as divisões saem de cena e a tela
   * explica o motivo no lugar delas.
   */
  const selecaoParcial = selecionadas.length > 0 && selecionadas.length < roster.length

  /**
   * Moeda que não bate: a conta fatura em outra, ou as contas selecionadas
   * faturam em moedas diferentes entre si. Nos dois casos o gasto continua
   * certo na moeda dele, mas somá-lo à receita em BRL seria invenção.
   */
  const moedaDiferente = !!meta?.mixed_currency || (!!currency && currency !== 'BRL')

  const spend = totals?.spend ?? null
  // Sem gasto não há divisão possível: custo zero faria ROAS e CAC estourarem
  // em infinito, que na tela vira "∞%" — pior do que um traço honesto.
  const temCusto = spend != null && spend > 0
  /** As três condições para o retorno ser calculável, num lugar só. */
  const podeDividir = temCusto && !moedaDiferente && !selecaoParcial

  const receita = overview.revenue_cents / 100
  // Em múltiplo, não em porcentagem: receita ÷ gasto sem o ×100. 3,4× é
  // R$ 3,40 de venda para cada R$ 1 investido, o próprio R$ 1 incluído.
  //
  // AQUI ERA O ROI ((receita − gasto) ÷ gasto), e ele saiu por dois motivos.
  // Primeiro, ROI = ROAS − 1 por identidade: ocupava o destaque da tela para
  // repetir, noutra unidade, o número que a tabela de campanhas já dava.
  // Segundo, "ROI" promete lucro e este não é lucro — desconta a mídia e
  // para aí; produto, imposto, taxa e comissão continuam dentro. E é ROAS o
  // que o Gerenciador da Meta e a tabela abaixo mostram, então o card passou
  // a falar a mesma língua das outras telas.
  //
  // O que sobra depois do anúncio continua visível como `lucro`, em reais,
  // na linha de apoio — é a parte do ROI que era de fato informação. O ROI
  // volta a fazer sentido no dia em que houver margem cadastrada para
  // descontar os outros custos; sem ela, seria o mesmo eco de hoje.
  const roas = podeDividir ? receita / spend! : null
  const lucro = podeDividir ? receita - spend! : null
  const cac = podeDividir && overview.new_clients > 0 ? spend! / overview.new_clients : null
  const cpl = podeDividir && overview.leads > 0 ? spend! / overview.leads : null
  const ltv = overview.total_ltv_cents / 100
  const ltvCac = cac && cac > 0 ? ltv / cac : null
  const fatia = overview.leads_all > 0
    ? Math.round((overview.leads / overview.leads_all) * 100)
    : null

  /** O que dizer no lugar do número quando a divisão não é possível. */
  const semRetorno = selecaoParcial
    ? 'a receita não se divide por conta'
    : moedaDiferente
    ? 'moedas diferentes'
    : 'precisa do investimento da Meta'

  // Série do gráfico: um ponto por dia do período, com o gasto da Meta ao
  // lado da receita do CRM. A base é a série do banco porque ela tem TODOS
  // os dias da janela — a da Meta pula os dias sem veiculação.
  // Com moedas diferentes o gasto do dia é a soma de grandezas distintas:
  // a barra sai de cena e o gráfico vira só a receita.
  const gastoPorDia = new Map(
    meta?.mixed_currency
      ? []
      : (meta?.daily ?? []).filter((d) => d.date).map((d) => [d.date as string, d.spend] as const),
  )
  const chartDays = series.map((r) => ({
    label: shortDate(r.day),
    investimento: gastoPorDia.get(r.day) ?? 0,
    receita: r.revenue_cents / 100,
  }))
  const temGrafico = chartDays.some((d) => d.investimento > 0 || d.receita > 0)

  const campanhas = meta?.campaigns ?? []
  const anuncios = meta?.ads ?? []

  // O aviso de fuso não é preciosismo: num filtro de "hoje" ou "ontem" a
  // diferença entre os relógios muda o gasto do dia, e sem essa linha a
  // conclusão é de que o relatório está errado. Com três contas o fuso pode
  // divergir em uma só, então a lista é de fusos distintos.
  /** Quanto as campanhas ignoradas gastaram na janela — o que saiu do total. */
  const gastoIgnorado = (meta?.excluded_campaigns ?? []).reduce((s, c) => s + c.spend, 0)
  /**
   * Quantas ignoradas VEICULARAM na janela — não quantas estão na lista.
   * São coisas diferentes: campanha de recrutamento pausada há meses continua
   * na configuração e não tirou um centavo deste período. Ao lado da contagem
   * das que entraram, só a primeira é comparável.
   */
  const ignoradasNoPeriodo = (meta?.excluded_campaigns ?? []).length

  return (
    <>
      {cabecalho}

      {/* ---------- Estado do lado da Meta ----------
          O "carregando" da Meta não é um aviso de texto: cada bloco que
          depende dela vira esqueleto no seu próprio lugar, mais abaixo. */}
      {!metaLoading && meta && !meta.ok && (
        <div className={`card mb-16 ads-notice${meta.configured ? ' ads-notice-error' : ''}`}>
          <div className="card-title" style={{ marginBottom: 6 }}>
            <TriangleAlert size={14} />
            {meta.configured ? 'A Meta recusou a consulta' : 'Conta de anúncios não conectada'}
          </div>
          <p style={{ fontSize: 13, marginBottom: meta.hint ? 8 : 0 }}>{meta.error}</p>
          {meta.hint && <p className="text-muted" style={{ fontSize: 12 }}>{meta.hint}</p>}
        </div>
      )}

      {/* Uma conta fora do ar não zera o relatório, mas o total passa a ser
          menor que o real — e um total incompleto sem aviso é o mesmo que um
          total errado. */}
      {!metaLoading && contasComFalha.length > 0 && contasOk.length > 0 && (
        <div className="card mb-16 ads-notice">
          <div className="card-title" style={{ marginBottom: 6 }}>
            <TriangleAlert size={14} />
            {contasComFalha.length === 1
              ? '1 conta ficou de fora dos totais'
              : `${contasComFalha.length} contas ficaram de fora dos totais`}
          </div>
          {contasComFalha.map((c) => (
            <p key={c.id} style={{ fontSize: 12.5, marginBottom: 6 }}>
              <strong>{c.label ?? c.name ?? c.id}</strong> · {c.error}
              {c.hint && <span className="text-muted"> — {c.hint}</span>}
            </p>
          ))}
        </div>
      )}

      {/* Filtrou uma conta: o gasto é dela, a receita é da org inteira. */}
      {selecaoParcial && (
        <div className="card mb-16 ads-notice">
          <div className="card-title" style={{ marginBottom: 6 }}>
            <TriangleAlert size={14} /> Vendo {selecionadas.length} de {roster.length} contas
          </div>
          <p style={{ fontSize: 13 }}>
            Investimento, entrega e as tabelas abaixo são só das contas
            selecionadas. Receita, ticket e LTV continuam sendo de todos os
            clientes de anúncio — o CRM não sabe de qual conta veio cada lead,
            porque nada no contato aponta para uma conta.
          </p>
        </div>
      )}

      {/* A moeda vem da resposta da Meta, então o aviso espera a nova: com a
          consulta no ar ele ainda estaria falando da conta de antes. */}
      {!metaLoading && moedaDiferente && (
        <div className="card mb-16 ads-notice">
          <div className="card-title" style={{ marginBottom: 6 }}>
            <TriangleAlert size={14} /> Moedas diferentes
          </div>
          <p style={{ fontSize: 13 }}>
            {meta?.mixed_currency
              ? 'As contas selecionadas faturam em moedas diferentes entre si, '
                + 'então os totais em dinheiro não somam. Use a quebra por conta '
                + 'abaixo, cada uma na moeda dela.'
              : `A conta fatura em ${currency} e as vendas do CRM estão em BRL. O `
                + 'investimento aparece na moeda dela, mas ROAS, CAC e CPL '
                + 'ficam de fora — dividir um pelo outro daria um número inventado.'}
          </p>
        </div>
      )}

      {/* ---------- KPIs ---------- */}
      <div className="crm-kpis crm-kpis-dense">
        <div className="kpi-card kpi-pattern-bars">
          <div className="kpi-card-bg" aria-hidden="true" />
          <div className="kpi-card-top">
            <span className="kpi-icon"><Wallet size={16} /></span>
            {/* O badge de variação some enquanto a consulta corre: ele compara
                com o período anterior e, com o número novo ainda vindo, a
                comparação seria entre duas janelas diferentes. */}
            {!metaLoading && (
              <GrowthBadge
                pct={growthVsPrev(spend ?? 0, meta?.previous?.spend)}
                anterior={meta?.previous ? fmtMoney(meta.previous.spend, currency) : undefined}
              />
            )}
          </div>
          {/* "Gasto", não "Investimento": o número é o que a Meta entregou e
              cobrou no período, não o orçamento que o gestor configurou. */}
          <div className="kpi-title">Gasto na Meta</div>
          <div className="kpi-value">
            <SkelValue on={metaLoading} w={130} h={26}>
              {spend == null ? '—' : fmtMoney(spend, currency)}
            </SkelValue>
          </div>
          <div className="kpi-desc">
            <SkelValue on={metaLoading} w={150} h={10}>
              {spend == null
                ? 'sem dados da Meta'
                : preset === 'hoje' ? 'consumido hoje, até agora' : `consumido — ${label}`}
            </SkelValue>
          </div>
        </div>

        <div className="kpi-card kpi-pattern-grid">
          <div className="kpi-card-bg" aria-hidden="true" />
          <div className="kpi-card-top">
            <span className="kpi-icon kpi-icon-money"><DollarSign size={16} /></span>
            <div className="kpi-top-right">
              <ScopeTag kind="conversao" />
              <GrowthBadge
                pct={growthVsPrev(overview.revenue_cents, prevOverview?.revenue_cents)}
                anterior={prevOverview ? formatBRL(prevOverview.revenue_cents) : undefined}
              />
            </div>
          </div>
          <div className="kpi-title">Receita de anúncios</div>
          <div
            className="kpi-value kpi-value-money"
            title={'Soma das vendas (1ª e recompras) dos clientes que vieram de '
              + 'anúncio, pela data em que a venda foi lançada. É o dinheiro que '
              + 'entrou no caixa; o que a Meta conseguiu contar sozinha aparece na '
              + 'tabela por campanha, e quase nunca bate.'}
          >
            {formatBRL(overview.revenue_cents)}
          </div>
          <div className="kpi-desc">
            {overview.sales.toLocaleString('pt-BR')} venda(s) de{' '}
            {overview.clients.toLocaleString('pt-BR')} cliente(s)
          </div>
        </div>

        {/* O card que a operação abre a tela para ver. Featured porque é a
            resposta, não um insumo dela. */}
        <div className="kpi-card kpi-card-featured kpi-pattern-mesh">
          <div className="kpi-card-bg" aria-hidden="true" />
          <div className="kpi-featured-row">
            <div>
              <div className="kpi-card-top">
                <span className="kpi-icon kpi-icon-money kpi-icon-lg"><TrendingUp size={18} /></span>
              </div>
              <div className="kpi-title">ROAS</div>
              {/* Verde a partir de 1×, não de 0: 1× é o ponto em que o anúncio
                  se pagou e não sobrou nada — o mesmo corte que o ROI marcava
                  em 0, já que ROI = ROAS − 1. */}
              <div
                className={`kpi-value kpi-value-lg ${roas == null ? '' : roas >= 1 ? 'kpi-value-money' : 'kpi-value-loss'}`}
                title={'receita ÷ gasto, em múltiplo do investido: 3,4× é R$ 3,40 de '
                  + 'venda para cada R$ 1 gasto, com o próprio R$ 1 incluído. Abaixo '
                  + 'de 1× o anúncio não se pagou. Desconta só a mídia: custo de '
                  + 'produto, equipe e imposto não entram na conta.'}
              >
                <SkelValue on={metaLoading} w={170} h={38}>
                  {roas == null ? '—' : fmtRatio(roas)}
                </SkelValue>
              </div>
              <div className="kpi-desc">
                <SkelValue on={metaLoading} w={200} h={10}>
                  {roas == null
                    ? semRetorno
                    : lucro! >= 0
                      ? `sobra ${formatBRL(Math.round(lucro! * 100))} depois do anúncio`
                      : `falta ${formatBRL(Math.round(-lucro! * 100))} para se pagar`}
                </SkelValue>
              </div>
            </div>
          </div>
        </div>

        <div className="kpi-card kpi-pattern-blur">
          <div className="kpi-card-bg" aria-hidden="true" />
          <div className="kpi-card-top">
            <span className="kpi-icon kpi-icon-money"><Receipt size={16} /></span>
            <ScopeTag kind="conversao" />
          </div>
          <div className="kpi-title">Ticket médio</div>
          <div
            className="kpi-value kpi-value-money"
            title="Receita ÷ vendas dos clientes de anúncio no período."
          >
            {overview.sales > 0 ? formatBRL(overview.avg_ticket_cents) : '—'}
          </div>
          <div className="kpi-desc">
            por venda · {overview.first_sales.toLocaleString('pt-BR')} 1ª venda,{' '}
            {overview.repeat_sales.toLocaleString('pt-BR')} recompra
          </div>
        </div>

        {/* LTV é sempre de todo o histórico, mesmo com filtro de 7 dias — e o
            card diz isso. Recortado pela janela ele mede "receita por cliente
            ativo na semana", que não serve para comparar com o CAC. */}
        <div className="kpi-card kpi-pattern-blur">
          <div className="kpi-card-bg" aria-hidden="true" />
          <div className="kpi-card-top">
            <span className="kpi-icon kpi-icon-money"><Users size={16} /></span>
          </div>
          <div className="kpi-title">LTV do cliente de ads</div>
          <div
            className="kpi-value kpi-value-money"
            title={'Tudo que os clientes de anúncio já compraram ÷ quantos são. '
              + 'Ignora o período selecionado de propósito: LTV é valor de cliente, '
              + 'e recortá-lo numa janela mediria outra coisa. É receita realizada, '
              + 'não projeção — cliente novo ainda vai comprar.'}
          >
            {overview.total_clients > 0 ? formatBRL(overview.total_ltv_cents) : '—'}
          </div>
          <div className="kpi-desc">
            todo o histórico · {overview.total_clients.toLocaleString('pt-BR')} cliente(s)
            {/* O LTV é do banco, mas a razão LTV/CAC tem o gasto da Meta no
                denominador: enquanto ele não chega, some — senão sobra na
                tela a razão calculada com o gasto do filtro anterior. */}
            {!metaLoading && ltvCac != null && ` · LTV/CAC ${fmtRatio(ltvCac)}`}
          </div>
        </div>

        <div className="kpi-card kpi-pattern-topo">
          <div className="kpi-card-bg" aria-hidden="true" />
          <div className="kpi-card-top">
            <span className="kpi-icon"><Target size={16} /></span>
          </div>
          <div className="kpi-title">CAC</div>
          <div className="kpi-value">
            <SkelValue on={metaLoading} w={120} h={26}>
              {cac == null ? '—' : fmtMoney(cac, currency)}
            </SkelValue>
          </div>
          <div
            className="kpi-desc"
            title={'Gasto ÷ clientes NOVOS: contatos de anúncio cuja '
              + 'primeira venda da vida caiu no período. Recompra não é aquisição '
              + 'e não entra no denominador.'}
          >
            {overview.new_clients.toLocaleString('pt-BR')} cliente(s) novo(s) no período
          </div>
        </div>

        <div className="kpi-card kpi-pattern-radar">
          <div className="kpi-card-bg" aria-hidden="true" />
          <div className="kpi-card-top">
            <span className="kpi-icon"><Megaphone size={16} /></span>
            <div className="kpi-top-right">
              <ScopeTag kind="entrada" />
              <GrowthBadge
                pct={growthVsPrev(overview.leads, prevOverview?.leads)}
                anterior={prevOverview ? `${prevOverview.leads.toLocaleString('pt-BR')} leads` : undefined}
              />
            </div>
          </div>
          <div className="kpi-title">Leads de anúncio</div>
          <div className="kpi-value">{overview.leads.toLocaleString('pt-BR')}</div>
          <div className="kpi-desc">
            {/* O CPL depende do gasto: enquanto ele não chega, a linha fica só
                com o que é do banco, em vez de citar um custo do filtro velho. */}
            {!metaLoading && cpl != null && `${fmtMoney(cpl, currency)} por lead · `}
            {fatia == null ? 'nenhum lead no período' : `${fatia}% da entrada`}
            {/* Clique rastreado = ctwa_clid (CTWA) ou fbc + campanha (landing):
                o que permite atribuir a venda a um anúncio (migration 100). O
                resto entrou como anúncio declarado na origem. */}
            {overview.leads > 0 && ` · ${overview.leads_ctwa.toLocaleString('pt-BR')} com clique rastreado`}
          </div>
        </div>

        {/* Os quatro da entrega vêm direto da Meta, como no Gerenciador — com
            várias contas, somados. Eram um card à parte ("Entrega da Meta");
            subiram para a fileira no mesmo formato dos outros. */}
        <div className="kpi-card kpi-pattern-grid">
          <div className="kpi-card-bg" aria-hidden="true" />
          <div className="kpi-card-top">
            <span className="kpi-icon"><Eye size={16} /></span>
          </div>
          <div className="kpi-title">CPM</div>
          <div className="kpi-value">
            <SkelValue on={metaLoading} w={110} h={26}>
              {totals ? fmtMoney(totals.cpm, currency) : '—'}
            </SkelValue>
          </div>
          <div className="kpi-desc">custo por mil impressões</div>
        </div>

        <div className="kpi-card kpi-pattern-bars">
          <div className="kpi-card-bg" aria-hidden="true" />
          <div className="kpi-card-top">
            <span className="kpi-icon"><MousePointerClick size={16} /></span>
          </div>
          <div className="kpi-title">CPC</div>
          <div className="kpi-value">
            <SkelValue on={metaLoading} w={110} h={26}>
              {totals ? fmtMoney(totals.cpc, currency) : '—'}
            </SkelValue>
          </div>
          <div className="kpi-desc">custo por clique</div>
        </div>

        <div className="kpi-card kpi-pattern-radar">
          <div className="kpi-card-bg" aria-hidden="true" />
          <div className="kpi-card-top">
            <span className="kpi-icon"><MessageCircle size={16} /></span>
          </div>
          <div className="kpi-title">Conversas iniciadas</div>
          <div className="kpi-value">
            <SkelValue on={metaLoading} w={80} h={26}>
              {totals ? fmtInt(totals.messaging) : '—'}
            </SkelValue>
          </div>
          <div className="kpi-desc">
            <SkelValue on={metaLoading} w={110} h={10}>
              {totals?.cost_per_messaging != null
                ? `${fmtMoney(totals.cost_per_messaging, currency)} cada`
                : 'sem custo por conversa'}
            </SkelValue>
          </div>
        </div>

        {/* O que a Meta conseguiu atribuir sozinha, dos eventos que a
            crm-worker mandou. Fica ao lado da receita do CRM, não no lugar
            dela: a diferença entre os dois é o que não deu para casar (venda
            sem clique capturado, fora da janela de atribuição, recompra). */}
        <div className="kpi-card kpi-pattern-topo">
          <div className="kpi-card-bg" aria-hidden="true" />
          <div className="kpi-card-top">
            <span className="kpi-icon kpi-icon-money"><CheckCircle2 size={16} /></span>
          </div>
          <div className="kpi-title">Compras que a Meta contou</div>
          <div className="kpi-value">
            <SkelValue on={metaLoading} w={80} h={26}>
              {totals ? fmtInt(totals.purchases) : '—'}
            </SkelValue>
          </div>
          <div className="kpi-desc">
            <SkelValue on={metaLoading} w={110} h={10}>
              {totals && totals.purchase_value > 0
                ? fmtMoney(totals.purchase_value, currency)
                : 'nenhuma compra atribuída'}
            </SkelValue>
          </div>
        </div>
      </div>

      {/* ---------- Por conta ----------
          Só faz sentido com mais de uma. Aqui cada linha é a conta como a
          Meta a reporta — os valores vêm direto dela, sem soma nenhuma, e é
          por isso que esta tabela continua de pé mesmo com moedas
          diferentes, quando o total em dinheiro não vale. */}
      {!metaLoading && contas.length > 1 && (
        <div className="card mb-16">
          <div className="card-title" style={{ marginBottom: 4 }}>
            <Wallet size={14} /> Por conta de anúncios — {label}
          </div>
          <div className="table-wrap" style={{ border: 'none', background: 'transparent' }}>
            <table>
              <thead>
                <tr>
                  <th>Conta</th>
                  <th style={{ textAlign: 'right' }}>Gasto</th>
                  <th style={{ textAlign: 'right' }}>Conversas</th>
                  <th style={{ textAlign: 'right' }}>Custo/conversa</th>
                  <th style={{ textAlign: 'right' }}>Cliques</th>
                  <th style={{ textAlign: 'right' }}>CTR</th>
                  <th style={{ textAlign: 'right' }}>CPM</th>
                </tr>
              </thead>
              <tbody>
                {contas.map((c) => (
                  <tr key={c.id}>
                    <td style={{ maxWidth: 220 }}>
                      <div className="ads-account-cell">
                        <span>{c.label ?? c.name ?? c.id}</span>
                        {c.status != null && c.status !== 1 && (
                          <span className="badge badge-gray">inativa</span>
                        )}
                        {!c.ok && <span className="badge badge-red">sem resposta</span>}
                      </div>
                      {/* O erro fica na própria linha: procurar em outro lugar
                          qual das três falhou é o que torna isso irritante. */}
                      {!c.ok && c.error && (
                        <div className="text-muted" style={{ fontSize: 11, marginTop: 3 }}>
                          {c.error}
                        </div>
                      )}
                    </td>
                    {c.ok && c.totals ? (
                      <>
                        <td style={{ textAlign: 'right' }}>{fmtMoney(c.totals.spend, c.currency)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtInt(c.totals.messaging)}</td>
                        <td style={{ textAlign: 'right' }} className="text-muted">
                          {c.totals.cost_per_messaging == null
                            ? '—'
                            : fmtMoney(c.totals.cost_per_messaging, c.currency)}
                        </td>
                        <td style={{ textAlign: 'right' }}>{fmtInt(c.totals.clicks)}</td>
                        <td style={{ textAlign: 'right' }} className="text-muted">{fmtDec(c.totals.ctr)}%</td>
                        <td style={{ textAlign: 'right' }} className="text-muted">
                          {fmtMoney(c.totals.cpm, c.currency)}
                        </td>
                      </>
                    ) : (
                      <td colSpan={6} className="text-muted" style={{ textAlign: 'right' }}>—</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---------- Investimento x receita ---------- */}
      <div className="card mb-16">
        <div className="card-title" style={{ marginBottom: 4 }}>
          Gasto e receita por dia — {label}
        </div>
        <p className="text-muted" style={{ fontSize: 11.5, marginBottom: 18 }}>
          Barras = gasto na Meta · linha = vendas dos clientes de anúncio naquele dia
        </p>
        {/* O gráfico mistura os dois lados: a linha é receita do banco, as
            barras são gasto da Meta. Com o gasto ainda vindo, desenhar só a
            linha daria a impressão de um dia sem investimento. */}
        {metaLoading ? <SkelChart /> : !temGrafico ? (
          <EmptyState icon={<Megaphone />} text="Nenhum gasto ou venda de anúncio no período." />
        ) : (
          <div style={{ width: '100%', height: 280 }}>
            <ResponsiveContainer>
              <ComposedChart data={chartDays} margin={{ top: 5, right: 5, bottom: 0, left: -20 }}>
                <defs>
                  <linearGradient id="crmAdsSpend" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.8} />
                    <stop offset="100%" stopColor="#38bdf8" stopOpacity={0.25} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="label" stroke="#52525b" fontSize={11} tickLine={false} axisLine={false} />
                {/* Dois eixos: em campanha saudável a receita é múltiplos do
                    gasto, e na mesma escala a barra de investimento vira um
                    fio no rodapé. A cor de cada eixo casa com a da série. */}
                <YAxis yAxisId="custo" stroke="#38bdf8" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis yAxisId="receita" orientation="right" stroke="#1f7aeb" fontSize={11} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelStyle={tooltipLabel}
                  formatter={(v, name) => (
                    name === 'Gasto'
                      ? fmtMoney(Number(v), currency)
                      : formatBRL(Math.round(Number(v) * 100))
                  )}
                />
                <Legend wrapperStyle={{ fontSize: 11.5 }} />
                <Bar yAxisId="custo" dataKey="investimento" name="Gasto" fill="url(#crmAdsSpend)" radius={[3, 3, 0, 0]} />
                <Line
                  yAxisId="receita"
                  type="monotone"
                  dataKey="receita"
                  name="Receita"
                  stroke="#1f7aeb"
                  strokeWidth={2}
                  dot={chartDays.length === 1 ? { r: 4 } : false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* ---------- Por campanha ----------
          Fechado por padrão, como o de anúncios: é detalhe para quando se vai
          procurar uma campanha, não a leitura de todo dia. Com a Meta ainda
          respondendo, o cabeçalho já aparece — só o corpo espera. */}
      {(metaLoading || campanhas.length > 0) && (
        <CollapsibleCard
          open={verCampanhas}
          onOpenChange={setVerCampanhas}
          icon={<Megaphone size={14} />}
          title={`Por campanha — ${label}`}
          hint={metaLoading ? undefined : `${fmtInt(campanhas.length)} campanha(s)`}
          // Quantas campanhas entraram na conta. A tabela sempre soube — a
          // resposta exigia contar linha, e com 20 e poucas campanhas
          // ninguém conta. Só quem veiculou na janela aparece aqui: campanha
          // parada no período não some por exclusão, some por não existir
          // linha dela na Meta, e confundir as duas leva a procurar defeito
          // no relatório.
          subtitle={metaLoading ? undefined : (
            <>
              <strong>{campanhas.length}</strong>{' '}
              {campanhas.length === 1 ? 'campanha veiculou' : 'campanhas veicularam'}{' '}
              no período e {campanhas.length === 1 ? 'entra' : 'entram'} nos totais
              {ignoradasNoPeriodo > 0 && `, e mais ${ignoradasNoPeriodo} que estão fora do relatório`}.
              {isAdmin && ' Campanha que não gera lead no CRM pode sair do relatório pelo ícone à direita.'}
            </>
          )}
        >
          {metaLoading ? <SkelRows rows={6} cols={5} /> : (
            <div className="table-wrap" style={{ border: 'none', background: 'transparent' }}>
              <table>
                <thead>
                  <tr>
                    <th>Campanha</th>
                    {contasOk.length > 1 && <th>Conta</th>}
                    <th style={{ textAlign: 'right' }}>Gasto</th>
                    <th style={{ textAlign: 'right' }}>Conversas</th>
                    <th style={{ textAlign: 'right' }}>Custo/conversa</th>
                    <th style={{ textAlign: 'right' }}>Cliques</th>
                    <th style={{ textAlign: 'right' }}>CTR</th>
                    <th style={{ textAlign: 'right' }}>CPM</th>
                    <th style={{ textAlign: 'right' }}>Compras</th>
                    <th style={{ textAlign: 'right' }}>ROAS</th>
                    {isAdmin && <th />}
                  </tr>
                </thead>
                <tbody>
                  {campanhas.map((c) => (
                    <tr key={`${c.account_id ?? ''}-${c.campaign_id ?? c.campaign_name}`}>
                      <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {c.campaign_name ?? '—'}
                      </td>
                      {contasOk.length > 1 && (
                        <td className="text-muted" style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                          {c.account_label ?? c.account_id ?? '—'}
                        </td>
                      )}
                      <td style={{ textAlign: 'right' }}>{fmtMoney(c.spend, moedaDaLinha(c, contas, currency))}</td>
                      <td style={{ textAlign: 'right' }}>{fmtInt(c.messaging)}</td>
                      <td style={{ textAlign: 'right' }} className="text-muted">
                        {c.cost_per_messaging == null
                          ? '—'
                          : fmtMoney(c.cost_per_messaging, moedaDaLinha(c, contas, currency))}
                      </td>
                      <td style={{ textAlign: 'right' }}>{fmtInt(c.clicks)}</td>
                      <td style={{ textAlign: 'right' }} className="text-muted">{fmtDec(c.ctr)}%</td>
                      <td style={{ textAlign: 'right' }} className="text-muted">
                        {fmtMoney(c.cpm, moedaDaLinha(c, contas, currency))}
                      </td>
                      <td style={{ textAlign: 'right' }}>{fmtInt(c.purchases)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {c.spend > 0 && c.purchase_value > 0 ? fmtRatio(c.purchase_value / c.spend) : '—'}
                      </td>
                      {isAdmin && (
                        <td style={{ textAlign: 'right' }}>
                          <button
                            className="icon-btn"
                            onClick={() => ignorarCampanha(c)}
                            aria-label="Tirar do relatório"
                            title="Tirar do relatório — só para campanha que não gera lead"
                          >
                            <EyeOff size={14} />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CollapsibleCard>
      )}

      {/* ---------- Por anúncio ---------- */}
      {(metaLoading || anuncios.length > 0) && (
        <CollapsibleCard
          open={verAnuncios}
          onOpenChange={setVerAnuncios}
          icon={<Layers size={14} />}
          title={`Por anúncio — ${label}`}
          hint={metaLoading ? undefined : `${fmtInt(anuncios.length)} anúncio(s)`}
        >
          {metaLoading ? <SkelRows rows={6} cols={4} /> : (
            <>
              <div className="table-wrap" style={{ border: 'none', background: 'transparent' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Anúncio</th>
                      <th>Campanha</th>
                      {contasOk.length > 1 && <th>Conta</th>}
                      <th style={{ textAlign: 'right' }}>Gasto</th>
                      <th style={{ textAlign: 'right' }}>Conversas</th>
                      <th style={{ textAlign: 'right' }}>Custo/conversa</th>
                      <th style={{ textAlign: 'right' }}>CTR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {anuncios.slice(0, adsLimit).map((a) => (
                      <tr key={`${a.account_id ?? ''}-${a.ad_id ?? a.ad_name}`}>
                        <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {a.ad_name ?? '—'}
                        </td>
                        <td className="text-muted" style={{ maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                          {a.campaign_name ?? '—'}
                        </td>
                        {contasOk.length > 1 && (
                          <td className="text-muted" style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                            {a.account_label ?? a.account_id ?? '—'}
                          </td>
                        )}
                        <td style={{ textAlign: 'right' }}>{fmtMoney(a.spend, moedaDaLinha(a, contas, currency))}</td>
                        <td style={{ textAlign: 'right' }}>{fmtInt(a.messaging)}</td>
                        <td style={{ textAlign: 'right' }} className="text-muted">
                          {a.cost_per_messaging == null
                            ? '—'
                            : fmtMoney(a.cost_per_messaging, moedaDaLinha(a, contas, currency))}
                        </td>
                        <td style={{ textAlign: 'right' }} className="text-muted">{fmtDec(a.ctr)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {anuncios.length > adsLimit && (
                <div className="table-foot">
                  <span className="text-muted" style={{ fontSize: 12 }}>
                    Mostrando {adsLimit} de {anuncios.length}, do maior gasto para o menor
                  </span>
                  <button className="btn btn-ghost btn-sm" onClick={() => setAdsLimit((n) => n + ADS_PAGE)}>
                    <ChevronDown size={14} />
                    Mostrar mais {Math.min(ADS_PAGE, anuncios.length - adsLimit)}
                  </button>
                </div>
              )}
            </>
          )}
        </CollapsibleCard>
      )}

      {/* ---------- O que ficou fora do relatório ----------
          No rodapé e recolhido: é manutenção, não leitura do dia. Some da
          tela não pode — sem nenhuma pista, "R$ 12.000 investidos" vira
          R$ 9.000 de um dia para o outro e ninguém sabe se foi a exclusão ou
          a operação. Por isso a linha fechada já mostra quantas são e quanto
          gastaram; o detalhe (e o botão de desfazer) fica a um clique. */}
      {ignoradas.length > 0 && (
        <details className="ads-ignored">
          <summary>
            <Layers size={13} />
            <span>
              {ignoradas.length === 1
                ? '1 campanha fora do relatório'
                : `${ignoradas.length} campanhas fora do relatório`}
            </span>
            {/* A lista de ignoradas é do banco e fica; o quanto elas gastaram
                é da Meta. Na linha fechada o valor apenas some — um esqueleto
                dentro do <summary> chamaria mais atenção do que a manutenção
                merece. */}
            {!metaLoading && gastoIgnorado > 0 && (
              <span className="text-muted">· {fmtMoney(gastoIgnorado, currency)} no período</span>
            )}
          </summary>
          <div className="ads-ignored-list">
            {ignoradas.map((c) => {
              const noPeriodo = (meta?.excluded_campaigns ?? [])
                .find((e) => e.campaign_id === c.campaign_id)
              return (
                <div className="ads-ignored-row" key={c.id}>
                  <div className="ads-ignored-name">
                    <span>{c.campaign_name ?? c.campaign_id}</span>
                    {c.note && <span className="text-muted">{c.note}</span>}
                  </div>
                  {/* "sem veiculação no período" também é conclusão da
                      resposta da Meta: com a consulta no ar ela seria a do
                      período anterior, então as duas saídas viram esqueleto. */}
                  <span className="text-muted" style={{ fontSize: 12 }}>
                    <SkelValue on={metaLoading} w={72} h={11}>
                      {noPeriodo
                        ? fmtMoney(noPeriodo.spend, currency)
                        : 'sem veiculação no período'}
                    </SkelValue>
                  </span>
                  {isAdmin && (
                    <button className="btn btn-ghost btn-sm" onClick={() => voltarCampanha(c)}>
                      Voltar ao relatório
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </details>
      )}

    </>
  )
}

/**
 * Relatório de vendas. Diferente dos blocos acima em duas coisas, e as duas
 * estão escritas na tela para ninguém comparar números que não se comparam:
 *
 *  1. É FLUXO por data da venda: entra tudo o que foi vendido no período,
 *     inclusive de cliente que virou lead muito antes dele. O funil, acima,
 *     é coorte — só os leads criados no período. É proposital: um responde
 *     "quanto vendi", o outro "o que aconteceu com quem entrou agora".
 *  2. Soma 1ª venda E recompra. Os relatórios de conversão contam só a 1ª
 *     (a que virou evento na Meta), então o faturamento aqui é maior ou
 *     igual à "receita convertida" do topo — a diferença é recompra.
 */
function SalesReport({
  label, range, channel, overview, series, byContact, onOpenContact, onLaunchSale,
  prevRevenueCents, onRefundChanged,
}: {
  label: string
  /** As quebras do fim da aba consultam sozinhas — ver o comentário delas. */
  range: DateRange
  channel: string
  overview: CrmSalesOverview
  series: CrmSalesDayRow[]
  byContact: CrmSalesContactRow[]
  /** undefined = sem permissão de ver contato: a linha não convida ao clique. */
  onOpenContact?: (id: string) => void
  /**
   * Abre o lançamento rápido de venda. undefined = sem permissão de lançar,
   * e aí o botão não existe — quem só lê o relatório não vê uma porta que o
   * banco fecharia depois.
   */
  onLaunchSale?: () => void
  /** Faturamento da janela anterior, para o badge de variação. */
  prevRevenueCents: number | null
  /**
   * Recarrega o relatório depois de editar um reembolso pelo card (103) —
   * o valor devolvido mexe no líquido. undefined = sem permissão de editar
   * venda, e o card não oferece a edição.
   */
  onRefundChanged?: () => void | Promise<void>
}) {
  /**
   * As duas quebras do fim da aba carregam aqui, e não junto do resto do
   * relatório, por um motivo prático: a RPC delas é nova (076). Enquanto a
   * migration não estiver aplicada, uma falha no Promise.all do pai levaria
   * a página inteira; aqui ela fica dentro do próprio card.
   */
  const [porOrigem, setPorOrigem] = useState<CrmSalesBreakdownRow[] | null>(null)
  const [porCanal, setPorCanal] = useState<CrmSalesBreakdownRow[] | null>(null)
  const [erroQuebras, setErroQuebras] = useState<string | null>(null)
  /**
   * Reembolsos do período, pela data do REEMBOLSO (101). Carrega à parte pelo
   * mesmo motivo das quebras: sem a migration aplicada, o erro fica no card.
   */
  const [reembolsos, setReembolsos] =
    useState<{ rows: CrmRefundRow[]; total: number; cents: number; erro?: string } | null>(null)
  const [reembolsosAbertos, setReembolsosAbertos] = useState(false)
  /** Reembolso clicado na lista: abre o card com nota e anexos (103). */
  const [reembolsoAberto, setReembolsoAberto] = useState<string | null>(null)
  /** Reembolso aberto para edição a partir do card. */
  const [reembolsoEditando, setReembolsoEditando] = useState<RefundTarget | null>(null)
  const { from, to } = range

  // `overview` nas dependências: muda a cada refresh do pai — inclusive o que
  // vem depois de marcar um reembolso no drawer — e o card acompanha.
  useEffect(() => {
    let cancelado = false
    crmService.reportRefunds({ from, to }, channel, 200)
      .then((r) => { if (!cancelado) setReembolsos(r) })
      .catch((err) => {
        if (cancelado) return
        setReembolsos({
          rows: [], total: 0, cents: 0,
          erro: err instanceof Error ? err.message : 'falha desconhecida',
        })
      })
    return () => { cancelado = true }
  }, [from, to, channel, overview])

  useEffect(() => {
    let cancelado = false
    setPorOrigem(null)
    setPorCanal(null)
    setErroQuebras(null)
    Promise.all([
      crmService.reportSalesBreakdown({ from, to }, 'origem', channel),
      crmService.reportSalesBreakdown({ from, to }, 'canal', channel),
    ])
      .then(([o, c]) => {
        if (cancelado) return
        setPorOrigem(o)
        setPorCanal(c)
      })
      .catch((err) => {
        if (cancelado) return
        setPorOrigem([])
        setPorCanal([])
        setErroQuebras(err instanceof Error ? err.message : 'falha desconhecida')
      })
    return () => { cancelado = true }
  }, [from, to, channel])

  const revenueSeries = series.map((r) => r.revenue_cents)
  const chartDays = series.map((r) => ({
    label: r.day.slice(8, 10) + '/' + r.day.slice(5, 7),
    // Recharts em reais: o eixo em centavos viraria uma parede de zeros.
    revenue: r.revenue_cents / 100,
    sales: r.sales,
  }))
  return (
    <>
      <div className="page-header">
        <div>
          <h2 style={{ fontSize: 17 }}>Vendas</h2>
          <p>
            Faturamento por data da venda — 1ª venda e recompras, independente
            de quando o lead entrou · {label}
          </p>
        </div>
        {/* Mesmo botão da tela inicial: quem está olhando o faturamento é
            quem acabou de vender, e a venda entra sem sair do relatório. */}
        <div className="flex" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {onLaunchSale && (
            <button className="btn btn-primary btn-sm" onClick={onLaunchSale}>
              <Receipt size={15} /> Lançar venda
            </button>
          )}
        </div>
      </div>

      {overview.total_sales === 0 ? (
        <div className="card">
          <EmptyState
            icon={<Receipt />}
            text={onLaunchSale
              ? 'Nenhuma venda registrada ainda.'
              : 'Nenhuma venda registrada ainda. Lance as vendas no painel do contato.'}
          />
          {onLaunchSale && (
            <div style={{ textAlign: 'center' }}>
              <button className="btn btn-primary" onClick={onLaunchSale}>
                <Receipt size={15} /> Lançar a primeira venda
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="crm-kpis">
            <div className="kpi-card kpi-pattern-bars">
              <div className="kpi-card-top">
                <span className="kpi-icon kpi-icon-money"><ShoppingBag size={16} /></span>
                <GrowthBadge
                  pct={growthVsPrev(overview.revenue_cents, prevRevenueCents)}
                  anterior={prevRevenueCents == null ? undefined : formatBRL(prevRevenueCents)}
                />
              </div>
              <div className="kpi-title">Total vendido</div>
              <div className="kpi-value kpi-value-money">{formatBRL(overview.revenue_cents)}</div>
              {/* Líquido = bruto pela data da venda − reembolsos feitos no
                  período, mesmo de venda de outro período: é o caixa. */}
              {reembolsos && !reembolsos.erro && reembolsos.cents > 0 && (
                <div
                  className="kpi-desc"
                  title={'Total vendido no período menos o que foi reembolsado no período '
                    + '(pela data do reembolso, mesmo que a venda seja de outro período).'}
                >
                  Líquido <strong style={{ color: 'var(--text)' }}>
                    {formatBRL(overview.revenue_cents - reembolsos.cents)}
                  </strong>
                  {' · '}−{formatBRL(reembolsos.cents)} reembolsado
                </div>
              )}
              <MiniBars values={revenueSeries} />
            </div>

            <div className="kpi-card kpi-pattern-grid">
              <div className="kpi-card-bg" aria-hidden="true" />
              <div className="kpi-card-top">
                <span className="kpi-icon"><Receipt size={16} /></span>
              </div>
              <div className="kpi-title">Vendas</div>
              <div className="kpi-value">{overview.sales.toLocaleString('pt-BR')}</div>
              <div className="kpi-desc">
                {overview.first_sales.toLocaleString('pt-BR')} 1ª venda
                {' · '}
                {overview.repeat_sales.toLocaleString('pt-BR')} recompra
                {' · '}
                {overview.clients.toLocaleString('pt-BR')} cliente(s)
              </div>
            </div>

            <div className="kpi-card kpi-pattern-blur">
              <div className="kpi-card-bg" aria-hidden="true" />
              <div className="kpi-card-top">
                <span className="kpi-icon kpi-icon-money"><DollarSign size={16} /></span>
              </div>
              <div className="kpi-title">Ticket médio</div>
              <div className="kpi-value kpi-value-money">{formatBRL(overview.avg_ticket_cents)}</div>
              <div className="kpi-desc">por venda — {label}</div>
            </div>

            {/* LTV divide por CLIENTE, o ticket médio divide por VENDA — a
                diferença entre os dois é exatamente a recompra. */}
            <div className="kpi-card kpi-pattern-blur">
              <div className="kpi-card-bg" aria-hidden="true" />
              <div className="kpi-card-top">
                <span className="kpi-icon kpi-icon-money"><Users size={16} /></span>
              </div>
              <div className="kpi-title">LTV médio</div>
              <div
                className="kpi-value kpi-value-money"
                title={'Receita ÷ clientes distintos DENTRO da janela. Quem comprou antes '
                  + 'dela entra só com o que gastou aqui, então este número sobe conforme '
                  + 'você amplia o período — para o LTV real do cliente, abra um '
                  + 'personalizado que cubra todo o histórico.'}
              >
                {formatBRL(overview.ltv_cents)}
              </div>
              <div className="kpi-desc">
                por cliente em {overview.clients.toLocaleString('pt-BR')} cliente(s) — {label}
              </div>
            </div>

            <button
              type="button"
              className={`kpi-card kpi-pattern-grid kpi-card-click${reembolsosAbertos ? ' kpi-card-open' : ''}`}
              onClick={() => setReembolsosAbertos((v) => !v)}
              disabled={!reembolsos || (!reembolsos.erro && reembolsos.total === 0)}
              aria-expanded={reembolsosAbertos}
              title={reembolsosAbertos ? 'Fechar a lista' : 'Ver quem teve venda reembolsada'}
            >
              <div className="kpi-card-bg" aria-hidden="true" />
              <div className="kpi-card-top">
                <span className="kpi-icon"><RotateCcw size={16} /></span>
              </div>
              <div className="kpi-title">Reembolsado</div>
              <div
                className="kpi-value"
                style={{ color: reembolsos?.cents ? 'var(--danger)' : undefined }}
                title="Pela data do reembolso, mesmo que a venda seja de outro período."
              >
                {!reembolsos ? '…' : reembolsos.erro ? '—' : formatBRL(reembolsos.cents)}
              </div>
              <div className="kpi-desc">
                {!reembolsos
                  ? 'carregando'
                  : reembolsos.erro
                    ? 'não foi possível carregar · clique para ver'
                    : `${fmtInt(reembolsos.total)} reembolso(s)`
                      + (reembolsos.total > 0
                        ? reembolsosAbertos ? ' · clique para fechar' : ' · clique para ver'
                        : '')}
              </div>
            </button>

          </div>

          {reembolsosAbertos && reembolsos && (
            <div className="card mb-16">
              <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div>
                  <div className="card-title" style={{ marginBottom: 4 }}>
                    <RotateCcw size={14} /> Vendas reembolsadas — {label}
                  </div>
                  <p className="text-muted" style={{ fontSize: 11.5, marginBottom: 14 }}>
                    Pela data do reembolso · do mais recente para o mais antigo
                  </p>
                </div>
                <button className="btn btn-sm btn-ghost" onClick={() => setReembolsosAbertos(false)}>
                  Fechar
                </button>
              </div>
              {reembolsos.erro ? (
                <div className="journey-warn">
                  <TriangleAlert size={15} />
                  <div>
                    <strong>Não foi possível carregar os reembolsos.</strong>
                    <p>{reembolsos.erro}</p>
                  </div>
                </div>
              ) : reembolsos.rows.length === 0 ? (
                <EmptyState icon={<RotateCcw />} text="Nenhum reembolso no período." />
              ) : (
                <>
                  <div className="table-wrap" style={{ border: 'none', background: 'transparent' }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Cliente</th>
                          <th>Canal</th>
                          <th>Venda</th>
                          <th>Reembolso</th>
                          <th style={{ textAlign: 'right' }}>Venda</th>
                          <th style={{ textAlign: 'right' }}>Reembolsado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reembolsos.rows.map((r) => (
                          <tr
                            key={r.sale_id}
                            className="row-clickable"
                            onClick={() => setReembolsoAberto(r.sale_id)}
                            title={`${r.refunded_by_name ? `Marcado por ${r.refunded_by_name} · ` : ''}ver notas e anexos`}
                          >
                            <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {r.name || r.phone || '—'}
                            </td>
                            <td className="text-muted">{r.channel ?? '—'}</td>
                            <td className="text-muted">{formatSP(r.sold_at)}</td>
                            <td>{formatSP(r.refunded_at)}</td>
                            <td className="text-muted" style={{ textAlign: 'right' }}>{formatBRL(r.value_cents)}</td>
                            <td style={{ textAlign: 'right' }}>
                              {formatBRL(r.refund_cents)}
                              {r.partial && <span className="text-muted" style={{ fontSize: 11 }}> · parcial</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {reembolsos.total > reembolsos.rows.length && (
                    <p className="text-muted" style={{ fontSize: 11.5, marginTop: 10 }}>
                      Mostrando {fmtInt(reembolsos.rows.length)} de {fmtInt(reembolsos.total)} —
                      escolha um período menor para ver o resto.
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {/* Fora da lista: desfazer o último reembolso esvazia a lista, e o
              formulário não pode sumir no meio. */}
          {reembolsoAberto && (
            <RefundDetailDialog
              saleId={reembolsoAberto}
              onClose={() => setReembolsoAberto(null)}
              onOpenContact={onOpenContact && ((id) => { setReembolsoAberto(null); onOpenContact(id) })}
              onEdit={onRefundChanged && ((d) => {
                setReembolsoAberto(null)
                setReembolsoEditando(refundTargetFromDetail(d))
              })}
            />
          )}
          {reembolsoEditando && onRefundChanged && (
            <RefundEditDialog
              sale={reembolsoEditando}
              // Fechou sem desfazer: volta para o card, já com o que mudou.
              onClose={(desfeito) => {
                const id = reembolsoEditando.id
                setReembolsoEditando(null)
                if (!desfeito) setReembolsoAberto(id)
              }}
              onSaved={onRefundChanged}
            />
          )}
          <div className="card mb-16">
            <div className="card-title" style={{ marginBottom: 18 }}>
              Faturamento por dia — {label}
            </div>
            {overview.sales === 0 ? (
              <EmptyState icon={<Receipt />} text="Nenhuma venda no período selecionado." />
            ) : (
              <div style={{ width: '100%', height: 240 }}>
                <ResponsiveContainer>
                  <AreaChart data={chartDays} margin={{ top: 5, right: 5, bottom: 0, left: -20 }}>
                    <defs>
                      <linearGradient id="crmSalesFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#1f7aeb" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#1f7aeb" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="label" stroke="#52525b" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis stroke="#1f7aeb" fontSize={11} tickLine={false} axisLine={false} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      labelStyle={tooltipLabel}
                      // O gráfico está em reais; o tooltip mostra em BRL de
                      // volta para centavos, sem perder o formato do resto.
                      formatter={(v) => formatBRL(Math.round(Number(v) * 100))}
                    />
                    <Area
                      type="monotone"
                      dataKey="revenue"
                      name="Faturamento"
                      stroke="#1f7aeb"
                      strokeWidth={2}
                      fill="url(#crmSalesFill)"
                      // Ver nota no gráfico do funil: um dia só precisa do
                      // ponto marcado para aparecer.
                      dot={chartDays.length === 1 ? { r: 4 } : false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <CollapsibleCard
            icon={<Users size={14} />}
            title={`Vendas por cliente — ${label}`}
            hint={`${fmtInt(byContact.length)} cliente(s)`}
          >
            {byContact.length === 0 ? (
              <p className="text-muted" style={{ fontSize: 13 }}>Nenhuma venda no período selecionado.</p>
            ) : (
              <div className="table-wrap" style={{ border: 'none', background: 'transparent' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Cliente</th>
                      <th>Canal</th>
                      <th style={{ textAlign: 'right' }}>Vendas</th>
                      <th style={{ textAlign: 'right' }}>Total</th>
                      <th style={{ textAlign: 'right' }}>Última venda</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byContact.map((r) => (
                      <tr
                        key={r.contact_id}
                        className={onOpenContact ? 'row-clickable' : undefined}
                        onClick={onOpenContact && (() => onOpenContact(r.contact_id))}
                        title={onOpenContact ? 'Abrir contato para ver e editar as vendas' : undefined}
                      >
                        <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {r.name}
                        </td>
                        <td className="text-muted">{r.channel ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>{r.sales.toLocaleString('pt-BR')}</td>
                        <td style={{ textAlign: 'right' }}>{formatBRL(r.revenue_cents)}</td>
                        <td style={{ textAlign: 'right' }} className="text-muted">{formatSP(r.last_sale_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CollapsibleCard>

          {/* ---------- Quebras do faturamento ----------
              Depois da lista de clientes porque respondem a pergunta
              seguinte: sabendo quanto entrou, de onde veio. */}
          {erroQuebras ? (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="journey-warn" style={{ marginBottom: 0 }}>
                <TriangleAlert size={15} />
                <div>
                  <strong>Não foi possível carregar as quebras por origem e canal.</strong>
                  <p>{erroQuebras}</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid-2" style={{ marginTop: 16 }}>
              <SalesBreakdownCard
                title="Vendas por origem"
                colHead="Origem"
                icon={<Tag size={14} />}
                label={label}
                rows={porOrigem}
                semRotulo="Sem origem"
              />
              <SalesBreakdownCard
                title="Vendas por canal"
                colHead="Canal"
                icon={<WhatsAppIcon size={14} color="#3b82f6" />}
                label={label}
                rows={porCanal}
                semRotulo="Sem canal"
              />
            </div>
          )}
        </>
      )}
    </>
  )
}

/**
 * Uma das duas quebras do faturamento. Tabela própria, e não a BreakdownCard
 * do reportKit: aquela tem as colunas do Funil (leads, conversão, taxa), que
 * aqui não existem — a linha é uma soma de vendas, não uma coorte.
 *
 * `rows` null = ainda carregando. Vazio = período sem venda.
 */
function SalesBreakdownCard({ title, colHead, icon, label, rows, semRotulo }: {
  title: string
  colHead: string
  icon: ReactNode
  label: string
  rows: CrmSalesBreakdownRow[] | null
  /** Rótulo das vendas de contato sem o campo preenchido. */
  semRotulo: string
}) {
  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 4 }}>{icon} {title} — {label}</div>
      {!rows ? (
        <SkelRows rows={4} />
      ) : rows.length === 0 ? (
        <p className="text-muted" style={{ fontSize: 13 }}>Nenhuma venda no período selecionado.</p>
      ) : (
        <div className="table-wrap" style={{ border: 'none', background: 'transparent' }}>
          <table>
            <thead>
              <tr>
                <th>{colHead}</th>
                <th style={{ textAlign: 'right' }}>Vendas</th>
                <th style={{ textAlign: 'right' }}>Ticket</th>
                <th style={{ textAlign: 'right' }}>Receita</th>
                <th style={{ textAlign: 'right' }}>Fatia</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label ?? '__sem__'}>
                  <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.label ?? <span className="text-muted">{semRotulo}</span>}
                  </td>
                  <td
                    style={{ textAlign: 'right' }}
                    title={`${fmtInt(r.first_sales)} 1ª venda · ${fmtInt(r.repeat_sales)} recompra`
                      + ` · ${fmtInt(r.clients)} cliente(s)`}
                  >
                    {fmtInt(r.sales)}
                  </td>
                  <td style={{ textAlign: 'right' }}>{formatBRL(r.avg_ticket_cents)}</td>
                  <td style={{ textAlign: 'right' }}>{formatBRL(r.revenue_cents)}</td>
                  <td style={{ textAlign: 'right', minWidth: 96 }}>
                    <div className="rate-cell">
                      <div className="rate-bar">
                        <span style={{ width: `${Math.min(100, r.share ?? 0)}%` }} />
                      </div>
                      <span className="rate-num">{fmtPct(r.share)}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** Tabela de conversão por grupo, com barra proporcional à taxa. */
