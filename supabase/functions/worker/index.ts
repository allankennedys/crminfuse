/**
 * Edge Function: worker
 *
 * Motor server-side do PH Groups, acionado pelo pg_cron a cada minuto
 * (e opcionalmente "cutucado" pelo painel após enfileirar, para latência menor).
 * Roda com service role — processa todas as organizações.
 *
 * Etapas de cada execução:
 *  1. Libera locks travados (worker anterior morreu)
 *  2. Agendamentos vencidos → fila
 *  3. Fila → Evolution API (prioridade, rate limit por sessão, retry/backoff)
 *  4. Jobs de participantes (um lote de 10 por job por execução)
 *  5. Limpeza de mídias (24h após o envio)
 *  6. Heartbeat (worker_status)
 *
 * Auth: header x-worker-secret (cron) OU JWT de usuário válido (kick do painel).
 * Secrets: EVOLUTION_API_URL, EVOLUTION_API_KEY, WORKER_SECRET
 */

import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { autoEnableChat } from '../_shared/chatEnable.ts'

type Json = Record<string, unknown>

const WORKER_ID = `edge-${crypto.randomUUID().slice(0, 8)}`
const BACKOFF_MS = [0, 30_000, 120_000]
const PARTICIPANT_BATCH_SIZE = 10
// Quantos grupos sincronizar por rodada do worker (pacing p/ evitar bloqueio).
const SYNC_JOBS_PER_RUN = 5
const MEDIA_RETENTION_MS = 24 * 60 * 60_000

const svc: SupabaseClient = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

// ---------- Evolution API ----------

async function evo(path: string, method = 'GET', body?: unknown) {
  const baseUrl = Deno.env.get('EVOLUTION_API_URL')!.replace(/\/+$/, '')
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', apikey: Deno.env.get('EVOLUTION_API_KEY')! },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data: Json | null = null
  try { data = await res.json() } catch { /* sem corpo */ }
  return { ok: res.ok, status: res.status, data }
}

// ---------- 1b. Status dos números ----------

function mapState(state: string | undefined): string {
  if (state === 'open') return 'connected'
  if (state === 'connecting') return 'connecting'
  return 'disconnected'
}

async function refreshSessions() {
  const { data: sessions } = await svc.from('whatsapp_sessions').select('id, instance_name, status, chat_enabled, chat_manual_off')
  for (const s of sessions ?? []) {
    const res = await evo(`/instance/connectionState/${s.instance_name}`)
    const status = res.ok ? mapState((res.data?.instance as Json | undefined)?.state as string) : 'error'
    await svc.from('whatsapp_sessions').update({
      status,
      last_seen_at: new Date().toISOString(),
    }).eq('id', s.id)
    // Conectado e fora do atendimento: liga sozinho (não mexe em webhook alheio).
    if (status === 'connected' && !s.chat_enabled) await autoEnableChat(svc, (m, p, b) => evo(p, m, b), s)
  }
}

// ---------- 2. Agendamentos ----------

async function processSchedules() {
  const nowIso = new Date().toISOString()
  const { data: due } = await svc
    .from('schedules')
    .select('*')
    .eq('status', 'scheduled')
    .lte('scheduled_at', nowIso)
    .limit(100)

  for (const s of due ?? []) {
    const { data: claimed } = await svc
      .from('schedules')
      .update({ status: 'executed', executed_at: nowIso })
      .eq('id', s.id)
      .eq('status', 'scheduled')
      .select()
    if (!claimed || claimed.length === 0) continue

    const { data: queued } = await svc.from('message_queue').insert({
      organization_id: s.organization_id,
      message_id: s.message_id,
      group_id: s.group_id,
      // null = automático: pickSession distribui entre os conectados do grupo
      session_id: s.session_id,
      priority: s.priority,
    }).select().single()

    if (queued) {
      await svc.from('message_logs').insert({
        organization_id: s.organization_id,
        queue_id: queued.id,
        message_id: s.message_id,
        group_id: s.group_id,
        status: 'queued',
      })
    } else {
      await svc.from('schedules').update({ status: 'failed' }).eq('id', s.id)
    }
  }
}

// ---------- 3. Fila ----------

async function sentInLastMinute(sessionId: string): Promise<number> {
  const { count } = await svc
    .from('message_logs')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('status', 'sent')
    .gte('created_at', new Date(Date.now() - 60_000).toISOString())
  return count ?? 0
}

/**
 * Escolhe o número que fará o envio.
 *
 * `session_id` preenchido = escolha explícita do usuário: é respeitada, e se
 * o número não estiver conectado o item falha (retry/backoff) em vez de sair
 * por outro número — enviar de um número diferente do escolhido seria errado.
 * Sem `session_id` = automático: o conectado menos usado na janela do minuto.
 *
 * Retorna o motivo junto para o log dizer o que aconteceu de fato.
 */
async function pickSession(item: Json): Promise<{ session: Json | null; error?: string }> {
  if (item.session_id) {
    const { data } = await svc.from('whatsapp_sessions')
      .select('*').eq('id', item.session_id).maybeSingle()
    if (!data) return { session: null, error: 'O número escolhido não existe mais' }
    if (data.status !== 'connected') {
      return { session: null, error: `O número escolhido (${data.instance_name}) está desconectado` }
    }
    return { session: data }
  }

  const { data: links } = await svc.from('group_sessions')
    .select('session_id').eq('group_id', item.group_id)
  const ids = (links ?? []).map((l) => l.session_id)
  if (ids.length === 0) return { session: null, error: 'Grupo não vinculado a nenhum número' }

  const { data: sessions } = await svc.from('whatsapp_sessions')
    .select('*').in('id', ids).eq('status', 'connected')
  if (!sessions || sessions.length === 0) {
    return { session: null, error: 'Nenhum número conectado disponível' }
  }

  let best = sessions[0]
  let bestUsage = await sentInLastMinute(best.id)
  for (const s of sessions.slice(1)) {
    const usage = await sentInLastMinute(s.id)
    if (usage < bestUsage) { best = s; bestUsage = usage }
  }
  return { session: best }
}

async function dispatch(message: Json, jid: string, instance: string) {
  switch (message.media_type) {
    case 'text':
      return evo(`/message/sendText/${instance}`, 'POST', { number: jid, text: message.content ?? '' })
    case 'audio':
      return evo(`/message/sendWhatsAppAudio/${instance}`, 'POST', { number: jid, audio: message.media_url })
    default:
      return evo(`/message/sendMedia/${instance}`, 'POST', {
        number: jid,
        mediatype: message.media_type,
        media: message.media_url,
        caption: message.caption ?? undefined,
        fileName: message.file_name ?? undefined,
      })
  }
}

async function log(item: Json, status: string, mediaType: string, detail?: string) {
  await svc.from('message_logs').insert({
    organization_id: item.organization_id,
    queue_id: item.id,
    message_id: item.message_id,
    group_id: item.group_id,
    session_id: item.session_id ?? null,
    status,
    media_type: mediaType,
    detail: detail ?? null,
  })
}

async function retryOrFail(item: Json, mediaType: string, error: string) {
  const attempts = (item.attempts as number) + 1
  if (attempts >= (item.max_attempts as number)) {
    await svc.from('message_queue').update({
      status: 'failed', attempts, error,
      locked_at: null, locked_by: null,
      updated_at: new Date().toISOString(),
    }).eq('id', item.id)
    await log(item, 'failed', mediaType, error)
  } else {
    const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]
    await svc.from('message_queue').update({
      status: 'pending', attempts, error,
      locked_at: null, locked_by: null,
      next_attempt_at: new Date(Date.now() + delay).toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', item.id)
    await log(item, 'retrying', mediaType, `Tentativa ${attempts}/${item.max_attempts}: ${error}`)
  }
}

async function processQueue() {
  const { data: batch } = await svc.rpc('claim_queue_batch_worker', {
    p_worker: WORKER_ID, p_limit: 20,
  })

  for (const item of (batch as Json[]) ?? []) {
    const [{ data: message }, { data: group }] = await Promise.all([
      svc.from('messages').select('*').eq('id', item.message_id).maybeSingle(),
      svc.from('groups').select('*').eq('id', item.group_id).maybeSingle(),
    ])

    if (!message || !group) {
      await svc.from('message_queue').update({
        status: 'failed', error: 'Mensagem ou grupo não encontrado',
        updated_at: new Date().toISOString(),
      }).eq('id', item.id)
      continue
    }

    if (!group.group_jid) {
      await retryOrFail(item, message.media_type, 'Grupo não vinculado a um grupo real do WhatsApp')
      continue
    }

    const { session, error: sessionError } = await pickSession(item)
    if (!session) {
      await retryOrFail(item, message.media_type, sessionError ?? 'Nenhum número conectado disponível')
      continue
    }

    // Rate limit: devolve para a fila sem consumir tentativa
    const used = await sentInLastMinute(session.id as string)
    if (used >= (session.rate_limit_per_min as number)) {
      await svc.from('message_queue').update({
        status: 'pending', locked_at: null, locked_by: null,
        next_attempt_at: new Date(Date.now() + 15_000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', item.id)
      continue
    }

    const itemWithSession = { ...item, session_id: session.id }
    try {
      const res = await dispatch(message, group.group_jid as string, session.instance_name as string)
      if (res.ok) {
        await svc.from('message_queue').update({
          status: 'sent', session_id: session.id,
          locked_at: null, locked_by: null,
          updated_at: new Date().toISOString(),
        }).eq('id', item.id)
        await log(itemWithSession, 'sent', message.media_type)
      } else {
        throw new Error(`Falha no envio (erro ${res.status})`)
      }
    } catch (err) {
      await retryOrFail(itemWithSession, message.media_type, err instanceof Error ? err.message : String(err))
    }
  }
}

// ---------- 4. Jobs de participantes ----------

async function fetchContactsMap(instance: string): Promise<Map<string, string>> {
  const namesByJid = new Map<string, string>()
  const contacts = await evo(`/chat/findContacts/${instance}`, 'POST', { where: {} })
  if (contacts.ok && Array.isArray(contacts.data)) {
    for (const c of contacts.data as Json[]) {
      const jid = (c.remoteJid ?? c.id) as string | undefined
      const name = (c.pushName ?? c.name) as string | undefined
      if (jid && name) namesByJid.set(jid, name)
    }
  }
  return namesByJid
}

/**
 * Grupo importado pela lista rápida (findChats) entra com nome provisório
 * quando a Evolution ainda não tinha o assunto gravado. Aqui, uma vez por
 * grupo, pedimos a metadata ao WhatsApp e gravamos o nome de verdade.
 *
 * Só toca em nome provisório: nome real, inclusive renomeado à mão no painel,
 * é decisão do usuário e não deve ser sobrescrito a cada sincronização.
 */
const NOME_PROVISORIO = /^Grupo sem nome \(…\d{4}\)$/

async function resolveGroupName(groupId: string, groupJid: string, nome: string, instance: string) {
  if (!NOME_PROVISORIO.test(nome)) return

  const res = await evo(`/group/findGroupInfos/${instance}?groupJid=${encodeURIComponent(groupJid)}`)
  const subject = res.data?.subject as string | undefined
  if (!res.ok || !subject) return

  const desc = res.data?.desc as string | undefined
  await svc.from('groups').update({ name: subject, description: desc ?? null }).eq('id', groupId)
}

/**
 * Sincroniza os participantes de um grupo. `contactsByJid` opcional evita
 * refazer o findContacts (pesado) quando vários grupos usam o mesmo número.
 * Retorna false se não conseguiu buscar os participantes.
 */
async function syncGroupParticipants(
  groupId: string,
  groupJid: string,
  instance: string,
  contactsByJid?: Map<string, string>,
): Promise<boolean> {
  const res = await evo(`/group/participants/${instance}?groupJid=${encodeURIComponent(groupJid)}`)
  if (!res.ok) return false
  const participants = (res.data?.participants as Json[] | undefined) ?? []

  const namesByJid = contactsByJid ?? await fetchContactsMap(instance)

  const formatPhone = (jid: string) => {
    const digits = jid.split('@')[0].replace(/\D/g, '')
    if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
      const rest = digits.slice(4)
      const split = rest.length - 4
      return `+55 (${digits.slice(2, 4)}) ${rest.slice(0, split)}-${rest.slice(split)}`
    }
    return `+${digits}`
  }

  await svc.from('group_participants').delete().eq('group_id', groupId)
  if (participants.length > 0) {
    await svc.from('group_participants').insert(
      participants.map((p) => {
        const id = p.id as string
        const phoneJid = [p.phoneNumber, p.jid, id].find(
          (j) => typeof j === 'string' && j.includes('@s.whatsapp.net'),
        ) as string | undefined
        return {
          group_id: groupId,
          jid: id,
          name: (p.name ?? p.notify ?? p.pushName ?? namesByJid.get(id) ?? null) as string | null,
          phone: phoneJid ? formatPhone(phoneJid) : null,
          is_admin: p.admin === 'admin' || p.admin === 'superadmin',
        }
      }),
    )
  }
  return true
}

async function processParticipantJobs() {
  const { data: jobs } = await svc
    .from('participant_jobs')
    .select('*')
    .in('action', ['add', 'remove'])
    .in('status', ['pending', 'processing'])
    .order('created_at')
    .limit(5)

  for (const job of jobs ?? []) {
    const [{ data: group }, { data: session }] = await Promise.all([
      svc.from('groups').select('*').eq('id', job.group_id).maybeSingle(),
      svc.from('whatsapp_sessions').select('*').eq('id', job.session_id).maybeSingle(),
    ])

    const fail = async (error: string) => {
      await svc.from('participant_jobs').update({
        status: 'failed', error, updated_at: new Date().toISOString(),
      }).eq('id', job.id)
    }

    if (!group?.group_jid) { await fail('Grupo não vinculado ao WhatsApp'); continue }
    if (!session || session.status !== 'connected') { await fail('Número desconectado'); continue }

    const batch = (job.phones as string[]).slice(job.processed, job.processed + PARTICIPANT_BATCH_SIZE)
    if (batch.length === 0) {
      await svc.from('participant_jobs').update({
        status: 'done', updated_at: new Date().toISOString(),
      }).eq('id', job.id)
      continue
    }

    const res = await evo(
      `/group/updateParticipant/${session.instance_name}?groupJid=${encodeURIComponent(group.group_jid)}`,
      'POST',
      { action: job.action, participants: batch },
    )

    if (!res.ok) {
      await fail(`Parou em ${job.processed} de ${job.total}. Verifique se o número é admin do grupo.`)
      continue
    }

    const processed = job.processed + batch.length
    const finished = processed >= job.total
    await svc.from('participant_jobs').update({
      processed,
      status: finished ? 'done' : 'processing',
      updated_at: new Date().toISOString(),
    }).eq('id', job.id)

    if (finished) {
      await syncGroupParticipants(job.group_id, group.group_jid, session.instance_name)
    }
  }
}

/**
 * Jobs de sincronização (action='sync'): cada job = 1 grupo. Processa poucos
 * por rodada (pacing natural, ~1 por minuto por bloco) e reaproveita o
 * findContacts por número dentro da mesma execução — evita bloqueio/rate limit.
 */
async function processSyncJobs() {
  const { data: jobs } = await svc
    .from('participant_jobs')
    .select('*')
    .eq('action', 'sync')
    .in('status', ['pending', 'processing'])
    .order('created_at')
    .limit(SYNC_JOBS_PER_RUN)

  const contactsCache = new Map<string, Map<string, string>>()

  for (const job of jobs ?? []) {
    const [{ data: group }, { data: session }] = await Promise.all([
      svc.from('groups').select('*').eq('id', job.group_id).maybeSingle(),
      svc.from('whatsapp_sessions').select('*').eq('id', job.session_id).maybeSingle(),
    ])

    const fail = async (error: string) => {
      await svc.from('participant_jobs').update({
        status: 'failed', error, updated_at: new Date().toISOString(),
      }).eq('id', job.id)
    }

    if (!group?.group_jid) { await fail('Grupo não vinculado ao WhatsApp'); continue }
    if (!session || session.status !== 'connected') { await fail('Número desconectado'); continue }

    let contacts = contactsCache.get(session.instance_name)
    if (!contacts) {
      contacts = await fetchContactsMap(session.instance_name)
      contactsCache.set(session.instance_name, contacts)
    }

    await resolveGroupName(job.group_id, group.group_jid, group.name, session.instance_name)

    const ok = await syncGroupParticipants(job.group_id, group.group_jid, session.instance_name, contacts)
    if (!ok) { await fail('Não foi possível buscar os participantes'); continue }

    await svc.from('participant_jobs').update({
      processed: 1, total: 1, status: 'done', updated_at: new Date().toISOString(),
    }).eq('id', job.id)
  }
}

// ---------- 5. Limpeza de mídias ----------

async function cleanupMedia() {
  const { data: messages } = await svc
    .from('messages')
    .select('id, storage_path')
    .not('storage_path', 'is', null)
    .limit(100)

  const now = Date.now()
  for (const msg of messages ?? []) {
    const { data: items } = await svc
      .from('message_queue')
      .select('status, updated_at')
      .eq('message_id', msg.id)

    if ((items ?? []).some((i) => i.status === 'pending' || i.status === 'processing')) continue

    const { data: future } = await svc
      .from('schedules')
      .select('id')
      .eq('message_id', msg.id)
      .eq('status', 'scheduled')
      .limit(1)
    if (future && future.length > 0) continue

    const lastActivity = (items ?? []).reduce(
      (max, i) => Math.max(max, new Date(i.updated_at).getTime()), 0,
    )
    if (lastActivity === 0 || now - lastActivity < MEDIA_RETENTION_MS) continue

    const { error } = await svc.storage.from('media').remove([msg.storage_path as string])
    if (!error) {
      await svc.from('messages')
        .update({ storage_path: null, media_url: null })
        .eq('id', msg.id)
    }
  }
}

// ---------- 7. Pedidos de avaliação do atendimento (155) ----------

/** Envia pelo WhatsApp os pedidos de avaliação que venceram e grava a mensagem como "auto". */
async function processRatings() {
  const { data: due, error } = await svc.rpc('wa_rating_due', { p_limit: 20 })
  if (error) { console.error('[worker] avaliações:', error.message); return }
  for (const r of (due ?? []) as Json[]) {
    let ok = false
    try {
      const pn = r.pn_jid ? String(r.pn_jid) : null
      const lid = r.lid_jid ? String(r.lid_jid) : null
      const number = pn ? pn.split('@')[0] : lid
      if (!number || !r.text_out) throw new Error('sem destino ou texto')
      const res = await evo(`/message/sendText/${encodeURIComponent(String(r.instance_name))}`, 'POST', { number, text: String(r.text_out) })
      const key = (res.data as { key?: { id?: string } } | null)?.key
      if (!res.ok || !key?.id) throw new Error(`Evolution recusou (${res.status})`)
      ok = true
      // Se a gravação falhar, o pedido já foi enviado: não reenvia.
      const { error: e2 } = await svc.rpc('wa_ingest_message', {
        p_session: r.session_id, p_pn_jid: pn, p_lid_jid: lid, p_push_name: null, p_wa_id: String(key.id),
        p_from_me: true, p_type: 'text', p_body: String(r.text_out), p_has_media: false,
        p_ts: new Date().toISOString(), p_status: 'auto',
      })
      if (e2) console.error('[worker] avaliação gravada com erro:', e2.message)
    } catch (err) {
      console.error('[worker] avaliação:', err instanceof Error ? err.message : err)
    }
    await svc.rpc('wa_rating_sent', { p_id: r.id, p_ok: ok })
  }
}

// ---------- Entrada ----------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-worker-secret',
      },
    })
  }

  // Cron (secret) ou kick autenticado do painel
  const secret = req.headers.get('x-worker-secret')
  if (secret !== Deno.env.get('WORKER_SECRET')) {
    const authClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
    )
    const { data: { user } } = await authClient.auth.getUser()
    if (!user) {
      return new Response(JSON.stringify({ error: 'Não autorizado' }), { status: 401 })
    }
  }

  try {
    await svc.rpc('release_stale_locks_worker')
    await refreshSessions()
    await processSchedules()
    await processQueue()
    await processRatings().catch((e) => console.error('[worker] avaliações:', e))
    await processParticipantJobs()
    await processSyncJobs()
    await cleanupMedia()
    await svc.from('worker_status').upsert({ id: 1, last_run_at: new Date().toISOString() })
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  } catch (err) {
    console.error('[worker]', err)
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'erro' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  }
})
