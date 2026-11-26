/**
 * Edge Function: broadcast-run — envia as campanhas de envio em massa (migration 167)
 *
 * Chamada a cada minuto pelo pg_cron e logo após criar um envio imediato (via banco).
 * Auth: header x-servidor-key = platform_settings.signup_secret. Deploy sem JWT:
 *   npx supabase functions deploy broadcast-run --no-verify-jwt
 *
 * Cada chamada trabalha até ~110 s e devolve a campanha: o que sobrou, o próximo minuto
 * continua. Entre um contato e outro há uma pausa aleatória (±40% de delay_seconds).
 */
import { createClient } from 'npm:@supabase/supabase-js@2'
import { chaveServidor } from '../_shared/servidor.ts'
import { mediaUrl } from '../_shared/media.ts'
import { acessoDaOrganizacao } from '../_shared/assinatura.ts'

const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
})

// deno-lint-ignore no-explicit-any
type Json = any

const ORCAMENTO_MS = 110_000

async function evo(path: string, body: unknown, method = 'POST') {
  const base = (Deno.env.get('EVOLUTION_API_URL') ?? '').replace(/\/+$/, '')
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', apikey: Deno.env.get('EVOLUTION_API_KEY') ?? '' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  }).catch(() => null)
  if (!res) return { ok: false, status: 0, data: null as Json }
  let data: Json = null
  try { data = await res.json() } catch { /* sem corpo */ }
  return { ok: res.ok, status: res.status, data }
}

function erroEvo(res: { status: number; data: Json }): string {
  const d = res.data
  const msg = d?.response?.message ?? d?.message ?? d?.error
  const t = Array.isArray(msg) ? msg.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ') : msg
  return res.status === 0 ? 'Sem resposta do WhatsApp' : `WhatsApp recusou (${res.status}${t ? `: ${t}` : ''})`.slice(0, 280)
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** "{nome}" vira o primeiro nome do contato (vazio se não houver). */
function personalizar(texto: string, nome: string | null): string {
  const primeiro = (nome ?? '').trim().split(/\s+/)[0] ?? ''
  return texto.replace(/\{nome\}/gi, primeiro).replace(/[ \t]+\n/g, '\n').trim()
}

Deno.serve(async (req) => {
  const chave = await chaveServidor(svc)
  if (!chave || req.headers.get('x-servidor-key') !== chave) return new Response('não autorizado', { status: 401 })

  const inicio = Date.now()
  const { data: campanhas, error } = await svc.rpc('broadcast_claim', { p_limit: 5 })
  if (error) { console.error('[broadcast-run]', error.message); return new Response('erro', { status: 500 }) }

  await Promise.all(((campanhas ?? []) as Json[]).map((b) =>
    processar(b, inicio).catch(async (err) => {
      console.error('[broadcast-run] campanha', b.id, err instanceof Error ? err.message : err)
      await svc.from('broadcasts').update({ locked_until: null }).eq('id', b.id)
    })))

  return new Response(JSON.stringify({ ok: true, campanhas: (campanhas ?? []).length }), { headers: { 'Content-Type': 'application/json' } })
})

async function encerrar(b: Json, status: 'concluida' | 'falhou', motivo?: string) {
  await svc.from('broadcasts').update({
    status, error: motivo ?? null, finished_at: new Date().toISOString(), locked_until: null,
  }).eq('id', b.id).in('status', ['enviando'])
}

async function processar(b: Json, inicio: number) {
  // Assinatura sem acesso: nada sai.
  if ((await acessoDaOrganizacao(svc, b.organization_id)) !== 'total') {
    return encerrar(b, 'falhou', 'Assinatura sem acesso. Regularize e crie a campanha de novo.')
  }

  const { data: s } = await svc.from('whatsapp_sessions')
    .select('instance_name, organization_id, chat_enabled, status').eq('id', b.session_id).maybeSingle()
  if (!s || s.organization_id !== b.organization_id || !s.chat_enabled) {
    return encerrar(b, 'falhou', 'O número da campanha foi removido ou desligado do atendimento.')
  }
  const instance = encodeURIComponent(String(s.instance_name))

  // Desconectado? Confere ao vivo; se continua fora, para a campanha em vez de falhar um por um.
  const conn = await evo(`/instance/connectionState/${instance}`, undefined, 'GET')
  const estado = String(conn.data?.instance?.state ?? conn.data?.state ?? '')
  if (conn.ok && estado !== 'open') {
    return encerrar(b, 'falhou', 'O número está desconectado do WhatsApp. Reconecte e crie a campanha de novo (quem já recebeu não repete).')
  }

  const midia = b.media_path ? await mediaUrl(svc, String(b.media_path), 3600) : null
  if (b.kind !== 'text' && !midia) return encerrar(b, 'falhou', 'O anexo não está mais disponível.')

  while (Date.now() - inicio < ORCAMENTO_MS) {
    // Cancelada no meio? Para na hora.
    const { data: atual } = await svc.from('broadcasts').select('status').eq('id', b.id).maybeSingle()
    if (atual?.status !== 'enviando') return

    const { data: lote } = await svc.from('broadcast_recipients')
      .select('id, name, phone, contact_id').eq('broadcast_id', b.id).eq('status', 'pendente').order('id').limit(10)
    if (!lote?.length) return encerrar(b, 'concluida')

    for (const r of lote) {
      if (Date.now() - inicio >= ORCAMENTO_MS) break
      const erro = await enviarUm(b, instance, midia, r).catch((e) => (e instanceof Error ? e.message : 'Falha no envio'))
      await svc.rpc('broadcast_mark', { p_recipient: r.id, p_ok: !erro, p_error: erro })
      // Estende a trava enquanto trabalha.
      await svc.from('broadcasts').update({ locked_until: new Date(Date.now() + 170_000).toISOString() }).eq('id', b.id)
      await dormir(Math.round(b.delay_seconds * 1000 * (0.6 + Math.random() * 0.8)))
    }
  }
  // Sobrou gente: solta a trava, o próximo minuto continua.
  await svc.from('broadcasts').update({ locked_until: null }).eq('id', b.id).eq('status', 'enviando')
}

/** Envia para um contato. Devolve null se saiu, ou o motivo da falha. */
async function enviarUm(b: Json, instance: string, midia: string | null, r: Json): Promise<string | null> {
  // O WhatsApp diz se o número existe e qual é o jid certo (com ou sem o 9).
  const chk = await evo(`/chat/whatsappNumbers/${instance}`, { numbers: [r.phone] })
  if (!chk.ok) return erroEvo(chk)
  const hit = (Array.isArray(chk.data) ? chk.data : []).find((x: Json) => x?.exists)
  if (!hit?.jid) return 'Este número não tem WhatsApp'
  const jid = String(hit.jid)
  const numero = jid.split('@')[0]

  const texto = b.body ? personalizar(String(b.body), r.name) : ''

  const gravar = async (waId: string, m: { type: string; body: string | null; withMedia: boolean }) => {
    const { error } = await svc.rpc('wa_ingest_message', {
      p_session: b.session_id,
      p_pn_jid: jid.endsWith('@s.whatsapp.net') ? jid : null,
      p_lid_jid: jid.endsWith('@lid') ? jid : null,
      p_push_name: null, p_wa_id: waId, p_from_me: true, p_type: m.type, p_body: m.body,
      p_media_mime: m.withMedia ? b.media_mime : null, p_media_name: m.withMedia ? b.media_name : null,
      p_has_media: m.withMedia, p_media_path: m.withMedia ? b.media_path : null,
      p_ts: new Date().toISOString(), p_status: 'sent', p_sent_by: b.created_by,
    })
    // A mensagem já saiu: falhar a gravação não pode virar "falha" (reenviaria).
    if (error) console.error('[broadcast-run] enviada mas não gravada:', error.message)
  }

  // Texto puro, ou o texto que antecede o áudio (áudio não tem legenda).
  if (b.kind === 'text' || (b.kind === 'audio' && texto)) {
    const res = await evo(`/message/sendText/${instance}`, { number: numero, text: texto })
    if (!res.ok || !res.data?.key?.id) return erroEvo(res)
    await gravar(String(res.data.key.id), { type: 'text', body: texto, withMedia: false })
    if (b.kind === 'text') return null
    await dormir(1500)
  }

  const mime = String(b.media_mime ?? 'application/octet-stream')
  const res = b.kind === 'audio'
    ? await evo(`/message/sendWhatsAppAudio/${instance}`, { number: numero, audio: midia, encoding: true })
    : await evo(`/message/sendMedia/${instance}`, {
      number: numero, mediatype: b.kind, mimetype: mime, media: midia,
      caption: texto || undefined, fileName: b.media_name ?? 'arquivo',
    })
  if (!res.ok || !res.data?.key?.id) return erroEvo(res)
  await gravar(String(res.data.key.id), { type: b.kind, body: b.kind === 'audio' ? null : (texto || null), withMedia: true })
  return null
}
