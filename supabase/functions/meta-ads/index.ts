/**
 * Edge Function: meta-ads
 *
 * Lê os insights das contas de anúncios na Marketing API da Meta e devolve
 * tudo mastigado para a aba "Meta ADS" do relatório: gasto, entrega,
 * cliques, conversas iniciadas, e a quebra por campanha e por anúncio.
 *
 * VÁRIAS CONTAS
 *
 * A org lista suas contas em crm_ad_accounts (migration 058) — a operação
 * usa três. Cada uma é consultada com o token dela (ou o da org, na
 * cascata de sempre) e o resultado vem nas duas formas: somado, para os
 * cards, e conta a conta, para a tabela de quebra. `mergeRows` explica por
 * que CTR/CPC/CPM são recalculados em vez de somados.
 *
 * UMA CONTA COM PROBLEMA NÃO DERRUBA O RELATÓRIO
 *
 * Token vencido numa das três é o caso comum, e antes ele zeraria a tela
 * inteira. Aqui cada conta tem seu próprio ok/error, o total é somado só
 * com as que responderam, e a tela diz qual ficou de fora — um total
 * incompleto anunciado é melhor do que uma tela vazia ou, pior, um total
 * silenciosamente menor.
 *
 * MOEDA
 *
 * Contas em moedas diferentes não somam. A função devolve `currency: null`
 * e `mixed_currency: true`; a tela esconde os valores em dinheiro do total
 * e mostra só a quebra por conta, cada uma na sua moeda.
 *
 * POR QUE NÃO CHAMAR A META DIRETO DO NAVEGADOR
 *
 * O token mora no banco e é secreto — o mesmo motivo pelo qual a tela nunca
 * vê o access token da Conversion API. Aqui ele é lido com service role,
 * usado no servidor e nunca sai na resposta.
 *
 * O QUE ESTA FUNÇÃO NÃO FAZ
 *
 * Não calcula ROI, CAC nem ticket médio. O custo vem daqui; a receita vem
 * do banco (crm_report_ads_*, migration 052). Quem divide um pelo outro é
 * a tela, com um número de cada lado — assim, quando um dos dois falta, o
 * card diz o que falta em vez de mostrar zero como se fosse resultado.
 *
 * ERRO ESPERADO VOLTA COM HTTP 200
 *
 * Conta não configurada, token sem ads_read, conta desativada: tudo isso
 * volta como { ok: false, error, hint } e HTTP 200, de propósito. São
 * situações que o usuário resolve na tela de configurações, e a mensagem
 * exata da Meta é o que resolve — enterrá-la num 500 genérico já custou
 * investigação demais neste projeto (ver formatMetaError na crm-worker).
 * Só falha de autenticação do PRÓPRIO painel devolve 401/403.
 *
 * Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  BREAKDOWN_LIMIT, META_API_VERSION, formatMetaError, hintFor,
  mergeActions, mergeDaily, mergeRows, normalizeAccount, shapeActions, shapeRow,
  timeRange,
  type AdsAction, type AdsRow, type MetaError, type MetaInsightRow,
} from './insights.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
}

const GRAPH = `https://graph.facebook.com/${META_API_VERSION}`

/**
 * RETRY — só para o que uma segunda tentativa resolve.
 *
 * Token expirado, conta inexistente e falta de ads_read não mudam por
 * insistência: repetir só acrescenta segundos a um erro que já está decidido.
 * O que muda é limite de requisição e tropeço do lado deles — e aí uma
 * espera curta costuma bastar.
 *
 * Isto não é o mesmo retry da crm-worker. Lá é fila em segundo plano, com
 * 5 tentativas ao longo de horas; aqui alguém está olhando a tela, então o
 * teto é baixo de propósito: no pior caso o relatório atrasa ~4s, não meia
 * dúzia de minutos.
 */
const RETRY_MAX = 2
const RETRY_BASE_MS = 900

/** Códigos com que a Meta diz "passou do limite". A família 80xxx é toda de
    throttling por conta/objeto; 4, 17, 32 e 613 são por app, usuário, página
    e chamada. 429 e 5xx são o tropeço genérico. */
function throttled(err: MetaError | undefined, status: number): boolean {
  if (status === 429 || status >= 500) return true
  const code = err?.code
  if (code == null) return false
  return code === 4 || code === 17 || code === 32 || code === 613
    || (code >= 80000 && code <= 80014)
}

/**
 * Minutos que a Meta diz faltar para a conta voltar a responder, lidos de
 * X-Business-Use-Case-Usage. Zero (ou cabeçalho ausente) = não há bloqueio
 * declarado, é só pressão momentânea.
 *
 * Existe para NÃO tentar de novo quando o bloqueio é longo: insistir de 1 em
 * 1 segundo contra uma parede de 20 minutos gasta o tempo do usuário e ainda
 * empurra o desbloqueio para mais longe. Melhor falhar dizendo quanto falta.
 */
function bloqueioEmMinutos(res: Response): number {
  const bruto = res.headers.get('x-business-use-case-usage')
    ?? res.headers.get('x-ad-account-usage')
  if (!bruto) return 0
  try {
    const parsed = JSON.parse(bruto) as Record<string, Array<{ estimated_time_to_regain_access?: number }>>
    let maior = 0
    for (const entradas of Object.values(parsed)) {
      for (const e of entradas ?? []) {
        maior = Math.max(maior, Number(e?.estimated_time_to_regain_access ?? 0))
      }
    }
    return maior
  } catch {
    // Cabeçalho em formato inesperado não pode derrubar a consulta: sem o
    // número, o retry normal decide.
    return 0
  }
}

const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Resposta {
  body: { data?: MetaInsightRow[]; paging?: { next?: string }; error?: MetaError } | null
}

/** Uma chamada ao Graph, com as tentativas que valem a pena. */
async function pedir(url: string): Promise<Resposta> {
  for (let tentativa = 0; ; tentativa++) {
    const res = await fetch(url)
    const body = await res.json().catch(() => null) as Resposta['body']
    if (res.ok) return { body }

    const err = body?.error
    const bloqueio = bloqueioEmMinutos(res)
    const podeRepetir = tentativa < RETRY_MAX && throttled(err, res.status) && bloqueio === 0

    if (!podeRepetir) {
      const e = new Error(formatMetaError(err, res.status)) as Error & { hint?: string | null }
      e.hint = bloqueio > 0
        ? `A Meta bloqueou esta conta por mais ~${bloqueio} min por excesso de `
          + 'requisições. Recarregue depois desse tempo; tentar antes só estende o bloqueio.'
        : hintFor(err)
      throw e
    }

    // Jitter: as seis chamadas de uma conta saem juntas e, sem ele, voltariam
    // juntas contra o mesmo limite — a rajada que causou o problema, de novo.
    await dorme(RETRY_BASE_MS * (tentativa + 1) * (1 + Math.random() * 0.4))
  }
}

async function graph<T>(path: string, params: Record<string, string>, token: string): Promise<T> {
  const qs = new URLSearchParams({ ...params, access_token: token })
  const { body } = await pedir(`${GRAPH}/${path}?${qs}`)
  return body as T
}

/**
 * Teto de páginas seguidas numa quebra. A Meta pagina por cursor e a série
 * diária por campanha multiplica linhas rápido (campanhas × dias): 90 dias
 * de uma conta com 20 campanhas passa de 1.800 linhas, muito além do
 * `limit`. Sem seguir o cursor, o relatório perderia campanha silenciosamente
 * — que é o pior jeito de errar um total.
 *
 * O teto existe para a função não ficar presa numa conta gigante; 12 páginas
 * de 200 cobrem 2.400 linhas, folgado para o caso real.
 */
const PAGE_CAP = 12

/** Como `graph`, mas seguindo `paging.next` até acabar (ou bater o teto). */
async function graphAll(
  path: string,
  params: Record<string, string>,
  token: string,
): Promise<MetaInsightRow[]> {
  const out: MetaInsightRow[] = []
  // O `next` da Meta já vem com access_token embutido — daí a URL completa
  // substituir os params a partir da segunda página.
  let url = `${GRAPH}/${path}?${new URLSearchParams({ ...params, access_token: token })}`

  for (let pagina = 0; pagina < PAGE_CAP && url; pagina++) {
    const { body } = await pedir(url)
    out.push(...(body?.data ?? []))
    url = body?.paging?.next ?? ''
  }

  return out
}

/**
 * Quantas contas são consultadas ao mesmo tempo.
 *
 * Cada conta dispara seis leituras em paralelo, e as de quebra ainda paginam.
 * Com três contas soltas de uma vez, uma abertura da aba vira uma rajada de
 * mais de vinte requisições contra o mesmo app — que é justamente o que
 * derruba o limite. Em lotes de dois, a rajada cai pela metade e o relatório
 * fica no máximo uma conta mais lento.
 */
const CONTAS_EM_PARALELO = 2

/** Executa em lotes, preservando a ordem da entrada. */
async function emLotes<T, R>(
  itens: T[],
  limite: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const saida: R[] = []
  for (let i = 0; i < itens.length; i += limite) {
    saida.push(...await Promise.all(itens.slice(i, i + limite).map(fn)))
  }
  return saida
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const INSIGHT_FIELDS = [
  'spend', 'impressions', 'reach', 'clicks', 'ctr', 'cpc', 'cpm', 'frequency',
  'actions', 'action_values', 'cost_per_action_type',
].join(',')

/** Uma conta configurada, já com o token resolvido pela cascata. */
interface Conta {
  id: string
  /** Rótulo local da org, quando existe. */
  label: string | null
  token: string
}

/** O que uma conta devolveu — inclusive quando devolveu erro. */
interface ContaResultado {
  id: string
  label: string | null
  ok: boolean
  error: string | null
  hint: string | null
  name: string | null
  currency: string | null
  timezone: string | null
  status: number | null
  totals: AdsRow | null
  previous: AdsRow | null
  daily: AdsRow[]
  campaigns: AdsRow[]
  ads: AdsRow[]
  actions: AdsAction[]
  /** O que ficou de fora por estar na lista de campanhas ignoradas. */
  excluded: AdsRow[]
}

/**
 * Todas as leituras de UMA conta. Erro daqui não sai da conta.
 *
 * DE ONDE VEM O TOTAL — e por que depende de haver campanha ignorada:
 *
 *   sem exclusão → `level=account`, o número que a Meta já fechou. É o que
 *                  bate dígito a dígito com o Gerenciador de Anúncios, e é
 *                  onde o usuário vai conferir.
 *   com exclusão → soma das campanhas que sobraram. Não há como pedir à
 *                  Meta "o total da conta menos estas duas campanhas".
 *
 * A troca tem preço, e ele está anotado na resposta (`reach_exact`): a soma
 * das campanhas pode divergir do total da conta por centavos (crédito e
 * ajuste aparecem só no nível da conta), e o ALCANCE deixa de ser exato,
 * porque quem viu duas campanhas conta duas vezes.
 */
async function lerConta(
  conta: Conta,
  range: string,
  prevRange: string | null,
  excluidas: Set<string>,
): Promise<ContaResultado> {
  const base: ContaResultado = {
    id: conta.id,
    label: conta.label,
    ok: false,
    error: null,
    hint: null,
    name: null,
    currency: null,
    timezone: null,
    status: null,
    totals: null,
    previous: null,
    daily: [],
    campaigns: [],
    ads: [],
    actions: [],
    excluded: [],
  }

  const temExclusao = excluidas.size > 0
  const vazio = Promise.resolve([] as MetaInsightRow[])

  try {
    // Em paralelo: são leituras independentes e a soma dos tempos em série
    // deixaria a aba lenta o bastante para parecer travada.
    const [info, campanhasRaw, anunciosRaw, totalRaw, diarioRaw, anteriorRaw] = await Promise.all([
      graph<{ name?: string; currency?: string; timezone_name?: string; account_status?: number }>(
        conta.id,
        { fields: 'name,currency,timezone_name,account_status' },
        conta.token,
      ),
      graphAll(
        `${conta.id}/insights`,
        {
          level: 'campaign',
          time_range: range,
          fields: `campaign_id,campaign_name,${INSIGHT_FIELDS}`,
          limit: String(BREAKDOWN_LIMIT),
        },
        conta.token,
      ),
      graphAll(
        `${conta.id}/insights`,
        {
          level: 'ad',
          time_range: range,
          // campaign_id junto: é por ele que o anúncio de uma campanha
          // ignorada sai da tabela. Pelo nome seria frágil — dois nomes
          // iguais em contas diferentes existem.
          fields: `ad_id,ad_name,adset_name,campaign_id,campaign_name,${INSIGHT_FIELDS}`,
          limit: String(BREAKDOWN_LIMIT),
        },
        conta.token,
      ),
      temExclusao ? vazio : graph<{ data: MetaInsightRow[] }>(
        `${conta.id}/insights`,
        { level: 'account', time_range: range, fields: INSIGHT_FIELDS },
        conta.token,
      ).then((r) => r.data),
      graphAll(
        `${conta.id}/insights`,
        temExclusao
          ? {
            level: 'campaign',
            time_range: range,
            time_increment: '1',
            fields: `campaign_id,spend,impressions,clicks,actions,action_values`,
            limit: String(BREAKDOWN_LIMIT),
          }
          : {
            level: 'account',
            time_range: range,
            time_increment: '1',
            fields: 'spend,impressions,clicks,actions,action_values',
          },
        conta.token,
      ),
      prevRange
        ? graphAll(
          `${conta.id}/insights`,
          temExclusao
            ? {
              level: 'campaign',
              time_range: prevRange,
              fields: `campaign_id,${INSIGHT_FIELDS}`,
              limit: String(BREAKDOWN_LIMIT),
            }
            : { level: 'account', time_range: prevRange, fields: INSIGHT_FIELDS },
          conta.token,
        )
        : vazio,
    ])

    // Rótulo local ganha do nome da Meta: com três contas parecidas, o nome
    // do Gerenciador não distingue nada.
    const tag = { id: conta.id, label: conta.label ?? info.name ?? conta.id }
    // Linha sem campaign_id (o nível de conta) nunca é excluída — ela É o
    // total, e o filtro só existe para o detalhe.
    const manter = (r: MetaInsightRow) => !r.campaign_id || !excluidas.has(r.campaign_id)

    const campanhas = campanhasRaw.filter(manter)
    const ignoradas = campanhasRaw.filter((r) => !manter(r))

    // Conta sem veiculação na janela devolve data: [] — não é erro, é zero.
    const anteriores = anteriorRaw.filter(manter)

    return {
      ...base,
      ok: true,
      name: info.name ?? null,
      currency: info.currency ?? null,
      timezone: info.timezone_name ?? null,
      // 1 = ativa. Qualquer outro valor explica sozinho um gasto zerado.
      status: info.account_status ?? null,
      totals: temExclusao
        ? mergeRows(campanhas.map((r) => shapeRow(r, tag)))
        : shapeRow(totalRaw[0] ?? {}, tag),
      previous: anteriores.length === 0
        ? null
        : temExclusao
        ? mergeRows(anteriores.map((r) => shapeRow(r, tag)))
        : shapeRow(anteriores[0], tag),
      daily: temExclusao
        ? mergeDaily(diarioRaw.filter(manter).map((r) => shapeRow(r, tag)))
        : diarioRaw.map((r) => shapeRow(r, tag)),
      campaigns: campanhas.map((r) => shapeRow(r, tag)),
      ads: anunciosRaw.filter(manter).map((r) => shapeRow(r, tag)),
      // A lista de "tudo que a Meta reportou" segue a mesma regra do total:
      // com exclusão ela é remontada das campanhas que sobraram, senão as
      // conversas da campanha de recrutamento continuariam contadas.
      actions: temExclusao
        ? mergeActions(campanhas.map((r) => shapeActions(r)))
        : shapeActions(totalRaw[0]),
      excluded: ignoradas.map((r) => shapeRow(r, tag)),
    }
  } catch (err) {
    const e = err as Error & { hint?: string | null }
    return {
      ...base,
      error: e?.message ?? 'Falha ao consultar a Meta',
      hint: e?.hint ?? null,
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  try {
    // ---------- Quem chamou ----------
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    )

    const { data: { user } } = await userClient.auth.getUser()
    if (!user) return json({ error: 'Não autenticado' }, 401)

    const { data: profile } = await userClient
      .from('users')
      .select('organization_id, is_active')
      .eq('id', user.id)
      .single()

    if (!profile?.is_active || !profile.organization_id) {
      return json({ error: 'Usuário sem acesso' }, 403)
    }

    // ---------- Janela ----------
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const from = String(body.from ?? '')
    const to = String(body.to ?? '')
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
      return json({ error: 'Informe from e to no formato YYYY-MM-DD' }, 400)
    }
    // Janela anterior, para os badges de variação. Opcional: no All-Time a
    // tela não manda, porque não existe período anterior a comparar.
    const prevFrom = String(body.prevFrom ?? '')
    const prevTo = String(body.prevTo ?? '')
    const wantsPrev = ISO_DATE.test(prevFrom) && ISO_DATE.test(prevTo)

    // Filtro de contas vindo do seletor da tela. Vazio ou ausente = todas.
    // Normalizado aqui porque o que chega é o que a tela recebeu de volta,
    // e não custa nada garantir a mesma forma canônica do banco.
    const pedidas = new Set(
      (Array.isArray(body.accounts) ? body.accounts : [])
        .map((a) => normalizeAccount(String(a)))
        .filter(Boolean),
    )

    // ---------- Credenciais da organização ----------
    // Service role: os tokens não passam pela RLS do usuário nem voltam na
    // resposta. É o mesmo desenho do admin-users.
    const svc = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const [{ data: settings }, { data: linhas }, { data: ignoradas }] = await Promise.all([
      svc
        .from('crm_settings')
        .select('meta_ad_account_id, meta_ads_token, meta_access_token')
        .eq('organization_id', profile.organization_id)
        .maybeSingle(),
      svc
        .from('crm_ad_accounts')
        .select('account_id, label, access_token, sort_order, created_at')
        .eq('organization_id', profile.organization_id)
        .order('sort_order')
        .order('created_at'),
      // Campanhas fora do relatório (059): recrutamento e afins, que gastam
      // na mesma conta e não geram lead no CRM.
      svc
        .from('crm_ad_excluded_campaigns')
        .select('campaign_id, campaign_name, account_id, note')
        .eq('organization_id', profile.organization_id),
    ])

    const excluidas = new Set<string>(
      (ignoradas ?? []).map((c) => String(c.campaign_id)).filter(Boolean),
    )

    // Cascata de token, do mais específico para o mais genérico. O token da
    // org é separado do da Conversion API de propósito — ver migration 052.
    const tokenOrg = settings?.meta_ads_token || settings?.meta_access_token || ''

    // Tabela vazia cai no campo antigo: cobre a janela entre a migration e
    // este deploy, e a org que nunca abriu a tela nova (migration 058).
    const configuradas: Conta[] = (linhas ?? []).length > 0
      ? (linhas ?? []).map((l) => ({
        id: normalizeAccount(l.account_id ?? ''),
        label: l.label ?? null,
        token: l.access_token || tokenOrg,
      }))
      : [{
        id: normalizeAccount(settings?.meta_ad_account_id ?? ''),
        label: null,
        token: tokenOrg,
      }]

    const validas = configuradas.filter((c) => c.id)

    if (validas.length === 0) {
      return json({
        ok: false,
        configured: false,
        error: 'Nenhuma conta de anúncios configurada.',
        hint: 'Cadastre as contas em Configurações › Integrações. '
          + 'É o número que aparece como act_XXXXXXXX no Gerenciador de Anúncios.',
      })
    }

    const semToken = validas.filter((c) => !c.token)
    if (semToken.length === validas.length) {
      return json({
        ok: false,
        configured: false,
        error: 'Nenhum token da Meta salvo.',
        hint: 'Salve um access token com permissão ads_read em Configurações › Integrações.',
      })
    }

    // Seleção da tela. Um id que não existe mais (conta removida enquanto a
    // aba estava aberta) não pode zerar o relatório: nesse caso vale o
    // conjunto inteiro, que é o padrão da tela de qualquer forma.
    const selecionadas = pedidas.size > 0
      ? validas.filter((c) => pedidas.has(c.id))
      : validas
    const alvo = selecionadas.length > 0 ? selecionadas : validas

    // ---------- Meta ----------
    const range = timeRange(from, to)
    const prevRange = wantsPrev ? timeRange(prevFrom, prevTo) : null
    const resultados = await emLotes(alvo, CONTAS_EM_PARALELO, (c) =>
      c.token
        ? lerConta(c, range, prevRange, excluidas)
        : Promise.resolve<ContaResultado>({
            id: c.id,
            label: c.label,
            ok: false,
            error: 'Sem token com ads_read para esta conta.',
            hint: 'Informe um token na conta ou salve um token de leitura da organização.',
            name: null,
            currency: null,
            timezone: null,
            status: null,
            totals: null,
            previous: null,
            daily: [],
            campaigns: [],
            ads: [],
            actions: [],
            excluded: [],
          }),
    )

    const okContas = resultados.filter((r) => r.ok)

    // Nenhuma respondeu: devolve o erro da primeira com a mesma forma de
    // antes, para a tela mostrar a mensagem da Meta inteira.
    if (okContas.length === 0) {
      return json({
        ok: false,
        configured: true,
        error: resultados[0]?.error ?? 'Falha ao consultar a Meta',
        hint: resultados[0]?.hint ?? null,
        accounts: resultados.map(resumoConta),
      })
    }

    // Moedas diferentes não somam — ver o cabeçalho.
    const moedas = [...new Set(okContas.map((r) => r.currency).filter(Boolean))]
    const mixedCurrency = moedas.length > 1
    const currency = mixedCurrency ? null : moedas[0] ?? null

    const totals = okContas.length === 1
      // Conta única: devolve a linha da Meta como ela veio. As razões
      // recalculadas dariam o mesmo, mas "o mesmo a menos de
      // arredondamento" — e é neste número que o usuário compara com o
      // Gerenciador.
      ? okContas[0].totals!
      : mergeRows(okContas.map((r) => r.totals!))

    const anteriores = okContas.map((r) => r.previous).filter((r): r is AdsRow => !!r)
    const previous = anteriores.length === 0
      ? null
      : anteriores.length === 1
      ? anteriores[0]
      : mergeRows(anteriores)

    return json({
      ok: true,
      configured: true,
      // Compat: a tela anterior a esta mudança lê `account` no singular.
      // Deploy da função acontece antes do deploy do front.
      account: {
        id: okContas[0].id,
        name: okContas[0].name,
        currency: okContas[0].currency,
        timezone: okContas[0].timezone,
        status: okContas[0].status,
      },
      accounts: resultados.map(resumoConta),
      currency,
      mixed_currency: mixedCurrency,
      /**
       * Com campanha ignorada o total vira soma de campanhas, e o alcance
       * some do rigor: quem viu duas campanhas conta duas vezes. A tela usa
       * isto para marcar o número em vez de apresentá-lo como exato.
       */
      reach_exact: excluidas.size === 0,
      // O que ficou de fora, com o gasto — a tela mostra em cima. Sem esse
      // número, "R$ 12.000 investidos" some para R$ 9.000 de um dia para o
      // outro e ninguém sabe se foi a exclusão ou a operação.
      excluded_campaigns: okContas
        .flatMap((r) => r.excluded)
        .map((r) => ({
          campaign_id: r.campaign_id,
          campaign_name: r.campaign_name,
          account_id: r.account_id,
          account_label: r.account_label,
          spend: r.spend,
        }))
        .sort((a, b) => b.spend - a.spend),
      // Campanha ignorada que não veiculou no período não aparece acima
      // (a Meta não devolve linha para ela), mas continua na configuração —
      // por isso o total vem da lista salva, não do que veio da Meta.
      excluded_total: excluidas.size,
      totals,
      previous,
      daily: mergeDaily(okContas.flatMap((r) => r.daily)),
      // Ordenadas pelo gasto: é assim que a operação lê as duas tabelas.
      // Com moedas diferentes a ordem mistura grandezas — a tela avisa, e
      // ordenar por outra coisa esconderia a campanha que mais gasta.
      campaigns: okContas.flatMap((r) => r.campaigns).sort((a, b) => b.spend - a.spend),
      ads: okContas.flatMap((r) => r.ads).sort((a, b) => b.spend - a.spend),
      actions: mergeActions(okContas.map((r) => r.actions)),
    })
  } catch (err) {
    // Erro inesperado (rede, banco). Erro DA META por conta já foi tratado
    // dentro de lerConta e não chega aqui.
    const e = err as Error & { hint?: string | null }
    return json({
      ok: false,
      configured: true,
      error: e?.message ?? 'Falha ao consultar a Meta',
      hint: e?.hint ?? null,
    })
  }
})

/** O que a tela precisa saber de cada conta, sem os arrays pesados. */
function resumoConta(r: ContaResultado) {
  return {
    id: r.id,
    label: r.label,
    name: r.name,
    currency: r.currency,
    timezone: r.timezone,
    status: r.status,
    ok: r.ok,
    error: r.error,
    hint: r.hint,
    totals: r.totals,
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
