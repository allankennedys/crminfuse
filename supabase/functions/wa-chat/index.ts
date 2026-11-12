/**
 * Edge Function: wa-chat
 *
 * Tudo o que o painel faz no Atendimento e precisa da Evolution: responder,
 * mandar arquivo, avisar "lida" e ligar/desligar um número.
 *
 * QUEM PODE O QUÊ — a conversa é lida com o token DO USUÁRIO, então a RLS de
 * wa_conversations (116) decide: o atendente só acha as conversas atribuídas
 * a ele; mandar mensagem numa conversa de outro dá 404 aqui, não importa o
 * que a tela tenha enviado. Ligar/desligar número exige
 * atendimento.configurar, perguntado ao banco (current_user_can).
 *
 * Ações (POST, corpo JSON):
 *   { action: 'send_text',  conversation_id, text }
 *   { action: 'send_media', conversation_id, path, mime, name, caption? }
 *       path = arquivo já enviado ao bucket wa-media, dentro da pasta da conversa
 *   { action: 'mark_read',  conversation_id }
 *   { action: 'avatar',     conversation_id, force? }  foto de perfil do cliente
 *   { action: 'session_info' | 'enable' | 'disable', session_id }
 *   { action: 'start', session_id, contact_id? , phone? }
 *       inicia conversa: confere o número na Evolution e devolve a conversa
 *
 * Secrets: EVOLUTION_API_URL, EVOLUTION_API_KEY (+ os automáticos do Supabase)
 */

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const WEBHOOK_BASE = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/wa-webhook`
const WEBHOOK_EVENTS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'SEND_MESSAGE']
const BUCKET = 'wa-media'

const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
})

// deno-lint-ignore no-explicit-any
type Json = any

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

interface Conversation {
  id: string
  organization_id: string
  session_id: string | null
  remote_jid: string
  lid_jid: string | null
  phone: string | null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  try {
    const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
      auth: { persistSession: false },
    })
    // O gateway já validou o JWT (verify_jwt): o id do usuário sai do próprio
    // token, sem mais uma ida ao serviço de autenticação a cada mensagem.
    const user = await currentUser(userClient, req.headers.get('Authorization'))
    if (!user) throw new HttpError(401, 'Não autenticado')

    const body = await req.json().catch(() => ({}))
    const action = String(body?.action ?? '')

    switch (action) {
      case 'send_text': return json(await sendText(userClient, user.id, body))
      case 'send_media': return json(await sendMedia(userClient, user.id, body))
      case 'mark_read': return json(await markRead(userClient, body))
      case 'avatar': return json(await avatar(userClient, body))
      case 'session_info': return json(await sessionInfo(userClient, user.id, body))
      case 'enable': return json(await enable(userClient, user.id, body))
      case 'disable': return json(await disable(userClient, user.id, body))
      case 'start': return json(await start(userClient, user.id, body))
      default: throw new HttpError(400, 'Ação desconhecida')
    }
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status)
    console.error('[wa-chat]', err)
    return json({ error: err instanceof Error ? err.message : 'Erro interno' }, 500)
  }
})

// ---------------------------------------------------------------------------
// Conversa
// ---------------------------------------------------------------------------

/** A conversa como o USUÁRIO a enxerga. Não achou = não é dele. */
async function loadConversation(userClient: SupabaseClient, id: unknown): Promise<Conversation> {
  if (typeof id !== 'string' || !id) throw new HttpError(400, 'conversation_id obrigatório')
  const { data } = await userClient
    .from('wa_conversations')
    .select('id, organization_id, session_id, remote_jid, lid_jid, phone')
    .eq('id', id)
    .maybeSingle<Conversation>()
  if (!data) throw new HttpError(404, 'Conversa não encontrada ou não atribuída a você')
  return data
}

async function instanceOf(conv: Conversation): Promise<string> {
  if (!conv.session_id) throw new HttpError(409, 'O número desta conversa foi removido do painel')
  const { data } = await admin
    .from('whatsapp_sessions')
    .select('instance_name, organization_id, status')
    .eq('id', conv.session_id)
    .maybeSingle()
  if (!data || data.organization_id !== conv.organization_id) {
    throw new HttpError(409, 'O número desta conversa não está disponível')
  }
  // Desconectado: avisa na hora. Mandar mesmo assim só fazia a tela esperar
  // a Evolution desistir.
  if (data.status === 'disconnected') {
    throw new HttpError(409, 'O número está desconectado do WhatsApp. Reconecte em Atendimento → Números.')
  }
  return data.instance_name
}

/** Usuário do token já validado pelo gateway; sem token legível, pergunta ao Auth. */
async function currentUser(userClient: SupabaseClient, authHeader: string | null): Promise<{ id: string } | null> {
  const token = (authHeader ?? '').replace(/^Bearer\s+/i, '')
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    if (typeof payload?.sub === 'string' && payload.role === 'authenticated') return { id: payload.sub }
  } catch { /* cai no caminho lento */ }
  const { data: { user } } = await userClient.auth.getUser()
  return user ? { id: user.id } : null
}

/** Para onde mandar: o telefone quando conhecido, senão o próprio jid (LID). */
function target(conv: Conversation): string {
  return conv.phone ?? conv.remote_jid
}

function jidsOf(conv: Conversation) {
  return {
    p_pn_jid: conv.remote_jid.endsWith('@s.whatsapp.net') ? conv.remote_jid : null,
    p_lid_jid: conv.lid_jid ?? (conv.remote_jid.endsWith('@lid') ? conv.remote_jid : null),
  }
}

async function sendText(userClient: SupabaseClient, userId: string, body: Json) {
  const conv = await loadConversation(userClient, body?.conversation_id)
  const text = String(body?.text ?? '').trim()
  if (!text) throw new HttpError(400, 'Mensagem vazia')
  if (text.length > 4096) throw new HttpError(400, 'Mensagem longa demais (máx. 4096 caracteres)')

  const instance = await instanceOf(conv)
  const res = await evolution('POST', `/message/sendText/${encodeURIComponent(instance)}`, {
    number: target(conv),
    text,
  })
  if (!res.ok || !res.data?.key?.id) throw new HttpError(502, evolutionError(res, 'enviar a mensagem'))

  return { message: await record(conv, userId, res.data, { type: 'text', body: text }) }
}

async function sendMedia(userClient: SupabaseClient, userId: string, body: Json) {
  const conv = await loadConversation(userClient, body?.conversation_id)
  const path = String(body?.path ?? '')
  // O arquivo tem que estar na pasta DESTA conversa — senão daria para
  // mandar ao cliente um anexo de outra conversa só trocando o caminho.
  if (!path.startsWith(`${conv.organization_id}/${conv.id}/`) || path.includes('..')) {
    throw new HttpError(400, 'Arquivo fora da conversa')
  }
  const mime = String(body?.mime ?? 'application/octet-stream')
  const name = String(body?.name ?? 'arquivo')
  const caption = String(body?.caption ?? '').trim() || undefined

  const { data: signed, error: signErr } = await admin.storage.from(BUCKET).createSignedUrl(path, 900)
  if (signErr || !signed?.signedUrl) throw new HttpError(400, 'Arquivo não encontrado no armazenamento')

  const instance = encodeURIComponent(await instanceOf(conv))
  const kind = mime.startsWith('image/') ? 'image'
    : mime.startsWith('video/') ? 'video'
    : mime.startsWith('audio/') ? 'audio'
    : 'document'

  // Áudio vai como mensagem de voz (a Evolution converte); o resto, como mídia.
  const res = kind === 'audio'
    // encoding: a Evolution converte o áudio do navegador (webm/ogg/mp4)
    // para o formato de mensagem de voz do WhatsApp.
    ? await evolution('POST', `/message/sendWhatsAppAudio/${instance}`, { number: target(conv), audio: signed.signedUrl, encoding: true })
    : await evolution('POST', `/message/sendMedia/${instance}`, {
      number: target(conv),
      mediatype: kind,
      mimetype: mime,
      media: signed.signedUrl,
      caption,
      fileName: name,
    })
  if (!res.ok || !res.data?.key?.id) throw new HttpError(502, evolutionError(res, 'enviar o arquivo'))

  return {
    message: await record(conv, userId, res.data, {
      type: kind, body: caption ?? null, media_path: path, media_mime: mime, media_name: name,
    }),
  }
}

/** Grava o que acabou de sair, já com quem enviou. */
async function record(
  conv: Conversation,
  userId: string,
  sent: Json,
  m: { type: string; body: string | null; media_path?: string; media_mime?: string; media_name?: string },
) {
  const ts = Number(sent.messageTimestamp)
  const { data, error } = await admin.rpc('wa_ingest_message', {
    p_session: conv.session_id,
    ...jidsOf(conv),
    p_push_name: null,
    p_wa_id: String(sent.key.id),
    p_from_me: true,
    p_type: m.type,
    p_body: m.body,
    p_media_mime: m.media_mime ?? null,
    p_media_name: m.media_name ?? null,
    p_has_media: Boolean(m.media_path),
    p_media_path: m.media_path ?? null,
    p_ts: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : null,
    p_status: 'sent',
    p_sent_by: userId,
  }).single<{ message_id: string }>()
  if (error) throw error

  const { data: row } = await admin.from('wa_messages').select('*').eq('id', data!.message_id).single()
  return row
}

async function markRead(userClient: SupabaseClient, body: Json) {
  const conv = await loadConversation(userClient, body?.conversation_id)
  const { error } = await userClient.rpc('wa_mark_read', { p_conversation: conv.id })
  if (error) throw error

  // Tique azul para o cliente e "lida" no celular. Acessório: se falhar, a
  // conversa já está zerada no painel e ninguém precisa saber.
  waitUntil((async () => {
    if (!conv.session_id) return
    const instance = await instanceOf(conv).catch(() => null)
    if (!instance) return
    const { data: last } = await admin
      .from('wa_messages')
      .select('wa_message_id')
      .eq('conversation_id', conv.id)
      .eq('from_me', false)
      .order('wa_timestamp', { ascending: false })
      .limit(10)
    if (!last?.length) return
    await evolution('POST', `/chat/markMessageAsRead/${encodeURIComponent(instance)}`, {
      readMessages: last.map((m) => ({ remoteJid: conv.remote_jid, fromMe: false, id: m.wa_message_id })),
    })
  })().catch(() => {}))

  return { ok: true }
}

// ---------------------------------------------------------------------------
// Foto de perfil (127)
// ---------------------------------------------------------------------------

/**
 * Busca (ou reaproveita) a foto do cliente. Conferida há menos de 3 dias,
 * devolve a guardada; `force` (a imagem não carregou — link expirado) pede
 * de novo, mas no máximo uma vez por hora.
 */
async function avatar(userClient: SupabaseClient, body: Json) {
  const conv = await loadConversation(userClient, body?.conversation_id)
  const { data: atual } = await admin
    .from('wa_conversations')
    .select('avatar_url, avatar_checked_at')
    .eq('id', conv.id)
    .single()
  const idade = atual?.avatar_checked_at ? Date.now() - new Date(atual.avatar_checked_at).getTime() : Infinity
  const limite = body?.force ? 60 * 60 * 1000 : 3 * 24 * 60 * 60 * 1000
  if (idade < limite) return { avatar_url: atual?.avatar_url ?? null }

  let url: string | null = null
  try {
    const instance = await instanceOf(conv)
    const res = await evolution('POST', `/chat/fetchProfilePictureUrl/${encodeURIComponent(instance)}`, { number: target(conv) })
    url = res.ok && typeof res.data?.profilePictureUrl === 'string' ? res.data.profilePictureUrl : null
  } catch {
    // Número desconectado/removido: fica a que já tinha.
    return { avatar_url: atual?.avatar_url ?? null }
  }
  await admin.from('wa_conversations')
    .update({ avatar_url: url, avatar_checked_at: new Date().toISOString() })
    .eq('id', conv.id)
  return { avatar_url: url }
}

// ---------------------------------------------------------------------------
// Iniciar conversa (126)
// ---------------------------------------------------------------------------

/** Dígitos com DDI; número brasileiro local (10/11 dígitos) ganha o 55. */
function normalizePhone(raw: string): string {
  const d = raw.replace(/\D/g, '')
  return d.length === 10 || d.length === 11 ? `55${d}` : d
}

async function start(userClient: SupabaseClient, userId: string, body: Json) {
  const [{ data: ver }, { data: todas }] = await Promise.all([
    userClient.rpc('current_user_can', { p_perm: 'atendimento.ver' }),
    userClient.rpc('current_user_can', { p_perm: 'atendimento.ver_todas' }),
  ])
  if (ver !== true && todas !== true) throw new HttpError(403, 'Seu perfil não atende conversas')

  const { data: profile } = await userClient.from('users').select('organization_id').eq('id', userId).maybeSingle()
  const org = profile?.organization_id
  if (!org) throw new HttpError(403, 'Usuário sem organização')

  const sessionId = String(body?.session_id ?? '')
  const { data: s } = await admin
    .from('whatsapp_sessions')
    .select('id, organization_id, instance_name, chat_enabled')
    .eq('id', sessionId)
    .maybeSingle()
  if (!s || s.organization_id !== org || !s.chat_enabled) {
    throw new HttpError(404, 'Escolha um número ligado ao atendimento')
  }

  // Telefone: do contato (lido aqui com service role, conferindo a
  // organização — o atendente não lê crm_contacts) ou o digitado.
  let contactId: string | null = null
  let name: string | null = null
  let phone = ''
  if (body?.contact_id) {
    const { data: c } = await admin
      .from('crm_contacts')
      .select('id, organization_id, name, phone')
      .eq('id', String(body.contact_id))
      .maybeSingle()
    if (!c || c.organization_id !== org) throw new HttpError(404, 'Contato não encontrado')
    if (!c.phone) throw new HttpError(400, 'Este contato não tem telefone cadastrado')
    contactId = c.id
    name = c.name
    phone = normalizePhone(c.phone)
  } else {
    phone = normalizePhone(String(body?.phone ?? ''))
  }
  if (phone.length < 10 || phone.length > 15) throw new HttpError(400, 'Número de telefone inválido')

  // O WhatsApp diz se o número existe e qual é o jid certo (com ou sem o 9).
  const check = await evolution('POST', `/chat/whatsappNumbers/${encodeURIComponent(s.instance_name)}`, { numbers: [phone] })
  if (!check.ok) throw new HttpError(502, evolutionError(check, 'conferir o número'))
  const hit = (Array.isArray(check.data) ? check.data : []).find((r: Json) => r?.exists)
  if (!hit?.jid) throw new HttpError(400, 'Este número não tem WhatsApp')

  const { data: conversationId, error } = await admin.rpc('wa_open_conversation', {
    p_session: s.id,
    p_jid: String(hit.jid),
    p_name: name,
    p_contact: contactId,
    p_user: userId,
  })
  if (error) throw new HttpError(400, error.message)
  return { conversation_id: conversationId }
}

// ---------------------------------------------------------------------------
// Números
// ---------------------------------------------------------------------------

async function sessionForConfig(userClient: SupabaseClient, userId: string, sessionId: unknown) {
  const { data: pode } = await userClient.rpc('current_user_can', { p_perm: 'atendimento.configurar' })
  if (pode !== true) throw new HttpError(403, 'Seu perfil não pode configurar os números do atendimento')
  if (typeof sessionId !== 'string' || !sessionId) throw new HttpError(400, 'session_id obrigatório')

  const { data: profile } = await userClient.from('users').select('organization_id, role').eq('id', userId).maybeSingle()
  const org = profile?.organization_id
  if (!org) throw new HttpError(403, 'Usuário sem organização')

  const { data: s } = await admin
    .from('whatsapp_sessions')
    .select('id, organization_id, instance_name, chat_enabled, created_by')
    .eq('id', sessionId)
    .maybeSingle()
  // Só o dono liga/desliga o número (117) — a Evolution é compartilhada e o
  // webhook é da instância inteira.
  const dono = s && s.organization_id === org
    && (s.created_by === userId || (s.created_by === null && profile?.role === 'admin'))
  if (!dono) throw new HttpError(404, 'Número não encontrado entre os seus')
  return s as { id: string; organization_id: string; instance_name: string; chat_enabled: boolean }
}

async function currentWebhook(instance: string) {
  const res = await evolution('GET', `/webhook/find/${encodeURIComponent(instance)}`)
  return res.ok && res.data && typeof res.data === 'object' ? res.data : null
}

/** O webhook que o número tem hoje — a tela avisa antes de substituir. */
async function sessionInfo(userClient: SupabaseClient, userId: string, body: Json) {
  const s = await sessionForConfig(userClient, userId, body?.session_id)
  const wh = await currentWebhook(s.instance_name)
  const url = typeof wh?.url === 'string' ? wh.url : ''
  let host: string | null = null
  try { host = url ? new URL(url).host : null } catch { host = url || null }
  return {
    chat_enabled: s.chat_enabled,
    webhook: url ? { host, enabled: Boolean(wh?.enabled), ours: url.startsWith(WEBHOOK_BASE) } : null,
  }
}

async function enable(userClient: SupabaseClient, userId: string, body: Json) {
  const s = await sessionForConfig(userClient, userId, body?.session_id)

  const { data: existing } = await admin
    .from('wa_session_secrets')
    .select('webhook_token, previous_webhook')
    .eq('session_id', s.id)
    .maybeSingle()

  // Reativar reaproveita o token: se a Evolution recusar a troca, nada fica
  // apontando para um token que não existe mais.
  const token = existing?.webhook_token ?? `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '')

  // Guarda o webhook anterior (n8n, bot…) para desativar devolver o número
  // como estava. A Evolution tem UM webhook por instância.
  let previous = existing?.previous_webhook ?? null
  if (!existing) {
    const wh = await currentWebhook(s.instance_name)
    if (wh?.url && !String(wh.url).startsWith(WEBHOOK_BASE)) previous = wh
  }

  if (!existing) {
    const { error } = await admin.from('wa_session_secrets').insert({
      session_id: s.id, webhook_token: token, previous_webhook: previous,
    })
    if (error) throw error
  }

  const res = await evolution('POST', `/webhook/set/${encodeURIComponent(s.instance_name)}`, {
    webhook: {
      enabled: true,
      url: `${WEBHOOK_BASE}?s=${token}`,
      byEvents: false,
      base64: true,
      events: WEBHOOK_EVENTS,
    },
  })
  if (!res.ok) {
    if (!existing) await admin.from('wa_session_secrets').delete().eq('session_id', s.id)
    throw new HttpError(502, evolutionError(res, 'configurar o webhook do número'))
  }

  const { error } = await admin.from('whatsapp_sessions').update({ chat_enabled: true }).eq('id', s.id)
  if (error) throw error
  return { ok: true }
}

async function disable(userClient: SupabaseClient, userId: string, body: Json) {
  const s = await sessionForConfig(userClient, userId, body?.session_id)

  const { data: secret } = await admin
    .from('wa_session_secrets')
    .select('previous_webhook')
    .eq('session_id', s.id)
    .maybeSingle()

  const prev = secret?.previous_webhook as Json
  const res = prev?.url
    ? await evolution('POST', `/webhook/set/${encodeURIComponent(s.instance_name)}`, {
      webhook: {
        enabled: prev.enabled ?? true,
        url: prev.url,
        headers: prev.headers ?? undefined,
        byEvents: prev.webhookByEvents ?? prev.byEvents ?? false,
        base64: prev.webhookBase64 ?? prev.base64 ?? false,
        events: Array.isArray(prev.events) && prev.events.length ? prev.events : WEBHOOK_EVENTS,
      },
    })
    : await evolution('POST', `/webhook/set/${encodeURIComponent(s.instance_name)}`, {
      webhook: { enabled: false, url: WEBHOOK_BASE, events: WEBHOOK_EVENTS },
    })

  // Instância apagada na Evolution (404) não impede desligar aqui.
  if (!res.ok && res.status !== 404) throw new HttpError(502, evolutionError(res, 'desligar o webhook do número'))

  await admin.from('wa_session_secrets').delete().eq('session_id', s.id)
  const { error } = await admin.from('whatsapp_sessions').update({ chat_enabled: false }).eq('id', s.id)
  if (error) throw error
  return { ok: true, restored: Boolean(prev?.url) }
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

async function evolution(method: string, path: string, body?: unknown) {
  const base = (Deno.env.get('EVOLUTION_API_URL') ?? '').replace(/\/+$/, '')
  if (!base) return { ok: false, status: 0, data: { error: 'EVOLUTION_API_URL não configurada' } as Json }
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', apikey: Deno.env.get('EVOLUTION_API_KEY') ?? '' },
    body: body === undefined ? undefined : JSON.stringify(body),
    // Sem resposta em 25 s, desiste: a tela mostra o erro em vez de girar.
    signal: AbortSignal.timeout(25_000),
  }).catch((err) => ({ ok: false, status: 0, json: async () => ({ error: String(err) }) } as unknown as Response))
  let data: Json = null
  try { data = await res.json() } catch { /* sem corpo */ }
  return { ok: res.ok, status: res.status, data }
}

/** A mensagem de erro da Evolution, que muda de lugar conforme a versão. */
function evolutionError(res: { status: number; data: Json }, what: string): string {
  const d = res.data
  const msg = d?.response?.message ?? d?.message ?? d?.error
  const text = Array.isArray(msg) ? msg.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ') : msg
  // Mensagem para a tela: sem nome de fornecedor.
  if (res.status === 0) return `Não foi possível falar com o WhatsApp para ${what}. Tente de novo em instantes.`
  return `O WhatsApp recusou ${what} (${res.status}${text ? `: ${text}` : ''})`
}

function waitUntil(p: Promise<unknown>) {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime
  if (rt?.waitUntil) rt.waitUntil(p)
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}
