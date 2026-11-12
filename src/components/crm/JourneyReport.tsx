import { useEffect, useState } from 'react'
import {
  CircleAlert, Clock, CreditCard, Droplets, Headset,
  Repeat, Tag, Target, TrendingDown,
} from 'lucide-react'
import { CollapsibleCard, ScopeTag, fmtDec, fmtInt, fmtPct, formatDuration } from './reportKit'
import { FunilDePerdas, type PassoDoFunil } from './JourneyFunnel'
import { crmService } from '@/services/crmService'
import type { DateRange } from '@/services/crmService'
import {
  STAGE_LABEL, jornadaService, marcarPortfolio, summarize,
  type JourneyStage, type JourneyTagSummary, type LeadJourney,
} from '@/services/jornadaService'
import { Loader, EmptyState, Modal } from '@/components/ui'
import { toast } from '@/store/toastStore'
import type {
  CrmJourneyMessages,
  CrmJourneyOverview, CrmJourneyStageFlowRow,
  CrmJourneyTagContactRow,
} from '@/types'

/** Quantos leads a fila de recuperação mostra por bloco. */
const FILA_PAGE = 15

/**
 * Teto da lista que abre pelo card "Travados no pagamento". Bem maior que o
 * da fila porque aqui a tela é inteira e a pergunta é outra: a fila mostra
 * "por onde começar hoje", esta lista é "quem são todos eles".
 */
const PAGAMENTO_PAGE = 300

/**
 * Resultado de uma lista de contatos por etapa.
 *
 * `erro` existe porque antes o catch devolvia lista vazia: qualquer falha da
 * RPC (migration pendente, timeout, filtro) virava "Nenhum lead nesta etapa"
 * na tela, indistinguível de etapa realmente vazia — e com o botão dizendo
 * "(93)" ao lado. Agora a tela mostra o motivo.
 */
interface ListaDeEtapa {
  rows: CrmJourneyTagContactRow[]
  total: number
  erro: string | null
}

/** Mensagem legível de uma falha da RPC, sem engolir o motivo. */
function msgErro(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message)
  }
  return err instanceof Error ? err.message : 'falha desconhecida'
}

/**
 * As etapas que ganham botão na fila de recuperação, na ordem da jornada.
 *
 * 'orcamento' fica de fora: a automação não marca essa etiqueta na conversa
 * (nenhuma linha da tabela do bot tem 'orcamento' hoje), então o botão vivia
 * zerado e desabilitado. A etapa continua existindo na classificação — é o
 * degrau acima do portfólio na escada — só não vira fila de trabalho.
 */
const FILA_STAGES: JourneyStage[] = ['pagamento', 'portfolio', 'triagem', 'sem_etapa']

/**
 * Contagem por etapa já cruzada com o CRM — a única que sabe de canal
 * (vendedor) e de origem.
 *
 * A etiqueta mora no banco do bot e só conhece número e data: nela não há
 * vendedor nenhum. Quem sabe de quem é o lead é o contato do CRM, e o
 * cruzamento acontece na RPC. Por isso, com filtro ligado, a contagem vem
 * do `total` da própria RPC — o mesmo número que a lista mostra.
 *
 * A falha é POR ETAPA: `sem_etapa` costuma ter mil vezes mais números que
 * `pagamento`, e um cruzamento pesado que caiu lá não pode derrubar o número
 * do card. Etapa que falhou entra como null, volta a contar etiqueta pura e
 * a tela diz que aquele número está ignorando os filtros.
 */
interface ContagemFiltrada {
  counts: Partial<Record<JourneyStage, number | null>>
  /** Mensagem da primeira etapa que falhou, para a tela ter o que dizer. */
  erro: string | null
}

/**
 * Quantos leads a etapa tem NA TELA.
 *
 * Sem filtro, a etiqueta responde sozinha. Com canal ou origem escolhidos, a
 * resposta é a do cruzamento com o CRM — e leads sem cadastro aqui saem da
 * conta, porque um lead sem contato não tem vendedor a quem pertencer.
 *
 * null = ainda cruzando; a tela mostra '—' em vez de um número que vai mudar.
 */
function contaEtapa(
  stage: JourneyStage,
  summary: JourneyTagSummary | null,
  filtradas: ContagemFiltrada | null,
  filtrando: boolean,
): number | null {
  if (!summary) return null
  if (!filtrando) return summary.stageCounts[stage]
  if (!filtradas) return null
  return filtradas.counts[stage] ?? summary.stageCounts[stage]
}

/**
 * O número desta etapa está na tela sem os filtros aplicados: há filtro
 * ligado e o cruzamento com o CRM não respondeu por ela.
 */
function etapaSemFiltro(
  stage: JourneyStage,
  filtradas: ContagemFiltrada | null,
  filtrando: boolean,
): boolean {
  return filtrando && filtradas != null && filtradas.counts[stage] == null
}

/**
 * O texto do title de um degrau do funil.
 *
 * O degrau do portfólio não mostra "tempo até chegar": a RPC da 083 nasceu
 * lendo etiqueta, que não tinha data. A tabela da 091 tem (entered_at), mas
 * a RPC ainda não usa. O que ele mostra é outra coisa — quantos chegaram ali
 * sem passar pelo degrau anterior.
 */
function dicaDoDegrau(f: CrmJourneyStageFlowRow): string {
  // `source` continua 'etiqueta' porque é o nome que a RPC (083) dá ao degrau
  // que não é coluna do kanban. Desde a 091 o dado vem da tabela de portfólio.
  if (f.source === 'etiqueta') {
    const base = `${fmtInt(f.reached)} registrados no portfólio`
    return (f.from_tag ?? 0) > 0
      ? `${base} · ${fmtInt(f.from_tag ?? 0)} sem passar pelo degrau anterior`
      : base
  }
  return f.avg_hours_to_reach != null
    ? `${fmtInt(f.reached)} entraram nesta etapa · média de `
      + `${formatDuration(f.avg_hours_to_reach)} desde a entrada do lead`
    : 'nenhum lead passou por aqui no período'
}

interface CrmSide {
  overview: CrmJourneyOverview
  /** Métricas de conversa (061). null = a RPC ainda não existe no banco. */
  msgs: CrmJourneyMessages | null
}

interface TagSide {
  leads: LeadJourney[]
  summary: JourneyTagSummary
  truncated: boolean
  error: string | null
}

/**
 * Aba Jornada do Cliente.
 *
 * As outras abas respondem quanto entrou, quantos fecharam e se o cliente
 * volta. Esta responde a pergunta do meio: ONDE o lead trava entre a
 * primeira mensagem e o dinheiro.
 *
 * DUAS FONTES, E ELAS NÃO SÃO A MESMA COISA
 *
 *   CRM (este banco)      → etapas, responsáveis, vendas, histórico com
 *                           timestamp. É a visão do TIME.
 *   Etiquetas (outro      → triagem, orçamento, Rmkt, comprouN. É a visão da
 *   Supabase, do bot)       CONVERSA, e cobre leads que talvez nem estejam
 *                           cadastrados aqui.
 *
 * SÓ EXISTE UM FUNIL AQUI, E É O DO CRM
 *
 * A etiqueta da conversa é ATUALIZADA conforme o lead avança — ela diz onde
 * ele está, não por onde passou. Sem histórico não há degrau, taxa de queda
 * nem conversão por etapa: contar isso com etiqueta daria um funil em que
 * quem comprou nunca passou por triagem. O funil com histórico é o do CRM;
 * a etiqueta entra como fotografia do estado atual e como fila de trabalho.
 *
 * ATENDIMENTO SE MEDE PELA CONVERSA, NÃO POR QUEM ESCREVEU NO CRM
 *
 * O vendedor trabalha no WhatsApp; quem escreve no CRM é o n8n, pela service
 * role. Então changed_by/created_by ficam nulos mesmo quando houve gente do
 * outro lado — o rastro do vendedor é idêntico ao da IA agindo sozinha.
 * Por isso o card "Voltaram após remarketing" ancora em conversation_messages
 * (061): a fala do lead tem hora de verdade.
 *
 * O QUE CONTINUA SEM RESPOSTA
 *
 * QUEM respondeu. sender_type separa 'client' de 'agent' e nada mais, e IA e
 * vendedor mandam pelo mesmo número. Nenhum card afirma que foi humano —
 * afirmam que houve resposta. Separar exige o n8n gravar o autor.
 */
export function JourneyReport({ label, range, channel, origem, onOpenContact }: {
  label: string
  range: DateRange
  channel: string
  /** '' = todas as origens. */
  origem: string
  /** undefined = sem permissão de ver contato: a linha não convida ao clique. */
  onOpenContact?: (id: string) => void
}) {
  const [crm, setCrm] = useState<CrmSide | null>(null)
  const [tags, setTags] = useState<TagSide | null>(null)
  /**
   * Quem entrou no portfólio (tabela da 091), como phone_id. Uma leitura só:
   * o degrau do funil e a etapa das etiquetas usam a mesma lista. null =
   * lendo. `erro` preenchido = a tabela não respondeu, e o portfólio aparece
   * zerado com o motivo na tela, em vez de zero com cara de dado.
   */
  const [portfolio, setPortfolio] = useState<{ ids: string[]; erro: string | null } | null>(null)
  /**
   * O funil tem estado próprio porque, sozinho entre os agregados do CRM,
   * ele espera a lista do portfólio. Deixá-lo no Promise.all faria os outros
   * cards esperarem essa leitura; tirá-lo de lá faz só este card ter loader.
   */
  const [flow, setFlow] = useState<CrmJourneyStageFlowRow[] | null>(null)
  /**
   * Falha ao montar o funil. Separado da lista porque lista vazia e leitura
   * que caiu não são a mesma coisa: sem isto, um timeout apareceria como
   * "Nenhum lead entrou no funil no período" — erro com cara de dado.
   */
  const [flowErro, setFlowErro] = useState<string | null>(null)
  /** Jornada deitada ou escada. Lazy no useState: só lê o storage uma vez. */
  const [filaStage, setFilaStage] = useState<JourneyStage>('pagamento')
  const [fila, setFila] = useState<ListaDeEtapa | null>(null)
  // Lista que abre pelo card de pagamento pendente. null enquanto carrega.
  const [pagamentoAberto, setPagamentoAberto] = useState(false)
  const [pagamentoLista, setPagamentoLista] = useState<ListaDeEtapa | null>(null)
  // Contagem por etapa que respeita canal e origem. null = sem filtro ligado
  // (a etiqueta já responde) ou cruzamento em voo.
  const [filtradas, setFiltradas] = useState<ContagemFiltrada | null>(null)

  const { from, to } = range
  /** Algum filtro que a etiqueta não conhece está ligado. */
  const filtrando = channel !== '' || origem !== ''

  // Lado do CRM. Os dois agregados de uma vez porque a tela mostra os dois
  // juntos — dividir em requisições sequenciais só faria a aba piscar.
  useEffect(() => {
    let cancelado = false
    setCrm(null)
    Promise.all([
      crmService.reportJourneyOverview({ from, to }, channel, origem),
      // A de conversa (061) tolera falha: sem ela só o card de remarketing
      // fica sem número, e a aba inteira cair por isso seria pior.
      crmService.reportJourneyMessages({ from, to }, channel, origem).catch(() => null),
    ])
      .then(([overview, msgs]) => {
        if (!cancelado) setCrm({ overview, msgs })
      })
      .catch((err) => {
        if (!cancelado) {
          toast.error(err instanceof Error ? err.message : 'Falha ao carregar a jornada')
        }
      })
    return () => { cancelado = true }
  }, [from, to, channel, origem])

  /**
   * Quem entrou no portfólio, pela tabela (091). A etiqueta da conversa não
   * conta mais, em período nenhum.
   *
   * Só depende de `from`: a lista é "entrou desde o início do período", e
   * quem entra no período só pode chegar ao portfólio depois disso.
   */
  useEffect(() => {
    let cancelado = false
    setPortfolio(null)
    crmService.listPortfolioPhoneIds(from)
      .then((ids) => { if (!cancelado) setPortfolio({ ids, erro: null }) })
      .catch((err) => { if (!cancelado) setPortfolio({ ids: [], erro: msgErro(err) }) })
    return () => { cancelado = true }
  }, [from])

  /**
   * Lado das etiquetas: lê o outro Supabase, classifica aqui e manda a lista
   * classificada para o Postgres do CRM cruzar com os contatos.
   *
   * Espera a lista do portfólio: é ela que põe o lead na etapa 'portfolio'
   * (marcarPortfolio), e a fila de recuperação e as contagens por etapa
   * saem daqui.
   *
   * Falha aqui não derruba a aba — o lado do CRM continua de pé e a seção de
   * etiquetas explica o que aconteceu.
   */
  useEffect(() => {
    let cancelado = false
    setTags(null)
    setFila(null)
    if (!portfolio) return
    ;(async () => {
      const lidas = await jornadaService.listEtapas({ from, to })
      if (cancelado) return
      const leads = marcarPortfolio(lidas.leads, new Set(portfolio.ids))
      const summary = summarize(leads)
      // Não há mais cruzamento etiqueta × venda para carregar: a tabela que
      // usava reportJourneyTags saiu. O que ainda cruza com o CRM é a fila
      // de recuperação, no efeito abaixo, e ela pede só a etapa escolhida.
      if (!cancelado) setTags({ leads, summary, truncated: lidas.truncated, error: lidas.error })
    })()
    return () => { cancelado = true }
  }, [portfolio, from, to, channel])

  /**
   * O funil, que só pode ser pedido depois da lista do portfólio.
   *
   * O degrau do portfólio não é coluna do kanban: ele é montado no banco a
   * partir dos telefones que entraram no portfólio (083, e a tabela desde a
   * 091). Por isso a lista vai junto na chamada.
   *
   * Tabela que não respondeu devolve lista vazia, não trava: o funil aparece
   * com o degrau zerado, e o aviso diz por quê.
   */
  useEffect(() => {
    let cancelado = false
    setFlow(null)
    setFlowErro(null)
    // Lista ainda em voo. Zerar o funil aqui é o que evita o degrau do
    // período anterior ficar na tela enquanto o novo não chega.
    if (!portfolio) return
    crmService.reportJourneyStageFlow({ from, to }, channel, origem, portfolio.ids)
      .then((rows) => { if (!cancelado) setFlow(rows) })
      .catch((err) => { if (!cancelado) setFlowErro(msgErro(err)) })
    return () => { cancelado = true }
  }, [portfolio, from, to, channel, origem])

  /**
   * Recontagem das etapas com os filtros aplicados.
   *
   * Só roda com canal ou origem escolhidos: sem filtro o número da etiqueta
   * e o do cruzamento são o mesmo, e uma requisição por etapa seria paga à
   * toa. Uma chamada por etapa, com limite 1 — o que interessa é o `total`,
   * que a RPC calcula sobre a lista já filtrada.
   */
  useEffect(() => {
    if (!tags || !filtrando) { setFiltradas(null); return }
    let cancelado = false
    setFiltradas(null)
    const falhas: string[] = []
    Promise.all(FILA_STAGES.map(async (stage): Promise<readonly [JourneyStage, number | null]> => {
      const linhas = jornadaService.toRpcRows(tags.leads.filter((l) => l.stage === stage))
      // Etapa vazia na etiqueta é zero em qualquer filtro: não vale um POST.
      if (linhas.length === 0) return [stage, 0]
      try {
        const r = await crmService.reportJourneyTagContacts({
          rows: linhas, stage, channel, origem, limit: 1,
        })
        return [stage, r.total]
      } catch (err) {
        // Uma etapa que caiu não leva as outras: cada botão responde por si.
        falhas.push(msgErro(err))
        return [stage, null]
      }
    })).then((pares) => {
      if (!cancelado) {
        setFiltradas({
          counts: Object.fromEntries(pares) as ContagemFiltrada['counts'],
          erro: falhas[0] ?? null,
        })
      }
    })
    return () => { cancelado = true }
  }, [tags, filtrando, channel, origem])

  // Fila de recuperação da etapa escolhida. Só faz sentido depois das
  // etiquetas: são elas que dizem quem está parado onde.
  useEffect(() => {
    if (!tags || tags.leads.length === 0) return
    let cancelado = false
    setFila(null)
    // Só as linhas da etapa pedida: a RPC descarta o resto na primeira CTE,
    // e mandar as 20 mil possíveis a cada troca de botão só engorda o POST.
    const linhas = jornadaService.toRpcRows(tags.leads.filter((l) => l.stage === filaStage))
    crmService.reportJourneyTagContacts({ rows: linhas, stage: filaStage, channel, origem, limit: FILA_PAGE })
      .then((r) => { if (!cancelado) setFila({ ...r, erro: null }) })
      .catch((err) => {
        if (!cancelado) setFila({ rows: [], total: 0, erro: msgErro(err) })
      })
    return () => { cancelado = true }
  }, [tags, filaStage, channel, origem])

  /**
   * Só busca quando a lista abre — o card mostra a contagem, que já vem das
   * etiquetas; carregar os 300 contatos junto com a aba seria pagar por uma
   * tela que quase nunca é aberta.
   */
  useEffect(() => {
    if (!pagamentoAberto || !tags || tags.leads.length === 0) return
    let cancelado = false
    setPagamentoLista(null)
    const linhas = jornadaService.toRpcRows(tags.leads.filter((l) => l.stage === 'pagamento'))
    crmService.reportJourneyTagContacts({ rows: linhas, stage: 'pagamento', channel, origem, limit: PAGAMENTO_PAGE })
      .then((r) => { if (!cancelado) setPagamentoLista({ ...r, erro: null }) })
      .catch((err) => {
        if (!cancelado) setPagamentoLista({ rows: [], total: 0, erro: msgErro(err) })
      })
    return () => { cancelado = true }
  }, [pagamentoAberto, tags, channel, origem])

  if (!crm) return <Loader />

  const { overview: o, msgs } = crm

  // O número do card de pagamento: com filtro ligado é o do cruzamento com o
  // CRM, o mesmo que a lista abre. null enquanto não há resposta.
  const pagamentoConta = contaEtapa('pagamento', tags?.summary ?? null, filtradas, filtrando)
  /** O cruzamento desta etapa falhou: o card caiu na contagem da etiqueta. */
  const contagemSemFiltro = etapaSemFiltro('pagamento', filtradas, filtrando)

  // Papéis de etapa que faltam. Sem eles algumas métricas não têm de onde
  // sair, e mostrar zero seria pior do que pedir a configuração.
  const papeisFaltando = [
    !o.has_triagem_stage && 'triagem',
    !o.has_budget_stage && 'orçamento',
    !o.has_loss_stage && 'perdido',
  ].filter(Boolean) as string[]

  // O degrau que perde mais gente no funil do CRM. Ordena por número
  // absoluto, não por taxa: 40% de 10 leads é ruído, 12% de 900 é dinheiro.
  const vazamentos = (flow ?? []).filter((f) => (f.dropped ?? 0) > 0)
  const maiorVazamento = vazamentos.length > 0
    ? vazamentos.reduce((a, b) => ((b.dropped ?? 0) > (a.dropped ?? 0) ? b : a))
    : null
  /**
   * A escala das barras.
   *
   * Era `flow[0].reached`, que valia enquanto a série fosse cumulativa: o
   * primeiro degrau era necessariamente o maior. Desde a 087 ela pode subir
   * no meio — quando o time pula uma coluna, o degrau seguinte fica maior
   * que o anterior —, e dividir por um denominador menor que o numerador
   * daria barra passando de 100% e porcentagem sem sentido.
   */
  const baseDoFunil = Math.max(0, ...(flow ?? []).map((f) => f.reached))
  // Os degraus prontos para o card. Sem selo no portfólio: ele é lido como
  // etapa do funil, e desde a 092 também tem os parados dele.
  const passos: PassoDoFunil[] = (flow ?? []).map((f) => ({
    // O degrau de etiqueta não tem id de etapa: ele não é etapa.
    key: f.stage_id ?? `fonte:${f.source}`,
    label: f.stage_name,
    hint: dicaDoDegrau(f),
    color: f.color,
    reached: f.reached,
    dropped: f.dropped,
    dropRate: f.drop_rate,
    offChain: f.source !== 'crm',
    // Por ord, não por stage_id: dois degraus sem id (hoje só um, mas o
    // padrão é esse) casariam null === null e ficariam ambos marcados como
    // o pior vazamento.
    worst: maiorVazamento?.ord === f.ord,
  }))


  return (
    <>
      <div className="page-header">
        <div>
          <h2 style={{ fontSize: 17 }}>Jornada do cliente</h2>
          <p>
            Da primeira mensagem ao pagamento: onde o lead avança, onde ele
            para e quanto tempo leva · {label}
          </p>
        </div>
      </div>

      {papeisFaltando.length > 0 && (
        <div className="journey-warn">
          <CircleAlert size={15} />
          <div>
            <strong>
              Falta marcar o papel de {papeisFaltando.length === 1 ? 'uma etapa' : `${papeisFaltando.length} etapas`}
              {' '}no funil: {papeisFaltando.join(', ')}.
            </strong>
            <p>
              Abra a etapa no funil, clique em Editar etapa e escolha o papel
              dela na jornada. Até lá, os números que dependem dessas etapas
              aparecem como “—”.
            </p>
          </div>
        </div>
      )}

      {/* ---------- KPIs ---------- */}
      <div className="crm-kpis">
        {/* Promovido de mini-card das etiquetas a KPI de topo: é a única
            fila do relatório em que o lead já pediu preço e só falta pagar —
            a mais barata de recuperar. Vem das etiquetas (outro banco), por
            isso fica FORA do bloco acima: falha na leitura das conversas não
            pode levar este card junto. */}
        {/* Único KPI clicável da aba: os outros são taxas, e uma taxa não
            tem "lista de quem". Este é uma fila de gente com nome e número —
            a pergunta seguinte é sempre "quem são eles". */}
        <button
          type="button"
          className="kpi-card kpi-pattern-blur kpi-card-click"
          onClick={() => setPagamentoAberto(true)}
          disabled={pagamentoConta == null || pagamentoConta === 0}
          title="Ver quem está parado no pagamento"
        >
          <div className="kpi-card-bg" aria-hidden="true" />
          <div className="kpi-card-top">
            <span className="kpi-icon"><CreditCard size={16} /></span>
            <ScopeTag kind="entrada" />
          </div>
          <div className="kpi-title">Travados no pagamento</div>
          <div
            className="kpi-value kpi-value-loss"
            title={'Leads com a etiqueta de pagamento pendente: receberam o orçamento e '
              + 'a cobrança, e ainda não compraram.\n\n'
              + 'Vem das etiquetas da conversa, não do funil do CRM — a etiqueta é '
              + 'substituída a cada avanço, então o número é a situação de agora.'
              + (filtrando
                ? '\n\nCom filtro de vendedor ou origem ligado, conta só quem tem '
                  + 'cadastro no CRM que bate com o filtro: quem só existe no WhatsApp '
                  + 'fica de fora, porque não há a quem pertencer.'
                : '')}
          >
            {pagamentoConta == null ? '—' : fmtInt(pagamentoConta)}
          </div>
          <div className="kpi-desc">
            {tags == null
              ? 'lendo as etiquetas das conversas…'
              : pagamentoConta == null
                ? 'cruzando com os contatos do CRM…'
                : tags.summary.total === 0
                  ? 'nenhuma conversa com etiqueta neste período'
                  : pagamentoConta === 0
                    ? (filtrando
                      ? 'ninguém parado no pagamento com os filtros aplicados'
                      : 'ninguém parado no pagamento neste período')
                    : contagemSemFiltro
                      ? 'não deu para cruzar com o CRM · este número ignora os filtros'
                      : 'receberam orçamento e não pagaram · clique para ver quem são'}
          </div>
        </button>

        {/* Não existe card de "a IA fechou sozinha": conversão sem toque
            humano registrado é lacuna de cadastro (automação, importação,
            venda lançada fora de sessão), não venda da IA — a IA entrega o
            lead, quem fecha é o time. A coluna ia_only_converted continua
            existindo na 060; simplesmente não é uma métrica de resultado. */}

        <div className="kpi-card kpi-pattern-topo">
          <div className="kpi-card-bg" aria-hidden="true" />
          <div className="kpi-card-top">
            <span className="kpi-icon"><Clock size={16} /></span>
            <ScopeTag kind="entrada" />
          </div>
          <div className="kpi-title">Orçamento → conversão</div>
          {/* Só a mediana: tempo até fechar tem cauda de fechamentos lentos, e
              a média puxada por eles não descreve o cliente típico. */}
          <div className="kpi-value" title="Mediana do tempo entre entrar em Orçamento e a venda">
            {formatDuration(o.median_hours_budget_to_conv)}
          </div>
          {/* Linha de baixo só quando não há número, para dizer por quê. */}
          {(!o.has_budget_stage || o.median_hours_budget_to_conv == null) && (
            <div className="kpi-desc">
              {!o.has_budget_stage
                ? 'marque a etapa de orçamento no funil'
                : 'nenhum orçamento fechou no período'}
            </div>
          )}
        </div>

        <div className="kpi-card kpi-pattern-grid">
          <div className="kpi-card-bg" aria-hidden="true" />
          <div className="kpi-card-top">
            <span className="kpi-icon kpi-icon-money"><Target size={16} /></span>
            <ScopeTag kind="entrada" />
          </div>
          <div className="kpi-title">Orçamento que virou venda</div>
          <div className="kpi-value kpi-value-money">{fmtPct(o.budget_conversion_rate)}</div>
          <div className="kpi-desc">
            {o.has_budget_stage
              ? `${fmtInt(o.budget_converted)} de ${fmtInt(o.budget_leads)} orçamentos`
              : 'depende da etapa de orçamento configurada'}
          </div>
        </div>

        {/* Veio do bloco "A conversa", que saiu: é o único número dele que
            virou card. Sai das mensagens (061), por isso depende de `msgs`. */}
        <div className="kpi-card kpi-pattern-radar">
          <div className="kpi-card-bg" aria-hidden="true" />
          <div className="kpi-card-top">
            <span className="kpi-icon"><Repeat size={16} /></span>
            <ScopeTag kind="entrada" />
          </div>
          <div className="kpi-title">Voltaram após remarketing</div>
          <div
            className="kpi-value"
            title="Leads que entraram na etapa de Remarketing e voltaram a escrever depois"
          >
            {msgs && msgs.has_rmkt_stage ? fmtPct(msgs.rmkt_reply_rate) : '—'}
          </div>
          {/* Sem o "de N": o denominador (quem entrou na coluna Remarketing)
              não é o mesmo grupo da trilha de disparos logo abaixo, e "5 de
              36" ao lado de "20 receberam" parecia erro. */}
          <div className="kpi-desc">
            {!msgs
              ? 'números da conversa indisponíveis'
              : !msgs.has_rmkt_stage
                ? 'marque a etapa de remarketing no funil'
                : `${fmtInt(msgs.rmkt_replied)} ${msgs.rmkt_replied === 1 ? 'voltou' : 'voltaram'} · `
                  + `${fmtInt(msgs.rmkt_converted)} ${msgs.rmkt_converted === 1 ? 'fechou' : 'fecharam'} depois`}
          </div>
        </div>
      </div>

      {/* ---------- Vazamento do funil (CRM) ---------- */}
      <div className="card mb-16">
        <div className="card-title" style={{ marginBottom: 4 }}>
          <Droplets size={14} /> Etapa de maior perda do funil — {label}
        </div>

        {/* O funil sai mesmo assim, com o degrau do portfólio zerado — o
            aviso é o que impede esse zero de ser lido como "ninguém
            recebeu o portfólio". */}
        {portfolio?.erro && (
          <div className="journey-warn">
            <CircleAlert size={15} />
            <div>
              <strong>Não deu para ler a tabela de portfólio: o degrau aparece zerado.</strong>
              <p>{portfolio.erro}</p>
            </div>
          </div>
        )}

        {flowErro ? (
          <div className="journey-warn">
            <CircleAlert size={15} />
            <div>
              <strong>Não foi possível montar o funil.</strong>
              <p>{flowErro}</p>
            </div>
          </div>
        ) : !flow ? (
          <Loader />
        ) : flow.length === 0 || flow.every((f) => f.reached === 0) ? (
          <EmptyState icon={<TrendingDown />} text="Nenhum lead entrou no funil no período." />
        ) : (
          <FunilDePerdas base={baseDoFunil} steps={passos} maior={maiorVazamento} />
        )}
      </div>


      {/* ---------- Etiquetas da conversa ---------- */}
      <TagSection
        label={label}
        data={tags}
        filtradas={filtradas}
        filtrando={filtrando}
        filaStage={filaStage}
        onFilaStage={setFilaStage}
        fila={fila}
        onOpenContact={onOpenContact}
      />

      {pagamentoAberto && (
        <Modal
          title="Travados no pagamento"
          onClose={() => setPagamentoAberto(false)}
          wide
        >
          <p className="text-muted" style={{ fontSize: 12.5, marginBottom: 16 }}>
            Leads com a etiqueta de pagamento pendente em {label}: receberam o
            orçamento e a cobrança e ainda não compraram — do parado há mais
            tempo para o mais recente
            {filtrando && (
              /* Card e lista contam a mesma coisa desde que a contagem passou
                 pelo cruzamento com o CRM. O que ainda merece ser dito é o que
                 o filtro deixa de fora: lead sem cadastro aqui não tem
                 vendedor, então não entra em canal nenhum. */
              <> · com filtro de vendedor ou origem, entra só quem tem cadastro
                no CRM que bate com o filtro</>
            )}
          </p>
          {!pagamentoLista ? (
            <Loader />
          ) : pagamentoLista.erro ? (
            <div className="journey-warn">
              <CircleAlert size={15} />
              <div>
                <strong>Não foi possível carregar a lista.</strong>
                <p>{pagamentoLista.erro}</p>
              </div>
            </div>
          ) : pagamentoLista.rows.length === 0 ? (
            <EmptyState
              icon={<CreditCard />}
              text={'Nenhum lead parado no pagamento'
                + (channel ? ' com o canal filtrado.' : '.')}
            />
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Lead</th>
                      <th>Número</th>
                      <th>Etapa no funil</th>
                      <th>Canal</th>
                      <th style={{ textAlign: 'right' }}>Parado há</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagamentoLista.rows.map((r) => (
                      <tr
                        key={r.numero}
                        className={r.contact_id && onOpenContact ? 'row-clickable' : undefined}
                        /* Fecha antes de abrir a ficha: os dois são portal de
                           tela cheia, e o drawer atrás do modal ficaria
                           invisível. */
                        onClick={r.contact_id && onOpenContact
                          ? () => { setPagamentoAberto(false); onOpenContact(r.contact_id as string) }
                          : undefined}
                      >
                        <td>
                          {r.name ?? (
                            <span className="text-muted" title="Tem conversa no WhatsApp, mas não está cadastrado aqui">
                              sem cadastro
                            </span>
                          )}
                          {r.converted && <span className="journey-chip">já comprou</span>}
                        </td>
                        <td className="mono">{r.numero}</td>
                        <td>{r.stage_name ?? '—'}</td>
                        <td>{r.channel ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>
                          {r.days_idle == null ? '—' : `${fmtDec(r.days_idle, 0)} d`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-muted" style={{ fontSize: 11.5, marginTop: 12 }}>
                {pagamentoLista.total > pagamentoLista.rows.length
                  ? `Mostrando ${fmtInt(pagamentoLista.rows.length)} de ${fmtInt(pagamentoLista.total)} — escolha um período menor para ver o resto.`
                  : `${fmtInt(pagamentoLista.rows.length)} leads nesta lista.`}
              </p>
            </>
          )}
        </Modal>
      )}

      {/* Aqui ficavam três tabelas — vendedor, motivos de perda e conversão
          por origem. Saíram todas: a jornada responde por onde o lead passa e
          quanto tempo leva, e quebra por pessoa ou por rótulo é pergunta da
          aba Funil, que já tem as mesmas linhas. */}
    </>
  )
}

/**
 * Seção das etiquetas da conversa.
 *
 * Fica em componente próprio porque tem três estados que nada têm a ver com
 * o resto da aba: carregando, sem leitura (a tabela do bot é de outro
 * projeto e pode estar sem policy para a chave anon) e com dado.
 */
/**
 * A trilha de remarketing, disparo a disparo.
 *
 * TABELA, E NÃO MAIS UMA ESCADA
 *
 * A régua tem nove disparos hoje — passando de meia dúzia de degraus, uma
 * escada vira parede de barra e a tabela lê melhor. E aqui há DUAS
 * perguntas, não uma: quantos receberam cada disparo (a etiqueta se acumula,
 * então isso é acumulado) e quantos estão parados em cada um. As duas
 * cabem em duas colunas; numa escada, a segunda teria de virar legenda.
 *
 * "PARADO" NÃO É "DESISTIU" — E ISSO NÃO VAI PARA A TELA
 *
 * Quem entrou há poucos dias tem só o disparo do dia 1 porque o do dia 3
 * ainda não venceu; a etiqueta não guarda a data de cada envio, então esse
 * caso chega junto com o de quem saiu mesmo. É ressalva de quem mexe no
 * código, não de quem lê o relatório: fica aqui, não em parágrafo no card.
 *
 * NÃO CONHECE VENDEDOR NEM ORIGEM
 *
 * Vem inteira da etiqueta, que só sabe de número e data. Com filtro de canal
 * ou origem ligado na tela, estes números continuam sendo os do período
 * inteiro — o cruzamento com o CRM que a fila faz custaria uma consulta por
 * disparo, e são nove.
 */
function RmktTrackCard({ summary: s }: { summary: JourneyTagSummary }) {
  if (s.rmktLeads === 0 || s.rmktTrack.length === 0) return null

  // A barra é proporcional ao MAIOR disparo, não ao total da trilha: é a
  // comparação entre disparos que interessa, e ancorar no total achataria
  // todas elas por causa de quem entrou e ainda não recebeu nada.
  const teto = Math.max(...s.rmktTrack.map((d) => d.leads))
  // Onde mais gente está parada: o ponto em que a régua perde o lead.
  const maisParados = s.rmktTrack.reduce((a, b) => (b.parados > a.parados ? b : a))

  return (
    <CollapsibleCard
      icon={<Repeat size={14} />}
      title="Trilha de remarketing"
      hint={s.rmktSemDisparo > 0
        ? `${fmtInt(s.rmktLeads)} na trilha · ${fmtInt(s.rmktSemDisparo)} sem disparo`
        : `${fmtInt(s.rmktLeads)} na trilha`}
    >
      <div className="table-wrap" style={{ border: 'none', background: 'transparent' }}>
        <table>
          <thead>
            <tr>
              <th>Disparo</th>
              <th style={{ textAlign: 'right' }}>Receberam</th>
              <th style={{ width: '38%' }} />
              <th style={{ textAlign: 'right' }}>Parados aqui</th>
            </tr>
          </thead>
          <tbody>
            {s.rmktTrack.map((d) => (
              <tr key={d.dia}>
                <td style={{ whiteSpace: 'nowrap' }}>Dia {d.dia}</td>
                <td style={{ textAlign: 'right' }} className="mono">{fmtInt(d.leads)}</td>
                <td>
                  {/* A barra repete o número da célula ao lado de propósito:
                      é ela que deixa ver o tombo entre dois disparos sem
                      subtrair de cabeça. */}
                  <span className="rmkt-bar" title={`${fmtInt(d.leads)} receberam o disparo do dia ${d.dia}`}>
                    <span style={{ width: `${teto > 0 ? (d.leads / teto) * 100 : 0}%` }} />
                  </span>
                </td>
                <td style={{ textAlign: 'right' }} className="mono">
                  {/* O selo vem ANTES do número: depois dele, a coluna
                      alinhada à direita empurra o valor para dentro e ele
                      deixa de bater com os das outras linhas. */}
                  {d.dia === maisParados.dia && d.parados > 0 && (
                    <span className="journey-chip" style={{ marginLeft: 0, marginRight: 6 }}>
                      maior parada
                    </span>
                  )}
                  {fmtInt(d.parados)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CollapsibleCard>
  )
}

function TagSection({
  label, data, filtradas, filtrando, filaStage, onFilaStage, fila, onOpenContact,
}: {
  label: string
  data: TagSide | null
  /** Contagem por etapa já cruzada com o CRM. null = sem filtro ou em voo. */
  filtradas: ContagemFiltrada | null
  filtrando: boolean
  filaStage: JourneyStage
  onFilaStage: (s: JourneyStage) => void
  fila: ListaDeEtapa | null
  onOpenContact?: (id: string) => void
}) {
  if (!data) {
    return (
      <div className="card mb-16">
        <div className="card-title" style={{ marginBottom: 12 }}>
          <Headset size={14} /> Fila para recuperar
        </div>
        <Loader />
      </div>
    )
  }

  const { summary: s, truncated, error } = data
  // Mesma regra do card de pagamento: com filtro ligado o botão mostra o
  // número do cruzamento, que é o tamanho da lista logo abaixo dele.
  const conta = (e: JourneyStage) => contaEtapa(e, s, filtradas, filtrando)
  const contaFila = conta(filaStage)
  /** O botão da etapa aberta voltou a contar etiqueta pura. */
  const contagemSemFiltro = etapaSemFiltro(filaStage, filtradas, filtrando)

  // Sem nenhuma linha: pode ser período vazio ou leitura barrada. De fora do
  // outro projeto as duas coisas chegam iguais — a tela diz as duas
  // possibilidades em vez de escolher a errada.
  if (s.total === 0) {
    return (
      <div className="card mb-16">
        <div className="card-title" style={{ marginBottom: 12 }}>
          <Headset size={14} /> Fila para recuperar — {label}
        </div>
        <EmptyState
          icon={<Tag />}
          text={error
            ? 'Não foi possível ler as etiquetas das conversas.'
            : 'Nenhuma conversa com etiqueta neste período.'}
        />
      </div>
    )
  }

  return (
    <>
      {/* O card "Etiquetas da conversa" saiu daqui. Ele mostrava disparos de
          remarketing entregues e compras marcadas — dois números que a
          etiqueta responde mal (ela é substituída a cada avanço) e que o
          card de remarketing e a aba Vendas já respondem com hora e com
          dinheiro. O que as etiquetas ainda têm de único é dizer QUEM está
          parado onde, e isso é a fila abaixo. */}

      {/* ---------- Fila de recuperação ---------- */}
      <CollapsibleCard
        icon={<Headset size={14} />}
        title="Fila para recuperar"
        hint={contaFila == null
          ? STAGE_LABEL[filaStage].toLowerCase()
          : `${fmtInt(contaFila)} em ${STAGE_LABEL[filaStage].toLowerCase()}`}
      >
        {/* Os dois avisos vinham no card de etiquetas, que saiu. Continuam
            necessários: é a mesma leitura que alimenta as contagens dos
            botões abaixo. */}
        {error && (
          <div className="journey-warn" style={{ marginBottom: 14 }}>
            <CircleAlert size={15} />
            <div>
              <strong>Nem todas as etiquetas foram lidas.</strong>
              <p>As contagens abaixo podem estar incompletas.</p>
            </div>
          </div>
        )}
        {truncated && (
          <div className="journey-warn" style={{ marginBottom: 14 }}>
            <CircleAlert size={15} />
            <div>
              <strong>Amostra, não total.</strong>
              <p>
                O período tem mais conversas do que cabe nesta tela. As
                contagens falam de {fmtInt(s.total)} delas — para o total
                fechado, escolha um período menor.
              </p>
            </div>
          </div>
        )}

        <div className="journey-pills">
          {FILA_STAGES.map((e) => {
            const n = conta(e)
            return (
              <button
                key={e}
                className={`btn btn-sm ${filaStage === e ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => onFilaStage(e)}
                disabled={n === 0}
                title={n === 0
                  ? (filtrando
                    ? 'Nenhum lead nesta etapa com os filtros aplicados'
                    : 'Nenhum lead nesta etapa no período')
                  : undefined}
              >
                {/* Sem número enquanto cruza: '(93)' virando '(12)' meio
                    segundo depois é pior do que esperar pelo certo. */}
                {STAGE_LABEL[e]}{n == null ? '' : ` (${fmtInt(n)})`}
              </button>
            )
          })}
        </div>

        {!fila ? (
          <Loader />
        ) : fila.erro ? (
          /* Etapa com gente no botão e lista vazia era o pior estado
             possível: parecia dado, e era falha. */
          <div className="journey-warn" style={{ marginTop: 14 }}>
            <CircleAlert size={15} />
            <div>
              <strong>Não foi possível carregar quem está nesta etapa.</strong>
              <p>{fila.erro}</p>
            </div>
          </div>
        ) : fila.rows.length === 0 ? (
          <p className="text-muted" style={{ fontSize: 13, marginTop: 14 }}>
            Nenhum lead nesta etapa
            {filtrando && ' com os filtros de vendedor e origem aplicados'}.
            {/* Só sobra o que explicar quando o cruzamento caiu: aí o botão
                voltou a contar etiqueta, que não sabe de vendedor. */}
            {contagemSemFiltro && ' Não deu para cruzar com o CRM agora, então a'
              + ' contagem no botão está ignorando os filtros.'}
          </p>
        ) : (
          <>
            <div className="table-wrap" style={{ marginTop: 14, border: 'none', background: 'transparent' }}>
              <table>
                <thead>
                  <tr>
                    <th>Lead</th>
                    <th>Número</th>
                    <th>Etapa</th>
                    <th>Vendedor</th>
                    <th style={{ textAlign: 'right' }}>Parado há</th>
                  </tr>
                </thead>
                <tbody>
                  {fila.rows.map((r) => (
                    <tr
                      key={r.numero}
                      className={r.contact_id && onOpenContact ? 'row-clickable' : undefined}
                      onClick={r.contact_id && onOpenContact
                        ? () => onOpenContact(r.contact_id as string)
                        : undefined}
                    >
                      <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.name ?? (
                          <span className="text-muted" title="Tem conversa no WhatsApp, mas não está cadastrado aqui">
                            sem cadastro
                          </span>
                        )}
                        {r.converted && <span className="journey-chip">já comprou</span>}
                      </td>
                      <td className="mono">{r.numero}</td>
                      <td>{r.stage_name ?? '—'}</td>
                      <td>{r.channel ?? '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        {r.days_idle == null ? '—' : `${fmtDec(r.days_idle, 0)} d`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {fila.total > fila.rows.length && (
              <p className="text-muted" style={{ fontSize: 11.5, marginTop: 10 }}>
                Mostrando {fmtInt(fila.rows.length)} de {fmtInt(fila.total)} nesta etapa.
              </p>
            )}
          </>
        )}
      </CollapsibleCard>

      {/* ---------- Trilha de remarketing ---------- */}
      <RmktTrackCard summary={s} />
    </>
  )
}
