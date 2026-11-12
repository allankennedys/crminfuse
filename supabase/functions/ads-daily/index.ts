/**
 * Edge Function: ads-daily
 *
 * Todo dia às 21h de Brasília, manda para o n8n quanto as contas de anúncio
 * gastaram no dia ANTERIOR: total, por conta e por tipo de campanha
 * (@PH, @Pedro, Recrutamento).
 *
 * Quem dispara é o pg_cron (migration 078), não a tela. O horário fica lá,
 * e 21h em São Paulo é 00:00 UTC — o Brasil não tem horário de verão desde
 * 2019, então isso não desalinha em nenhuma época do ano.
 *
 * POR QUE O BANCO NÃO FAZ O POST SOZINHO
 *
 * O gasto não está no banco: mora na Meta, e o token para lê-lo é secreto.
 * A 068 manda venda para o n8n direto do Postgres porque a venda já está
 * numa tabela; aqui é preciso sair para a internet, montar seis chamadas e
 * classificar nome de campanha. Isso é trabalho de função, não de plpgsql.
 *
 * O POST no n8n sai daqui pelo mesmo motivo da 068: o webhook não responde
 * CORS, e a chamada precisa partir do servidor.
 *
 * ESTE NÚMERO NÃO É O DA ABA META ADS — E A DIFERENÇA É DE PROPÓSITO
 *
 * O relatório do CRM esconde as campanhas da lista de ignoradas (059), que é
 * onde o recrutamento normalmente está. Aqui entra TUDO, porque o pedido é
 * justamente saber quanto o recrutamento consumiu. Para os dois números
 * poderem ser reconciliados sem investigação, o payload leva
 * `fora_do_relatorio_crm`: o gasto do dia que a aba Meta ADS não mostra.
 *
 *   total  −  fora_do_relatorio_crm  ≈  o que a aba Meta ADS mostra
 *
 * O BALDE "Outros" É OBRIGATÓRIO
 *
 * Campanha com nome fora da convenção não pode sumir da soma — é assim que
 * um total deixa de fechar sem ninguém entender por quê. Ela cai em "Outros"
 * e vai NOMEADA no payload, em `sem_classificacao`, para alguém renomear.
 *
 * Auth: header x-worker-secret, o mesmo do crm-worker.
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WORKER_SECRET
 */

import { createClient } from 'npm:@supabase/supabase-js@2'

/**
 * URL do fluxo no n8n. Fixa no código, como a da venda manual (068): é
 * endereço de infraestrutura, não configuração de organização. Mudou o fluxo
 * do lado de lá? Muda aqui e republica.
 */
const N8N_URL = Deno.env.get('N8N_ADS_DAILY_URL') ?? ''
// Infuse: a URL do fluxo vem do secret N8N_ADS_DAILY_URL. Sem ele o relatório é
// montado e NÃO é enviado a lugar nenhum (antes era o n8n da PH, fixo aqui).

/** Mesma versão das outras funções: cada uma guarda a sua para poderem subir
    separadas, como a crm-worker já faz. */
const META_API_VERSION = 'v21.0'
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
 * A convenção de nomes, e a ORDEM importa: a primeira regra que casar vence.
 *
 * Recrutamento vem antes de propósito — uma campanha chamada
 * "Recrutamento @PH" é de recrutamento, não de mídia do PH, e a ordem
 * inversa a classificaria errado.
 *
 * Caixa não importa dos DOIS lados: o nome vindo da Meta e o padrão daqui
 * são rebaixados na comparação. Sem isso, alguém acrescentando
 * "Recrutamento" com R maiúsculo a esta lista criaria uma regra que nunca
 * casa — e o gasto inteiro cairia calado em "Outros".
 *
 * Acento, ao contrário da caixa, NÃO é normalizado: um padrão com acento só
 * casa com o nome acentuado igual. Os padrões atuais não têm acento nenhum,
 * então isso hoje não custa nada — mas custaria no dia em que alguém
 * escrevesse "amplificação" aqui.
 *
 * Mudou a convenção da equipe? É esta lista que muda, e só ela.
 */
const TIPOS: ReadonlyArray<{ tipo: string; padroes: readonly string[] }> = [
  { tipo: 'Recrutamento', padroes: ['recrutamento', 'vaga'] },
  { tipo: 'Pedro', padroes: ['@pedro'] },
  { tipo: 'PH', padroes: ['@ph'] },
]
const OUTROS = 'Outros'

export function classificar(nome: string | null | undefined): string {
  const n = (nome ?? '').toLowerCase()
  for (const { tipo, padroes } of TIPOS) {
    if (padroes.some((p) => n.includes(p.toLowerCase()))) return tipo
  }
  return OUTROS
}

/**
 * O dia de ontem em São Paulo, "AAAA-MM-DD".
 *
 * `agora` é parâmetro para o teste poder fixar o instante — virada de mês, de
 * ano e o próprio horário do disparo (00:00 UTC, que em SP ainda é o dia
 * anterior) são exatamente os casos que quebram calado.
 */
export function ontemEmSP(agora: Date = new Date()): string {
  // en-CA porque formata como AAAA-MM-DD, que é o formato que a Meta espera.
  const hoje = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(agora)
  const [a, m, d] = hoje.split('-').map(Number)
  // Date.UTC com dia 0 ou negativo já volta o mês corretamente.
  return new Date(Date.UTC(a, m - 1, d - 1)).toISOString().slice(0, 10)
}

const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Uma chamada ao Graph, com retry.
 *
 * Não é o retry da meta-ads. Lá alguém está olhando a tela e o teto é baixo
 * de propósito; aqui é madrugada, ninguém espera, e vale insistir mais e com
 * mais calma — perder o relatório do dia por um pico de 30 segundos seria
 * bobagem. Erro de token ou de conta não melhora com insistência e sai na
 * primeira tentativa.
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

interface LinhaMeta {
  campaign_id?: string
  campaign_name?: string
  spend?: string
}

/** Segue `paging.next` até acabar (ou bater o teto). */
async function todasAsPaginas(url: string): Promise<LinhaMeta[]> {
  const saida: LinhaMeta[] = []
  let proxima = url
  for (let p = 0; p < TETO_PAGINAS && proxima; p++) {
    const body = await pedir(proxima)
    saida.push(...((body.data ?? []) as LinhaMeta[]))
    // O `next` da Meta já vem com o access_token embutido.
    proxima = ((body.paging ?? {}) as { next?: string }).next ?? ''
  }
  return saida
}

/** Só dígitos e o prefixo que a Graph API espera. */
function normalizaConta(id: string): string {
  const digitos = id.trim().replace(/^act_/i, '').replace(/\D/g, '')
  return digitos ? `act_${digitos}` : ''
}

/** "1297.45" → 1297.45. A Meta manda dinheiro como string, sempre. */
const numero = (v: string | undefined) => Number(v ?? 0) || 0

/** Duas casas, para o payload não levar 0.1+0.2 do ponto flutuante. */
const arredonda = (v: number) => Math.round(v * 100) / 100

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

  // Permite reprocessar um dia específico à mão: POST {"dia":"2026-08-15"}.
  // Sem isso, corrigir uma falha do cron exigiria esperar o dia seguinte.
  const corpo = await req.json().catch(() => ({})) as { dia?: string }
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(corpo.dia ?? '') ? corpo.dia! : ontemEmSP()

  const [{ data: settings }, { data: contas }, { data: ignoradas }] = await Promise.all([
    svc.from('crm_settings').select('organization_id, meta_ad_account_id, meta_ads_token, meta_access_token'),
    svc.from('crm_ad_accounts').select('organization_id, account_id, label, access_token, sort_order').order('sort_order'),
    svc.from('crm_ad_excluded_campaigns').select('organization_id, campaign_id'),
  ])

  const enviados: unknown[] = []

  // Uma organização por vez. Na prática é uma só, mas quem varre a tabela
  // inteira não precisa saber disso — e o dia em que existir a segunda, o
  // relatório dela sai sozinho em vez de faltar em silêncio.
  for (const org of settings ?? []) {
    const orgId = String(org.organization_id)
    const tokenOrg = (org.meta_ads_token || org.meta_access_token || '') as string

    const daOrg = (contas ?? []).filter((c) => c.organization_id === orgId)
    const configuradas = daOrg.length > 0
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

    const excluidas = new Set(
      (ignoradas ?? []).filter((e) => e.organization_id === orgId).map((e) => String(e.campaign_id)),
    )

    const porConta: Array<Record<string, unknown>> = []
    const porTipo = new Map<string, { gasto: number; campanhas: number }>()
    const semClassificacao: Array<Record<string, unknown>> = []
    const falhas: Array<Record<string, string>> = []
    const moedas = new Set<string>()
    let total = 0
    let foraDoCrm = 0

    for (const conta of validas) {
      try {
        const info = await pedir(
          `${GRAPH}/${conta.id}?fields=name,currency&access_token=${conta.token}`,
        ) as { name?: string; currency?: string }

        const params = new URLSearchParams({
          level: 'campaign',
          time_range: JSON.stringify({ since: dia, until: dia }),
          fields: 'campaign_id,campaign_name,spend',
          limit: String(LIMITE),
          access_token: conta.token,
        })
        const linhas = await todasAsPaginas(`${GRAPH}/${conta.id}/insights?${params}`)

        let gastoDaConta = 0
        for (const l of linhas) {
          const gasto = numero(l.spend)
          if (gasto <= 0) continue
          gastoDaConta += gasto

          const tipo = classificar(l.campaign_name)
          const acc = porTipo.get(tipo) ?? { gasto: 0, campanhas: 0 }
          acc.gasto += gasto
          acc.campanhas += 1
          porTipo.set(tipo, acc)

          // Nomeada, não só contada: é o que permite corrigir o nome amanhã.
          if (tipo === OUTROS) {
            semClassificacao.push({
              campanha: l.campaign_name ?? l.campaign_id ?? '(sem nome)',
              conta: conta.rotulo ?? info.name ?? conta.id,
              gasto: arredonda(gasto),
            })
          }

          if (l.campaign_id && excluidas.has(l.campaign_id)) foraDoCrm += gasto
        }

        if (info.currency) moedas.add(info.currency)
        total += gastoDaConta
        porConta.push({
          conta: conta.id,
          nome: conta.rotulo ?? info.name ?? conta.id,
          moeda: info.currency ?? null,
          gasto: arredonda(gastoDaConta),
          campanhas: linhas.filter((l) => numero(l.spend) > 0).length,
        })
      } catch (err) {
        // Uma conta fora do ar não pode cancelar o relatório das outras — mas
        // também não pode passar despercebida, senão o total chega menor e
        // parece queda de investimento.
        falhas.push({
          conta: conta.rotulo ?? conta.id,
          erro: err instanceof Error ? err.message : 'Falha ao consultar a Meta',
        })
      }
    }

    const payload = {
      // Sempre presente, para o n8n saber de que dia é o número e poder
      // descartar uma entrega repetida.
      dia,
      organizacao: orgId,
      ok: falhas.length === 0,
      // null quando as contas faturam em moedas diferentes: aí o total não
      // soma coisa alguma e quem consome precisa saber disso.
      moeda: moedas.size === 1 ? [...moedas][0] : null,
      moedas_diferentes: moedas.size > 1,
      total: arredonda(total),
      por_conta: porConta,
      por_tipo: [...porTipo.entries()]
        .map(([tipo, v]) => ({ tipo, gasto: arredonda(v.gasto), campanhas: v.campanhas }))
        .sort((a, b) => b.gasto - a.gasto),
      // Quem caiu em "Outros", com nome. Lista vazia = convenção em dia.
      sem_classificacao: semClassificacao.sort((a, b) => (b.gasto as number) - (a.gasto as number)),
      // Ponte com a aba Meta ADS: total − isto ≈ o que o relatório do CRM mostra.
      fora_do_relatorio_crm: arredonda(foraDoCrm),
      contas_com_falha: falhas,
      gerado_em: new Date().toISOString(),
    }

    if (!N8N_URL) {
      enviados.push({ organizacao: orgId, dia, http: 0, entregue: false, motivo: 'sem_url' })
      continue
    }

    const res = await fetch(N8N_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch((err) => ({ ok: false, status: 0, statusText: String(err) } as Response))

    enviados.push({ organizacao: orgId, dia, http: res.status, entregue: res.ok, total: payload.total })
  }

  return Response.json({ ok: true, dia, enviados })
})
