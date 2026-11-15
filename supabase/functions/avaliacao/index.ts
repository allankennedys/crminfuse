/**
 * Edge Function: avaliacao
 *
 * Envia na hora os pedidos de avaliação do atendimento que venceram (wa_ratings).
 * O banco chama esta função assim que o pedido é criado (gatilho em wa_ratings,
 * via pg_net) e de novo a cada minuto como rede de segurança (pg_cron), então o
 * pedido sai ao concluir a conversa — não espera o worker de 30 em 30 minutos.
 *
 * Auth: header x-servidor-key = platform_settings.signup_secret (o banco o lê; não
 * está no código). Deploy sem JWT: quem chama é o banco.
 *   npx supabase functions deploy avaliacao --no-verify-jwt
 */
import { createClient } from 'npm:@supabase/supabase-js@2'
import { chaveServidor } from '../_shared/servidor.ts'

const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
})

// deno-lint-ignore no-explicit-any
type Json = any

async function evo(path: string, body: unknown) {
  const base = (Deno.env.get('EVOLUTION_API_URL') ?? '').replace(/\/+$/, '')
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: Deno.env.get('EVOLUTION_API_KEY') ?? '' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null)
  if (!res) return { ok: false, status: 0, data: null as Json }
  let data: Json = null
  try { data = await res.json() } catch { /* sem corpo */ }
  return { ok: res.ok, status: res.status, data }
}

Deno.serve(async (req) => {
  const chave = await chaveServidor(svc)
  if (!chave || req.headers.get('x-servidor-key') !== chave) return new Response('não autorizado', { status: 401 })

  const { data: due, error } = await svc.rpc('wa_rating_due', { p_limit: 20 })
  if (error) { console.error('[avaliacao]', error.message); return new Response('erro', { status: 500 }) }

  let enviados = 0
  for (const r of (due ?? []) as Json[]) {
    let ok = false
    try {
      const pn = r.pn_jid ? String(r.pn_jid) : null
      const lid = r.lid_jid ? String(r.lid_jid) : null
      const number = pn ? pn.split('@')[0] : lid
      if (!number || !r.text_out) throw new Error('sem destino ou texto')
      const res = await evo(`/message/sendText/${encodeURIComponent(String(r.instance_name))}`, { number, text: String(r.text_out) })
      const key = res.data?.key
      if (!res.ok || !key?.id) throw new Error(`Evolution recusou (${res.status})`)
      ok = true
      // Pedido já enviado: se a gravação falhar, não reenvia (o eco do webhook grava).
      const { error: e2 } = await svc.rpc('wa_ingest_message', {
        p_session: r.session_id, p_pn_jid: pn, p_lid_jid: lid, p_push_name: null, p_wa_id: String(key.id),
        p_from_me: true, p_type: 'text', p_body: String(r.text_out), p_has_media: false,
        p_ts: new Date().toISOString(), p_status: 'auto',
      })
      if (e2) console.error('[avaliacao] gravada com erro:', e2.message)
      enviados++
    } catch (err) {
      console.error('[avaliacao]', err instanceof Error ? err.message : err)
    }
    await svc.rpc('wa_rating_sent', { p_id: r.id, p_ok: ok })
  }
  return new Response(JSON.stringify({ ok: true, enviados }), { headers: { 'Content-Type': 'application/json' } })
})
