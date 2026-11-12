/**
 * Edge Function: ads-campaigns
 *
 * De 2 em 2 horas, das 10h às 18h de Brasília, de segunda a sexta, manda
 * para o n8n o resumo do DIA CORRENTE das campanhas ativas: gasto, vendas,
 * ROI e o que fazer com cada uma. A mensagem já vai montada, pronta para o
 * n8n só repassar ao WhatsApp.
 *
 * Quem dispara é o pg_cron (migration 086), não a tela — a mesma divisão da
 * 043 e da 078: o cron sabe QUANDO, a função sabe COMO.
 *
 * NÃO É A ads-daily COM OUTRO HORÁRIO
 *
 * A 078/ads-daily fecha o dia ANTERIOR e responde "quanto gastamos", quebrado
 * por tipo de campanha. Esta responde "o que está dando dinheiro AGORA",
 * campanha a campanha, e por isso precisa de duas coisas que aquela não tem:
 * a receita (action_values de compra) e a leitura de vida inteira de cada
 * campanha. São relatórios diferentes, com públicos diferentes, e juntá-los
 * numa função só faria os dois piorarem.
 *
 * SÓ AS CONTAS ATIVAS
 *
 * `crm_ad_accounts.is_active` (migration 085) decide quem entra. Desligar uma
 * conta é um clique na tela de configurações, sem deploy — que era o pedido.
 * A aba Meta ADS continua somando TODAS as contas de propósito: mudar o
 * denominador daquele relatório por um toggle feito para outro fim seria o
 * jeito silencioso de inflar um ROI histórico.
 *
 * VENDAS SÃO AS DA META, NÃO AS DO CRM
 *
 * Conversão de compra = `action_values` do evento purchase, como pedido. Isso
 * casa com o Purchase que a crm-worker manda pela CAPI a cada venda (072), e
 * é o mesmo número que o Gerenciador mostra — então quando alguém abrir a
 * Meta para conferir, os dois batem. O ROI do CRM (crm_report_ads_*, 052) é
 * outro número, calculado de outro jeito, e não se mistura com este.
 *
 * O TOTAL É DE TODAS AS CAMPANHAS, A LISTA É SÓ DAS ATIVAS
 *
 * Campanha pausada ao meio-dia gastou de verdade. Tirá-la do total faria a
 * mensagem discordar do Gerenciador sem nada explicando a diferença — o erro
 * que a ads-daily evita com o balde "Outros". Aqui ela sai da LISTA (não há o
 * que decidir sobre campanha já pausada) mas continua no total, e o rodapé
 * declara quanto foi.
 *
 * Auth: header x-worker-secret, o mesmo do crm-worker e da ads-daily.
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WORKER_SECRET
 */

import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  META_API_VERSION,
  avaliar, classificarDono, hojeEmSP, horaEmSP, montarMensagem, ordenar, roi,
  type Avaliada, type Campanha,
} from './relatorio.ts'

/**
 * URL do fluxo no n8n. Fixa no código, como a da ads-daily (078) e a da venda
 * manual (068): é endereço de infraestrutura, não configuração de
 * organização. Mudou o fluxo do lado de lá? Muda aqui e republica.
 */
const N8N_URL =
  'https://n8n-n8n.40lgqg.easypanel.host/webhook/066c8477-db2c-4563-b0fd-52ee008bb337-relatorio-campanhas'

const GRAPH = `https://graph.facebook.com/${META_API_VERSION}`

/**
 * Teto de linhas por página. Sem `limit` explícito a Meta devolve 25, e a
 * conta com 30 campanhas mandaria um total menor sem erro nenhum — o pior
 * jeito de errar um número que alguém vai usar para decidir.
 */
const LIMITE = 200
/** Teto de páginas seguidas, para uma conta gigante não prender a função. */
const TETO_PAGINAS = 12

/**
 * Os nomes que a Meta dá ao evento de compra, em ordem de preferência: vence
 * o PRIMEIRO que existir na resposta, nunca a soma.
 *
 * A mesma lista da meta-ads/insights.ts, repetida aqui de propósito — cada
 * Edge Function é publicada sozinha e não enxerga o diretório da outra. Somar
 * os três contaria a mesma compra até três vezes e triplicaria o ROI.
 */
const COMPRA = [
  'purchase',
  'offsite_conversion.fb_pixel_purchase',
  'omni_purchase',
] as const

const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Uma chamada ao Graph, com retry.
 *
 * Mesma calibragem da ads-daily, e pelo mesmo motivo: ninguém está olhando a
 * tela esperando, então vale insistir com calma. Erro de token ou de conta
 * não melhora com insistência e sai na primeira tentativa.
 */
async function pedir(url: string): Promise<Record<string, unknown>> {
  for (let tentativa = 0; ; tentativa++) {
    const res = await fetch(url)
    const body = await res.json().catch(() => null) as Record<string, unknown> | null
    if (res.ok) return body ?? {}

    const erro = (body?.error ?? {}) as { message?: string; code?: number }
    const passageiro = res.status === 429 || res.status >= 500
      || erro.code === 4 || erro.code === 17 || erro.code === 32 || erro.code === 613
      || (typeof erro.code === 'number' && erro.code >= 80000 && erro.code <= 80014)

    if (!passageiro || tentativa >= 3) {
      throw new Error(erro.message ?? `Meta respondeu ${res.status}`)
    }
    await dorme(5000 * (tentativa + 1))
  }
}

interface AcaoMeta { action_type: string; value: string }

interface LinhaMeta {
  campaign_id?: string
  campaign_name?: string
  spend?: string
  action_values?: AcaoMeta[]
}

/** Segue `paging.next` até acabar (ou bater o teto). */
async function todasAsPaginas<T>(url: string): Promise<T[]> {
  const saida: T[] = []
  let proxima = url
  for (let p = 0; p < TETO_PAGINAS && proxima; p++) {
    const body = await pedir(proxima)
    saida.push(...((body.data ?? []) as T[]))
    // O `next` da Meta já vem com o access_token embutido.
    proxima = ((body.paging ?? {}) as { next?: string }).next ?? ''
  }
  return saida
}

/** "1297.45" → 1297.45. A Meta manda dinheiro como string, sempre. */
const numero = (v: string | undefined) => Number(v ?? 0) || 0

/** Duas casas, para o payload não levar 0.1+0.2 do ponto flutuante. */
const arredonda = (v: number) => Math.round(v * 100) / 100

/** O valor de compra da linha: o primeiro action_type que existir. */
function valorDeCompra(linha: LinhaMeta): number {
  const valores = linha.action_values ?? []
  for (const chave of COMPRA) {
    const hit = valores.find((a) => a.action_type === chave)
    if (hit) return numero(hit.value)
  }
  return 0
}

/** Só dígitos e o prefixo que a Graph API espera. */
function normalizaConta(id: string): string {
  const digitos = id.trim().replace(/^act_/i, '').replace(/\D/g, '')
  return digitos ? `act_${digitos}` : ''
}

interface Conta {
  id: string
  rotulo: string | null
  token: string
}

interface ResultadoDaConta {
  moeda: string | null
  /** Gasto de hoje em tudo que não está na lista de ignoradas. */
  gastoTotal: number
  vendasTotal: number
  /** Gasto de hoje que caiu na lista de ignoradas (059). */
  foraDoRelatorio: number
  /** Gasto de hoje em campanhas que não estão mais ativas. */
  gastoPausadas: number
  campanhas: Campanha[]
}

/**
 * Tudo que uma conta contribui para o relatório.
 *
 * Três chamadas, e cada uma tem um papel que as outras não cobrem:
 *
 *   1. a conta       → moeda, para formatar (e para detectar moedas mistas);
 *   2. as campanhas  → QUAIS estão ativas agora. Insights não responde isso:
 *      campanha ativa que ainda não entregou hoje não gera linha nenhuma, e
 *      sem esta chamada ela sumiria do relatório em vez de aparecer como
 *      "ativa sem gasto";
 *   3. insights de hoje (todas) + de vida inteira (só as ativas).
 *
 * O insights de hoje NÃO filtra por status justamente para o total continuar
 * fechando com o Gerenciador quando alguém pausa uma campanha no meio do dia.
 */
async function lerConta(conta: Conta, dia: string, ignoradas: Set<string>): Promise<ResultadoDaConta> {
  const info = await pedir(
    `${GRAPH}/${conta.id}?fields=name,currency&access_token=${conta.token}`,
  ) as { name?: string; currency?: string }

  const ativas = await todasAsPaginas<{ id?: string; name?: string }>(
    `${GRAPH}/${conta.id}/campaigns?${new URLSearchParams({
      fields: 'id,name',
      effective_status: JSON.stringify(['ACTIVE']),
      limit: String(LIMITE),
      access_token: conta.token,
    })}`,
  )

  const campos = 'campaign_id,campaign_name,spend,action_values'
  const [hoje, vidaInteira] = await Promise.all([
    todasAsPaginas<LinhaMeta>(`${GRAPH}/${conta.id}/insights?${new URLSearchParams({
      level: 'campaign',
      time_range: JSON.stringify({ since: dia, until: dia }),
      fields: campos,
      limit: String(LIMITE),
      access_token: conta.token,
    })}`),
    todasAsPaginas<LinhaMeta>(`${GRAPH}/${conta.id}/insights?${new URLSearchParams({
      // "período máximo da campanha" do pedido: a vida inteira dela.
      date_preset: 'maximum',
      level: 'campaign',
      fields: campos,
      // Só as que ainda estão ativas — é a única leitura de vida inteira que
      // a mensagem usa, e sem o filtro isto varreria o histórico da conta.
      filtering: JSON.stringify([
        { field: 'campaign.effective_status', operator: 'IN', value: ['ACTIVE'] },
      ]),
      limit: String(LIMITE),
      access_token: conta.token,
    })}`),
  ])

  const porId = (linhas: LinhaMeta[]) => {
    const m = new Map<string, { gasto: number; vendas: number; nome: string }>()
    for (const l of linhas) {
      if (!l.campaign_id) continue
      const acc = m.get(l.campaign_id) ?? { gasto: 0, vendas: 0, nome: '' }
      acc.gasto += numero(l.spend)
      acc.vendas += valorDeCompra(l)
      acc.nome = acc.nome || (l.campaign_name ?? '')
      m.set(l.campaign_id, acc)
    }
    return m
  }

  const deHoje = porId(hoje)
  const deSempre = porId(vidaInteira)
  const idsAtivos = new Map(
    ativas.filter((c) => c.id).map((c) => [c.id!, c.name ?? '(sem nome)']),
  )

  let gastoTotal = 0
  let vendasTotal = 0
  let foraDoRelatorio = 0
  let gastoPausadas = 0

  for (const [id, v] of deHoje) {
    if (ignoradas.has(id)) {
      foraDoRelatorio += v.gasto
      continue
    }
    gastoTotal += v.gasto
    vendasTotal += v.vendas
    if (!idsAtivos.has(id)) gastoPausadas += v.gasto
  }

  const campanhas: Campanha[] = []
  for (const [id, nome] of idsAtivos) {
    if (ignoradas.has(id)) continue
    const h = deHoje.get(id)
    const s = deSempre.get(id)
    campanhas.push({
      id,
      // O nome vindo do insights costuma ser igual, mas a chamada de
      // campanhas é a fonte de verdade do que está ativo AGORA.
      nome: nome || h?.nome || s?.nome || id,
      conta: conta.rotulo ?? info.name ?? conta.id,
      // Lido do NOME da campanha, não da conta: PH e Pedro veiculam na mesma
      // conta de anúncios, então o dono não sai do act_.
      dono: classificarDono(nome || h?.nome || s?.nome),
      gastoHoje: h?.gasto ?? 0,
      vendasHoje: h?.vendas ?? 0,
      gastoMax: s?.gasto ?? 0,
      vendasMax: s?.vendas ?? 0,
    })
  }

  return {
    moeda: info.currency ?? null,
    gastoTotal,
    vendasTotal,
    foraDoRelatorio,
    gastoPausadas,
    campanhas,
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok')

  const segredo = Deno.env.get('WORKER_SECRET')
  if (!segredo || req.headers.get('x-worker-secret') !== segredo) {
    return Response.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const svc = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Permite reprocessar à mão: POST {"dia":"2026-08-15"}. Sem isso, conferir
  // uma falha do cron exigiria esperar o próximo disparo.
  const corpo = await req.json().catch(() => ({})) as { dia?: string }
  const agora = new Date()
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(corpo.dia ?? '') ? corpo.dia! : hojeEmSP(agora)

  const [orgRes, contasRes, ignoradasRes] = await Promise.all([
    svc.from('crm_settings').select('organization_id, meta_ad_account_id, meta_ads_token, meta_access_token'),
    svc.from('crm_ad_accounts')
      .select('organization_id, account_id, label, access_token, sort_order, is_active')
      .order('sort_order'),
    svc.from('crm_ad_excluded_campaigns').select('organization_id, campaign_id'),
  ])

  /**
   * UM SELECT QUE FALHOU NÃO PODE VIRAR UMA LISTA VAZIA
   *
   * Este é o erro que o projeto já pagou caro em outros lugares: `{ data,
   * error }` com o error ignorado devolve `data: null`, o `?? []` transforma
   * isso em "não há nada", e o relatório sai com um número menor sem nada
   * denunciando a diferença.
   *
   * Aqui seria pior que o normal. Sem `crm_ad_accounts` o código embaixo cai
   * no fallback de conta única (`meta_ad_account_id`) — que é legítimo quando
   * a tabela está de fato vazia, e é um desastre quando a consulta falhou: o
   * WhatsApp receberia o relatório de UMA conta parecendo o das três. Gasto
   * plausível, ROI plausível, tudo errado.
   *
   * O caso concreto: a migration 085 não aplicada. A coluna `is_active` não
   * existe, o PostgREST recusa o select inteiro (42703) e não há guarda em
   * JavaScript que conserte isso — o `is_active !== false` lá embaixo protege
   * contra a LINHA sem o campo, nunca contra a COLUNA que não existe.
   *
   * Por isso a função para aqui e diz o que fazer. Um relatório que não chega
   * é investigado; um relatório errado é obedecido.
   */
  for (const [nome, res] of [
    ['crm_settings', orgRes],
    ['crm_ad_accounts', contasRes],
    ['crm_ad_excluded_campaigns', ignoradasRes],
  ] as const) {
    if (!res.error) continue
    // O erro do supabase-js não é um Error: a mensagem útil está no objeto
    // cru, e `err instanceof Error` seria falso.
    return Response.json({
      error: `Falha ao ler ${nome}`,
      detalhe: res.error.message,
      dica: nome === 'crm_ad_accounts'
        ? 'A migration 085 (coluna is_active) já foi aplicada neste banco?'
        : undefined,
    }, { status: 500 })
  }

  const settings = orgRes.data
  const contas = contasRes.data
  const ignoradasRaw = ignoradasRes.data

  const enviados: unknown[] = []

  // Uma organização por vez. Na prática é uma só, mas quem varre a tabela
  // inteira não precisa saber disso — e o dia em que existir a segunda, o
  // relatório dela sai sozinho em vez de faltar em silêncio.
  for (const org of settings ?? []) {
    const orgId = String(org.organization_id)
    const tokenOrg = (org.meta_ads_token || org.meta_access_token || '') as string

    // `!== false` e não `=== true`: a coluna é not null default true, então
    // o que isto cobre é a linha que chegar sem o campo — um select alterado
    // adiante, um cache de schema velho. Nesses casos a conta segue ATIVA, que
    // é o estado em que ela estava antes de o toggle existir. A coluna
    // inteira ausente é outro problema, e morre na checagem lá em cima.
    const daOrg = (contas ?? [])
      .filter((c) => c.organization_id === orgId && c.is_active !== false)

    const configuradas: Conta[] = daOrg.length > 0
      ? daOrg.map((c) => ({
        id: normalizaConta(String(c.account_id ?? '')),
        rotulo: (c.label as string | null) ?? null,
        token: (c.access_token as string | null) || tokenOrg,
      }))
      : [{
        id: normalizaConta(String(org.meta_ad_account_id ?? '')),
        rotulo: null,
        token: tokenOrg,
      }]

    const validas = configuradas.filter((c) => c.id && c.token)
    if (validas.length === 0) continue

    // Set<string> explícito: `data` do supabase-js chega frouxo o bastante
    // para o inferidor cair em Set<unknown>, e aí `lerConta` deixa de compilar.
    const ignoradas = new Set<string>(
      (ignoradasRaw ?? []).filter((e) => e.organization_id === orgId).map((e) => String(e.campaign_id)),
    )

    const falhas: Array<{ conta: string; erro: string }> = []
    const moedas = new Set<string>()
    const brutas: Campanha[] = []
    let gastoTotal = 0
    let vendasTotal = 0
    let foraDoRelatorio = 0
    let gastoPausadas = 0

    for (const conta of validas) {
      try {
        const r = await lerConta(conta, dia, ignoradas)
        if (r.moeda) moedas.add(r.moeda)
        gastoTotal += r.gastoTotal
        vendasTotal += r.vendasTotal
        foraDoRelatorio += r.foraDoRelatorio
        gastoPausadas += r.gastoPausadas
        brutas.push(...r.campanhas)
      } catch (err) {
        // Uma conta fora do ar não pode cancelar o relatório das outras — mas
        // também não pode passar despercebida, senão o total chega menor e
        // parece queda de investimento. A falha vai NA MENSAGEM, não só no log.
        falhas.push({
          conta: conta.rotulo ?? conta.id,
          erro: err instanceof Error ? err.message : 'Falha ao consultar a Meta',
        })
      }
    }

    const avaliadas = brutas.map(avaliar)
    const comGasto = ordenar(avaliadas.filter((c) => c.classe !== 'sem_gasto'))
    const semGasto = avaliadas
      .filter((c) => c.classe === 'sem_gasto')
      .map((c) => c.nome)
      .sort((a, b) => a.localeCompare(b, 'pt-BR'))

    const moeda = moedas.size === 1 ? [...moedas][0] : 'BRL'
    const mensagem = montarMensagem({
      hora: horaEmSP(agora),
      moeda,
      gastoTotal,
      campanhas: comGasto,
      semGasto,
      gastoPausadas,
      foraDoRelatorio,
      falhas,
      moedasDiferentes: moedas.size > 1,
    })

    const paraPayload = (c: Avaliada) => ({
      id: c.id,
      nome: c.nome,
      conta: c.conta,
      dono: c.dono,
      classe: c.classe,
      gasto_hoje: arredonda(c.gastoHoje),
      gasto_maximo: arredonda(c.gastoMax),
      vendas_hoje: arredonda(c.vendasHoje),
      vendas_maximo: arredonda(c.vendasMax),
      roi_hoje: c.roiHoje === null ? null : arredonda(c.roiHoje),
      roi_maximo: c.roiMax === null ? null : arredonda(c.roiMax),
      prejuizo: arredonda(c.prejuizo),
      matar: c.classe === 'matar',
    })

    const roiDia = roi(vendasTotal, gastoTotal)
    const payload = {
      // A mensagem pronta. O n8n só repassa — é o motivo desta função existir
      // em vez de o fluxo lá montar o texto a partir dos números.
      mensagem,
      // Sempre presente, para o n8n saber de que dia/hora é o número e poder
      // descartar uma entrega repetida.
      dia,
      hora: horaEmSP(agora),
      organizacao: orgId,
      ok: falhas.length === 0,
      // Deixa o n8n decidir se vale mandar: às 10h a conta costuma não ter
      // gasto registrado ainda, e cinco mensagens vazias por dia viram ruído.
      // Quem silencia é o fluxo, não esta função — ela sempre reporta.
      tem_dados: comGasto.length > 0,
      moeda: moedas.size === 1 ? [...moedas][0] : null,
      moedas_diferentes: moedas.size > 1,
      gasto_total_hoje: arredonda(gastoTotal),
      vendas_total_hoje: arredonda(vendasTotal),
      roi_do_dia: roiDia === null ? null : arredonda(roiDia),
      campanhas: comGasto.map(paraPayload),
      // Subtotal por dono, na mesma conta que a mensagem mostra — para o n8n
      // poder cortar por pessoa sem reprocessar a lista de campanhas.
      por_dono: [...comGasto.reduce((m, c) => {
        const acc = m.get(c.dono) ?? { gasto_hoje: 0, vendas_maximo: 0, campanhas: 0 }
        acc.gasto_hoje += c.gastoHoje
        acc.vendas_maximo += c.vendasMax
        acc.campanhas += 1
        return m.set(c.dono, acc)
      }, new Map<string, { gasto_hoje: number; vendas_maximo: number; campanhas: number }>())]
        .map(([dono, v]) => ({
          dono,
          gasto_hoje: arredonda(v.gasto_hoje),
          vendas_maximo: arredonda(v.vendas_maximo),
          campanhas: v.campanhas,
        }))
        .sort((a, b) => b.gasto_hoje - a.gasto_hoje),
      campanhas_para_matar: comGasto.filter((c) => c.classe === 'matar').map(paraPayload),
      ativas_sem_gasto: semGasto,
      // Ponte com o Gerenciador: gasto_total_hoje já inclui as pausadas, e
      // somando fora_do_relatorio chega-se ao que a Meta mostra na conta.
      gasto_pausadas: arredonda(gastoPausadas),
      fora_do_relatorio: arredonda(foraDoRelatorio),
      contas_com_falha: falhas,
      gerado_em: agora.toISOString(),
    }

    const res = await fetch(N8N_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch((err) => ({ ok: false, status: 0, statusText: String(err) } as Response))

    enviados.push({
      organizacao: orgId,
      dia,
      http: res.status,
      entregue: res.ok,
      campanhas: comGasto.length,
      gasto_total_hoje: payload.gasto_total_hoje,
    })
  }

  return Response.json({ ok: true, dia, enviados })
})
