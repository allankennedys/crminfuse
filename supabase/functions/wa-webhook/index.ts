/**
 * Edge Function: wa-webhook
 *
 * Recebe os eventos da Evolution API dos números ligados ao Atendimento e
 * grava as conversas individuais em wa_conversations / wa_messages (116).
 *
 * DEPLOY SEM VERIFICAÇÃO DE JWT — quem chama é a Evolution, não um usuário:
 *
 *   npx supabase functions deploy wa-webhook --no-verify-jwt
 *
 * AUTENTICAÇÃO: cada número tem um token próprio (wa_session_secrets),
 * criado pela wa-chat ao ativar o número e enviado na URL (?s=...). Token
 * desconhecido = 401; número desligado do atendimento = ignorado.
 *
 * SÓ CONVERSA INDIVIDUAL: grupo (@g.us), status, lista de transmissão e
 * canal (@newsletter) são descartados aqui, antes de tocar no banco.
 *
 * Eventos tratados (os mesmos que a wa-chat assina no /webhook/set):
 *   messages.upsert ... mensagem recebida, ou enviada pelo próprio celular
 *   send.message ...... mensagem enviada pela API (eco do envio do painel)
 *   messages.update ... entregue / lida
 *
 * Gravar é idempotente (id do WhatsApp + conversa): a Evolution reenviar o
 * mesmo evento, ou o eco chegar antes da resposta do envio, não duplica.
 *
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (automáticos),
 *          EVOLUTION_API_URL, EVOLUTION_API_KEY
 */

import { createClient } from 'npm:@supabase/supabase-js@2'
import { putMedia } from '../_shared/media.ts'

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)


interface Session {
  id: string
  organization_id: string
  instance_name: string
  chat_enabled: boolean
}

// deno-lint-ignore no-explicit-any
type Json = any

interface Parsed {
  type: 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'location' | 'contact' | 'reaction' | 'other'
  body: string | null
  media: boolean
  mime?: string | null
  name?: string | null
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok')

  const token = new URL(req.url).searchParams.get('s') ?? ''
  if (!token) return new Response('token ausente', { status: 401 })

  const { data: secret } = await admin
    .from('wa_session_secrets')
    .select('session_id')
    .eq('webhook_token', token)
    .maybeSingle()
  if (!secret) return new Response('token inválido', { status: 401 })

  const { data: session } = await admin
    .from('whatsapp_sessions')
    .select('id, organization_id, instance_name, chat_enabled')
    .eq('id', secret.session_id)
    .maybeSingle<Session>()
  if (!session?.chat_enabled) return new Response('número fora do atendimento')

  let payload: Json
  try {
    payload = await req.json()
  } catch {
    return new Response('json inválido', { status: 400 })
  }

  // O token é do número: evento de outra instância com ele é erro de
  // configuração (ou alguém reaproveitando a URL) e não entra.
  if (payload?.instance && payload.instance !== session.instance_name) {
    return new Response('instância não confere', { status: 403 })
  }

  const event = String(payload?.event ?? '').toLowerCase().replace(/_/g, '.')

  try {
    if (event === 'messages.upsert' || event === 'send.message') {
      const medias = await onMessages(session, payload.data)
      // Baixar mídia pode levar segundos; a mensagem já está gravada e
      // aparece na tela. O arquivo chega logo depois, em segundo plano.
      if (medias.length) {
        const pending = background(Promise.all(medias.map((m) => m().catch(logErr))))
        if (pending) await pending
      }
    } else if (event === 'messages.update') {
      await onStatus(session, payload.data)
    } else if (event === 'connection.update') {
      await onConnection(session, payload.data)
    }
  } catch (err) {
    logErr(err)
    // 500 deixa a Evolution reenviar; a gravação é idempotente.
    return new Response('erro ao processar', { status: 500 })
  }

  return new Response('ok')
})

// ---------------------------------------------------------------------------
// Mensagens
// ---------------------------------------------------------------------------

async function onMessages(session: Session, data: Json): Promise<Array<() => Promise<void>>> {
  const items: Json[] = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : [data]
  const medias: Array<() => Promise<void>> = []

  for (const item of items) {
    const key = item?.key
    if (!key?.id || !key?.remoteJid) continue

    const jids = resolveJids(key, item)
    if (!jids) continue // grupo, status, canal…

    // Reação, edição e exclusão: atualizam a mensagem que já existe, não
    // viram mensagem nova.
    const evento = parseEvento(item.message)
    if (evento) {
      const { error: eErr } = await admin.rpc('wa_message_event', {
        p_session: session.id,
        p_kind: evento.kind,
        p_target: evento.target,
        p_text: evento.text,
        p_actor: evento.kind === 'reaction' ? (key.fromMe ? 'equipe' : 'cliente') : null,
      })
      if (eErr) throw eErr
      continue
    }

    const parsed = parseContent(item.message, item.messageType)
    if (!parsed) continue // protocolo, chaves…

    const fromMe = Boolean(key.fromMe)
    // Só mensagem do cliente traz anúncio de verdade.
    const ad = fromMe ? null : findAd(item)

    const { data: row, error } = await admin.rpc('wa_ingest_message', {
      p_session: session.id,
      p_pn_jid: jids.pn,
      p_lid_jid: jids.lid,
      p_push_name: item.pushName ?? null,
      p_wa_id: String(key.id),
      p_from_me: fromMe,
      p_type: parsed.type,
      p_body: parsed.body,
      p_media_mime: parsed.mime ?? null,
      p_media_name: parsed.name ?? null,
      p_has_media: parsed.media,
      p_ts: toDate(item.messageTimestamp),
      p_status: fromMe ? (mapStatus(item.status) ?? 'sent') : 'received',
      p_ad: ad,
    }).single<{ conversation_id: string; message_id: string; inserted: boolean; organization_id: string }>()
    if (error) throw error

    // Só quem gravou a linha baixa o arquivo — o eco de um envio do painel
    // já chega com o arquivo no lugar.
    if (parsed.media && row?.inserted) {
      medias.push(() => saveMedia(session, row, item, parsed))
    }

    // Saudação / ausência automáticas (configuradas no atendimento).
    if (!fromMe && row?.inserted) {
      medias.push(() => autoReply(session, row.conversation_id, jids))
    }

    // Foto de perfil: confere de novo depois de 3 dias (o link expira).
    if (!fromMe && row?.inserted) {
      medias.push(() => refreshAvatar(session, row.conversation_id))
    }
  }

  return medias
}

/**
 * Resposta automática: o banco decide se há texto a enviar (horário, limite
 * de 1 por rodada) e já marca como enviada; aqui só se envia e se grava a
 * mensagem como "auto", para não contar como resposta humana.
 */
async function autoReply(
  session: Session,
  conversationId: string,
  jids: { pn: string | null; lid: string | null },
) {
  const { data: text, error } = await admin.rpc('wa_auto_reply_pick', { p_conversation: conversationId })
  if (error) throw error
  if (!text || typeof text !== 'string') return

  const number = jids.pn ? jids.pn.split('@')[0] : jids.lid
  if (!number) return
  const res = await evolution(`/message/sendText/${encodeURIComponent(session.instance_name)}`, { number, text })
  const id = res.data?.key?.id
  if (!res.ok || !id) throw new Error('falha ao enviar a resposta automática')

  const { error: e2 } = await admin.rpc('wa_ingest_message', {
    p_session: session.id,
    p_pn_jid: jids.pn,
    p_lid_jid: jids.lid,
    p_push_name: null,
    p_wa_id: String(id),
    p_from_me: true,
    p_type: 'text',
    p_body: text,
    p_has_media: false,
    p_ts: new Date().toISOString(),
    p_status: 'auto',
  })
  if (e2) throw e2
}

/**
 * Telefone e LID da conversa. O WhatsApp identifica parte dos chats pelo LID
 * (id opaco, ...@lid); a Evolution manda o telefone ao lado quando sabe, em
 * campos que mudaram de nome entre versões — por isso a lista.
 */
function resolveJids(key: Json, item: Json): { pn: string | null; lid: string | null } | null {
  const rj = String(key.remoteJid)
  const alts = [key.remoteJidAlt, key.senderPn, key.senderLid, item?.senderPn, key.participantAlt]
    .filter((v) => typeof v === 'string' && v)
    .map(String)

  if (rj.endsWith('@s.whatsapp.net')) {
    return { pn: rj, lid: alts.find((a) => a.endsWith('@lid')) ?? null }
  }
  if (rj.endsWith('@lid')) {
    return { pn: alts.find((a) => a.endsWith('@s.whatsapp.net')) ?? null, lid: rj }
  }
  return null
}

/**
 * Clique em anúncio Click-to-WhatsApp (CTWA). A Meta manda o contexto do
 * anúncio na primeira mensagem: externalAdReply com ctwaClid (o id do clique,
 * que a Conversions API usa para atribuir a venda ao anúncio), sourceId (id
 * do anúncio), sourceUrl e o app de entrada. A Evolution põe o contextInfo
 * em lugares diferentes conforme o tipo de mensagem e a versão — daí a busca
 * em todos eles.
 */
function findAd(item: Json): Record<string, string | null> | null {
  const msg = item?.message ?? {}
  const contexts: Json[] = [item?.contextInfo, msg?.contextInfo]
  for (const v of Object.values(msg)) {
    if (v && typeof v === 'object' && (v as Json).contextInfo) contexts.push((v as Json).contextInfo)
  }

  for (const ctx of contexts) {
    if (!ctx || typeof ctx !== 'object') continue
    const ar = ctx.externalAdReply ?? {}
    const clid = ar.ctwaClid ?? ctx.ctwaClid ?? null
    const sourceId = ar.sourceId ?? null
    const isAd = clid || sourceId || ar.sourceType === 'ad'
      || /ads|ctwa/i.test(String(ctx.conversionSource ?? '') + String(ctx.entryPointConversionSource ?? ''))
    if (!isAd) continue

    const url = String(ar.sourceUrl ?? '')
    const appHint = String(ctx.entryPointConversionApp ?? ar.sourceApp ?? '').toLowerCase()
    const app = appHint.includes('instagram') || /instagram\./i.test(url) ? 'instagram'
      : appHint.includes('facebook') || /(facebook\.|fb\.me|fb\.com)/i.test(url) ? 'facebook'
      : null

    return {
      ctwa_clid: clid ? String(clid) : null,
      source_id: sourceId ? String(sourceId) : null,
      source_url: url || null,
      source_app: app,
      title: ar.title ? String(ar.title).slice(0, 200) : null,
    }
  }
  return null
}

/**
 * Reação, edição ou exclusão feitas no WhatsApp. O formato muda entre versões
 * da Evolution, por isso aceita as formas conhecidas: protocolMessage (tipo
 * REVOKE/0 = apagar, MESSAGE_EDIT/14 = editar) e editedMessage embrulhada.
 */
function parseEvento(message: Json): { kind: 'reaction' | 'edit' | 'delete'; target: string; text: string | null } | null {
  if (!message || typeof message !== 'object') return null
  let m: Json = message
  for (let i = 0; i < 3; i++) {
    const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.documentWithCaptionMessage?.message
    if (!inner) break
    m = inner
  }

  if (m.reactionMessage) {
    const target = m.reactionMessage.key?.id
    return target ? { kind: 'reaction', target: String(target), text: String(m.reactionMessage.text ?? '') } : null
  }

  const proto = m.protocolMessage ?? m.editedMessage?.message?.protocolMessage
  if (proto) {
    const t = proto.type
    const target = proto.key?.id
    if (!target) return null
    if (t === 0 || t === 'REVOKE') return { kind: 'delete', target: String(target), text: null }
    if (t === 14 || t === 'MESSAGE_EDIT' || proto.editedMessage) {
      const e = proto.editedMessage ?? {}
      const text = e.conversation ?? e.extendedTextMessage?.text ?? null
      return text ? { kind: 'edit', target: String(target), text: String(text) } : null
    }
  }
  return null
}

function parseContent(message: Json, messageType?: string): Parsed | null {
  if (!message || typeof message !== 'object') return null

  // Envelopes: mensagem temporária, visualização única, documento com legenda.
  let m: Json = message
  for (let i = 0; i < 3; i++) {
    const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message
      ?? m.viewOnceMessageV2?.message ?? m.viewOnceMessageV2Extension?.message
      ?? m.documentWithCaptionMessage?.message
    if (!inner) break
    m = inner
  }

  if (typeof m.conversation === 'string') return { type: 'text', body: m.conversation, media: false }
  if (m.extendedTextMessage) return { type: 'text', body: m.extendedTextMessage.text ?? '', media: false }

  if (m.imageMessage) {
    return { type: 'image', body: m.imageMessage.caption ?? null, media: true, mime: m.imageMessage.mimetype }
  }
  if (m.videoMessage) {
    return { type: 'video', body: m.videoMessage.caption ?? null, media: true, mime: m.videoMessage.mimetype }
  }
  if (m.audioMessage) {
    return { type: 'audio', body: null, media: true, mime: m.audioMessage.mimetype }
  }
  if (m.documentMessage) {
    const d = m.documentMessage
    return { type: 'document', body: d.caption ?? null, media: true, mime: d.mimetype, name: d.fileName ?? d.title ?? null }
  }
  if (m.stickerMessage) {
    return { type: 'sticker', body: null, media: true, mime: m.stickerMessage.mimetype ?? 'image/webp' }
  }

  const loc = m.locationMessage ?? m.liveLocationMessage
  if (loc) {
    const lat = loc.degreesLatitude, lng = loc.degreesLongitude
    const label = [loc.name, loc.address].filter(Boolean).join(', ')
    return {
      type: 'location',
      body: `📍 ${label ? label + '\n' : ''}https://maps.google.com/?q=${lat},${lng}`,
      media: false,
    }
  }

  if (m.contactMessage) {
    return { type: 'contact', body: `👤 ${m.contactMessage.displayName ?? 'Contato'}\n${vcardPhones(m.contactMessage.vcard)}`.trim(), media: false }
  }
  if (m.contactsArrayMessage) {
    const list = (m.contactsArrayMessage.contacts ?? []) as Json[]
    return { type: 'contact', body: list.map((c) => `👤 ${c.displayName ?? 'Contato'} ${vcardPhones(c.vcard)}`.trim()).join('\n'), media: false }
  }

  if (m.reactionMessage) {
    const emoji = m.reactionMessage.text
    // Reação vazia = a pessoa tirou a reação. Não vira mensagem.
    return emoji ? { type: 'reaction', body: `Reagiu com ${emoji}`, media: false } : null
  }

  // Respostas de botão/lista e enquete: o que importa é o texto escolhido.
  const choice = m.buttonsResponseMessage?.selectedDisplayText
    ?? m.listResponseMessage?.title
    ?? m.templateButtonReplyMessage?.selectedDisplayText
  if (choice) return { type: 'text', body: choice, media: false }
  const poll = m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3
  if (poll) return { type: 'text', body: `📊 Enquete: ${poll.name ?? ''}`, media: false }

  // Controle do protocolo (apagar, editar, chaves): não é conversa.
  if (m.protocolMessage || m.editedMessage || m.senderKeyDistributionMessage || m.pollUpdateMessage) return null

  const tipo = messageType && messageType !== 'unknown' ? messageType : 'mensagem'
  return { type: 'other', body: `[${tipo} não suportada. Veja no celular]`, media: false }
}

function vcardPhones(vcard?: string): string {
  if (!vcard) return ''
  return [...vcard.matchAll(/TEL[^:]*:([+\d\s()-]+)/g)].map((x) => x[1].trim()).join(', ')
}

// ---------------------------------------------------------------------------
// Conexão do número
// ---------------------------------------------------------------------------

/**
 * O número conectou, caiu ou está reconectando: a Evolution avisa na hora.
 * Mesmos valores do worker (que agora só confere a cada 30 min, de reserva).
 */
async function onConnection(session: Session, data: Json) {
  const state = String(data?.state ?? '')
  if (!state) return
  const status = state === 'open' ? 'connected' : state === 'connecting' ? 'connecting' : 'disconnected'
  const { error } = await admin
    .from('whatsapp_sessions')
    .update({ status, last_seen_at: new Date().toISOString() })
    .eq('id', session.id)
  if (error) throw error
}

async function saveMedia(
  session: Session,
  row: { conversation_id: string; message_id: string; organization_id: string },
  item: Json,
  parsed: Parsed,
) {
  let b64: string | null = item?.message?.base64 ?? item?.base64 ?? null
  let mime = parsed.mime ?? null

  // Sem base64 no evento (webhook sem a opção, ou versão que não manda):
  // pede o arquivo à Evolution. Vai a mensagem inteira, não só o id — com
  // só o id ela precisa ter guardado a mensagem no banco dela.
  if (!b64) {
    const { base64: _ignorado, ...semBase64 } = item.message ?? {}
    const res = await evolution(`/chat/getBase64FromMediaMessage/${encodeURIComponent(session.instance_name)}`, {
      message: { key: item.key, message: semBase64 },
      convertToMp4: false,
    })
    b64 = res.ok ? res.data?.base64 ?? null : null
    mime = mime || res.data?.mimetype || null
  }

  if (!b64) {
    await admin.from('wa_messages').update({ media_status: 'falhou' }).eq('id', row.message_id)
    return
  }

  const bytes = decodeBase64(b64)
  const key = `${row.organization_id}/${row.conversation_id}/${row.message_id}.${extension(mime, parsed.name)}`
  const contentType = (mime ?? 'application/octet-stream').split(';')[0].trim()

  // R2 quando configurado; senão o Storage do Supabase (_shared/media.ts).
  let path: string | null = null
  let erro: unknown = null
  try {
    path = await putMedia(admin, key, bytes, contentType)
  } catch (e) {
    erro = e
  }

  await admin.from('wa_messages')
    .update(path ? { media_path: path, media_status: 'ok', media_mime: mime } : { media_status: 'falhou' })
    .eq('id', row.message_id)

  if (erro) throw erro
}

// ---------------------------------------------------------------------------
// Foto de perfil
// ---------------------------------------------------------------------------

const AVATAR_TTL_MS = 3 * 24 * 60 * 60 * 1000

async function refreshAvatar(session: Session, conversationId: string) {
  const { data: c } = await admin
    .from('wa_conversations')
    .select('id, phone, remote_jid, avatar_checked_at')
    .eq('id', conversationId)
    .maybeSingle()
  if (!c) return
  if (c.avatar_checked_at && Date.now() - new Date(c.avatar_checked_at).getTime() < AVATAR_TTL_MS) return

  const res = await evolution(`/chat/fetchProfilePictureUrl/${encodeURIComponent(session.instance_name)}`, {
    number: c.phone ?? c.remote_jid,
  })
  const url = res.ok && typeof res.data?.profilePictureUrl === 'string' ? res.data.profilePictureUrl : null
  await admin.from('wa_conversations')
    .update({ avatar_url: url, avatar_checked_at: new Date().toISOString() })
    .eq('id', c.id)
}

// ---------------------------------------------------------------------------
// Entregue / lida
// ---------------------------------------------------------------------------

async function onStatus(session: Session, data: Json) {
  const items: Json[] = Array.isArray(data) ? data : [data]
  for (const d of items) {
    const waId = d?.keyId ?? d?.key?.id
    const jid = String(d?.remoteJid ?? d?.key?.remoteJid ?? '')
    const status = mapStatus(d?.status ?? d?.update?.status)
    if (!waId || !status || jid.endsWith('@g.us')) continue

    const { error } = await admin.rpc('wa_update_message_status', {
      p_session: session.id,
      p_wa_id: String(waId),
      p_status: status,
    })
    if (error) throw error
  }
}

/** Status da Evolution/Baileys (texto ou número) → o nosso. */
function mapStatus(s: unknown): string | null {
  const v = typeof s === 'number' ? s : String(s ?? '').toUpperCase()
  switch (v) {
    case 0: case 'ERROR': return 'failed'
    case 1: case 'PENDING': return 'pending'
    case 2: case 'SERVER_ACK': return 'sent'
    case 3: case 'DELIVERY_ACK': return 'delivered'
    case 4: case 5: case 'READ': case 'PLAYED': return 'read'
    default: return null
  }
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/** messageTimestamp vem em segundos — como número, texto ou Long {low, high}. */
function toDate(ts: Json): string | null {
  const n = typeof ts === 'object' && ts !== null ? Number(ts.low ?? 0) : Number(ts)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n * 1000).toISOString()
}

function decodeBase64(b64: string): Uint8Array {
  const clean = b64.includes(',') && b64.startsWith('data:') ? b64.slice(b64.indexOf(',') + 1) : b64
  const bin = atob(clean)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/amr': 'amr',
  'application/pdf': 'pdf',
}

function extension(mime: string | null, name?: string | null): string {
  const fromName = name?.match(/\.([a-z0-9]{1,8})$/i)?.[1]
  if (fromName) return fromName.toLowerCase()
  const base = (mime ?? '').split(';')[0].trim().toLowerCase()
  return EXT[base] ?? 'bin'
}

async function evolution(path: string, body: unknown) {
  const base = (Deno.env.get('EVOLUTION_API_URL') ?? '').replace(/\/+$/, '')
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: Deno.env.get('EVOLUTION_API_KEY') ?? '' },
    body: JSON.stringify(body),
  }).catch(() => null)
  if (!res) return { ok: false, status: 0, data: null as Json }
  let data: Json = null
  try { data = await res.json() } catch { /* sem corpo */ }
  return { ok: res.ok, status: res.status, data }
}

/** Segundo plano quando o runtime oferece; senão devolve a promessa para esperar. */
function background(p: Promise<unknown>): Promise<unknown> | null {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime
  if (rt?.waitUntil) { rt.waitUntil(p); return null }
  return p
}

function logErr(err: unknown) {
  console.error('[wa-webhook]', err instanceof Error ? err.message : err)
}
