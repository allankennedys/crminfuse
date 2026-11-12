/**
 * Edge Function: utmify-worker
 *
 * Envia para a UTMify as vendas de anúncio, 10 minutos depois de lançadas
 * (migration 097). Acionada pelo pg_cron a cada minuto — e só quando há
 * venda vencida na fila, então minuto sem venda não chega aqui.
 *
 * Quem decide o conteúdo do pedido e se a venda é de anúncio é o banco
 * (crm_utmify_pedido). Aqui só se entrega e se anota o resultado:
 *
 *   sent    — a UTMify aceitou.
 *   skipped — não é para enviar (não veio de anúncio, sem valor, antiga).
 *   failed  — a UTMify recusou os dados, ou 5 tentativas sem sucesso.
 *   pending — falha passageira: volta a tentar em 5, 10, 15… minutos.
 *
 * Organização sem credencial da UTMify: a venda fica pendente sem gastar
 * tentativa, e sai sozinha quando a credencial for salva (096).
 *
 * Reenviar não duplica: o orderId é o id da venda, e a UTMify trata o mesmo
 * orderId como o mesmo pedido.
 *
 * CTWA: A CAMPANHA VEM DA META
 *
 * Venda de Click-to-WhatsApp não tem landing, e o contato só guarda o
 * source_id do clique — o id do anúncio. Com só utm_content, a UTMify marca
 * "UTMs inválidas" e a venda fica sem atribuição (visto em 14/09/2026). Então,
 * quando o pedido chega sem utm_campaign mas com um id em utm_content, o
 * worker pergunta à Meta de que campanha e conjunto é aquele anúncio e manda
 * no formato da UTMify, "nome|id". Os tokens são os mesmos da aba Meta ADS
 * (crm_ad_accounts e a cascata da org); a busca não precisa saber a conta.
 *
 * Meta fora do ar ou limitando: a venda espera e tenta de novo, como uma
 * falha de envio. Esgotadas as tentativas, ou anúncio que nenhum token
 * enxerga, ela sai assim mesmo, sem campanha — melhor que não sair — e o
 * motivo fica em error.
 *
 * Auth: header x-worker-secret, igual ao crm-worker.
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WORKER_SECRET
 */

import { createClient } from 'npm:@supabase/supabase-js@2'
import { buscarAnuncio, type BuscaAnuncio } from './meta.ts'

const UTMIFY_URL = 'https://api.utmify.com.br/api-credentials/orders'
const BATCH_SIZE = 25
const MAX_ATTEMPTS = 5
const RETRY_MINUTES = 5

const svc = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

interface QueueRow {
  sale_id: string
  organization_id: string
  attempts: number
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('WORKER_SECRET')
  if (!secret || req.headers.get('x-worker-secret') !== secret) {
    return json({ error: 'Não autorizado' }, 401)
  }

  const { data: rows, error } = await svc
    .from('crm_utmify_queue')
    .select('sale_id, organization_id, attempts')
    .eq('status', 'pending')
    .lte('send_after', new Date().toISOString())
    .order('send_after')
    .limit(BATCH_SIZE)
    .returns<QueueRow[]>()

  if (error) return json({ error: error.message }, 500)
  if (!rows?.length) return json({ ok: true, processed: 0 })

  // Credencial é por organização: busca uma vez por org, não por venda.
  const orgIds = [...new Set(rows.map((r) => r.organization_id))]
  const [{ data: settings }, { data: contas }] = await Promise.all([
    svc
      .from('crm_settings')
      .select('organization_id, utmify_api_token, meta_ads_token, meta_access_token')
      .in('organization_id', orgIds),
    svc
      .from('crm_ad_accounts')
      .select('organization_id, access_token')
      .in('organization_id', orgIds)
      .order('sort_order'),
  ])
  const tokenByOrg = new Map(
    (settings ?? []).map((s) => [s.organization_id as string, (s.utmify_api_token as string | null)?.trim() || null]),
  )

  // Tokens da Meta por org, na ordem da aba Meta ADS: os das contas, depois
  // o de leitura da org, depois o da Conversion API.
  const metaTokensByOrg = new Map<string, string[]>()
  for (const org of orgIds) {
    const s = (settings ?? []).find((x) => x.organization_id === org)
    const candidatos = [
      ...(contas ?? []).filter((c) => c.organization_id === org).map((c) => c.access_token as string | null),
      s?.meta_ads_token as string | null,
      s?.meta_access_token as string | null,
    ]
    metaTokensByOrg.set(org, [...new Set(candidatos.map((t) => t?.trim()).filter((t): t is string => !!t))])
  }

  // Duas vendas do mesmo anúncio na mesma rodada perguntam à Meta uma vez.
  const anuncios = new Map<string, Promise<BuscaAnuncio>>()
  const buscar = (org: string, id: string) => {
    const chave = `${org}:${id}`
    if (!anuncios.has(chave)) anuncios.set(chave, buscarAnuncio(id, metaTokensByOrg.get(org) ?? []))
    return anuncios.get(chave)!
  }

  let sent = 0, skipped = 0, failed = 0, retried = 0

  for (const row of rows) {
    const token = tokenByOrg.get(row.organization_id)
    if (!token) continue

    const { data: built, error: buildError } = await svc
      .rpc('crm_utmify_pedido', { p_sale: row.sale_id })
      .maybeSingle<{ pedido: Record<string, unknown> | null; motivo: string | null }>()

    if (buildError) {
      retried++
      await retry(row, `Falha ao montar o pedido: ${buildError.message}`)
      continue
    }

    if (!built?.pedido) {
      skipped++
      await update(row.sale_id, { status: 'skipped', error: built?.motivo ?? 'Sem pedido' })
      continue
    }

    const attempts = row.attempts + 1

    // CTWA: só o id do anúncio em utm_content. Ver "CTWA" no topo.
    let aviso: string | null = null
    const utms = built.pedido.trackingParameters as Record<string, string | null> | undefined
    const idAnuncio = utms?.utm_content?.trim()
    if (utms && !utms.utm_campaign && idAnuncio && /^\d+$/.test(idAnuncio)) {
      const busca = await buscar(row.organization_id, idAnuncio)
      if (busca.ok) {
        Object.assign(utms, busca.utms)
      } else if (busca.transient && attempts < MAX_ATTEMPTS) {
        retried++
        await retry(row, `Meta, ao buscar a campanha do anúncio ${idAnuncio}: ${busca.error}`)
        continue
      } else {
        aviso = `Enviado sem campanha: a Meta não devolveu a do anúncio ${idAnuncio} (${busca.error})`
      }
    }

    let status = 0
    let body = ''
    try {
      const res = await fetch(UTMIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-token': token },
        body: JSON.stringify(built.pedido),
      })
      status = res.status
      body = (await res.text()).slice(0, 1000)
    } catch (err) {
      body = err instanceof Error ? err.message : 'Falha de rede'
    }

    if (status >= 200 && status < 300) {
      sent++
      await update(row.sale_id, { status: 'sent', attempts, sent_at: new Date().toISOString(), error: aviso })
    } else if (status === 400 || status === 422 || attempts >= MAX_ATTEMPTS) {
      // 400/422: a UTMify recusou os dados. Tentar de novo mandaria o mesmo erro.
      failed++
      await update(row.sale_id, { status: 'failed', attempts, error: `HTTP ${status}: ${body}` })
    } else {
      // Rede, 5xx, 429, credencial recusada: pode passar. Volta mais tarde.
      retried++
      await retry(row, `HTTP ${status}: ${body}`)
    }
  }

  return json({ ok: true, processed: rows.length, sent, skipped, failed, retried })
})

async function retry(row: QueueRow, error: string) {
  const attempts = row.attempts + 1
  const later = new Date(Date.now() + attempts * RETRY_MINUTES * 60_000).toISOString()
  await update(row.sale_id, {
    status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
    attempts,
    send_after: later,
    error,
  })
}

async function update(saleId: string, patch: Record<string, unknown>) {
  await svc.from('crm_utmify_queue').update(patch).eq('sale_id', saleId)
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
