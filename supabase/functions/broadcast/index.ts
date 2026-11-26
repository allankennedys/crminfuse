/**
 * Edge Function: broadcast  (JWT) — envio em massa (migration 167)
 *
 * Cria, cancela e prepara anexo das campanhas. Quem envia é a `broadcast-run`.
 * Quem pode: crm.contatos.editar (admin sempre), com a assinatura em dia.
 *
 *   { action: 'upload_url', name }                  → para onde o navegador sobe o anexo
 *   { action: 'create', name, session_id, kind, body?, media?: {path,mime,name},
 *     scheduled_at? (ISO; vazio = agora), delay_seconds?,
 *     audience: { mode: 'ids', ids } | { mode: 'all', stage_id?, tags? } }
 *   { action: 'cancel', id }
 */
import { createClient } from 'npm:@supabase/supabase-js@2'
import { keyOf, uploadTarget } from '../_shared/media.ts'
import { acessoDaOrganizacao, MSG_SEM_ACESSO } from '../_shared/assinatura.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
}
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })

// deno-lint-ignore no-explicit-any
type Json = any
class HttpError extends Error { constructor(public status: number, message: string) { super(message) } }

const MAX_DESTINATARIOS = 5000
const KINDS = ['text', 'image', 'video', 'audio', 'document']

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

/** Dígitos com DDI; número brasileiro local (10/11 dígitos) ganha o 55. */
function normalizePhone(raw: string): string {
  const d = raw.replace(/\D/g, '')
  return d.length === 10 || d.length === 11 ? `55${d}` : d
}

function safeName(name: string): string {
  const clean = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_')
  return clean.slice(-80) || 'arquivo'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)
  try {
    const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
      auth: { persistSession: false },
    })
    const { data: { user } } = await userClient.auth.getUser()
    if (!user) throw new HttpError(401, 'Não autenticado')

    const { data: pode } = await userClient.rpc('current_user_can', { p_perm: 'crm.contatos.editar' })
    if (pode !== true) throw new HttpError(403, 'Seu perfil não pode fazer envio em massa')
    const { data: perfil } = await userClient.from('users').select('organization_id').eq('id', user.id).maybeSingle()
    const org = perfil?.organization_id as string | undefined
    if (!org) throw new HttpError(403, 'Usuário sem organização')

    const body = await req.json().catch(() => ({}))
    switch (String(body?.action ?? '')) {
      case 'upload_url': {
        await exigirAcesso(org)
        return json(await uploadTarget(`${org}/broadcast/out-${crypto.randomUUID()}-${safeName(String(body?.name ?? 'arquivo'))}`))
      }
      case 'create': return json(await create(user.id, org, body))
      case 'cancel': return json(await cancel(org, body))
      default: throw new HttpError(400, 'Ação desconhecida')
    }
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status)
    console.error('[broadcast]', err)
    return json({ error: 'Erro interno. Tente de novo.' }, 500)
  }
})

async function exigirAcesso(org: string) {
  const acesso = await acessoDaOrganizacao(admin, org)
  if (acesso !== 'total') throw new HttpError(402, MSG_SEM_ACESSO[acesso] ?? MSG_SEM_ACESSO.bloqueado)
}

async function create(userId: string, org: string, body: Json) {
  await exigirAcesso(org)

  const name = String(body?.name ?? '').trim().slice(0, 80)
  if (name.length < 2) throw new HttpError(400, 'Dê um nome à campanha.')
  const kind = String(body?.kind ?? '')
  if (!KINDS.includes(kind)) throw new HttpError(400, 'Tipo de mensagem inválido.')
  const text = String(body?.body ?? '').trim()
  if (text.length > 4096) throw new HttpError(400, 'Mensagem longa demais (máx. 4096 caracteres).')
  if (kind === 'text' && !text) throw new HttpError(400, 'Escreva a mensagem.')

  // Anexo: tem que estar na pasta de envio em massa DESTA empresa.
  let media: { path: string; mime: string; name: string } | null = null
  if (kind !== 'text') {
    const path = String(body?.media?.path ?? '')
    const key = keyOf(path)
    if (!path || !key.startsWith(`${org}/broadcast/`) || key.includes('..')) throw new HttpError(400, 'Anexo inválido. Envie o arquivo de novo.')
    media = {
      path,
      mime: String(body?.media?.mime ?? 'application/octet-stream').slice(0, 120),
      name: String(body?.media?.name ?? 'arquivo').slice(0, 150),
    }
  }

  // Número: precisa ser da empresa, ligado ao atendimento e acessível a quem cria.
  const sessionId = String(body?.session_id ?? '')
  const { data: s } = await admin.from('whatsapp_sessions')
    .select('id, organization_id, chat_enabled').eq('id', sessionId).maybeSingle()
  if (!s || s.organization_id !== org || !s.chat_enabled) throw new HttpError(400, 'Escolha um número ligado ao atendimento.')
  const { data: temAcesso } = await admin.rpc('wa_user_has_session', { p_user: userId, p_session: s.id })
  if (temAcesso === false) throw new HttpError(403, 'Você não tem acesso a este número.')

  // Quando: vazio = agora.
  let quando = new Date()
  if (body?.scheduled_at) {
    quando = new Date(String(body.scheduled_at))
    if (!Number.isFinite(quando.getTime())) throw new HttpError(400, 'Data de agendamento inválida.')
    if (quando.getTime() < Date.now() - 60_000) throw new HttpError(400, 'A data do agendamento já passou.')
    if (quando.getTime() > Date.now() + 90 * 86_400_000) throw new HttpError(400, 'Agende para até 90 dias à frente.')
  }
  const delay = Math.min(120, Math.max(2, Math.round(Number(body?.delay_seconds ?? 6)) || 6))

  // Destinatários, sempre lidos da empresa (nunca confia na lista de ids da tela).
  const aud = body?.audience ?? {}
  const contatos: { id: string; name: string | null; phone: string | null }[] = []
  if (aud.mode === 'ids') {
    const ids = (Array.isArray(aud.ids) ? aud.ids : []).filter((x: unknown) => typeof x === 'string').slice(0, MAX_DESTINATARIOS * 2)
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await admin.from('crm_contacts').select('id, name, phone')
        .eq('organization_id', org).in('id', ids.slice(i, i + 200))
      contatos.push(...((data ?? []) as typeof contatos))
    }
  } else if (aud.mode === 'all') {
    for (let from = 0; contatos.length <= MAX_DESTINATARIOS * 2; from += 1000) {
      let q = admin.from('crm_contacts').select('id, name, phone').eq('organization_id', org).not('phone', 'is', null)
      if (typeof aud.stage_id === 'string' && aud.stage_id) q = q.eq('stage_id', aud.stage_id)
      if (Array.isArray(aud.tags) && aud.tags.length) q = q.contains('tags', aud.tags.map(String))
      const { data, error } = await q.order('id').range(from, from + 999)
      if (error) throw error
      contatos.push(...((data ?? []) as typeof contatos))
      if ((data ?? []).length < 1000) break
    }
  } else {
    throw new HttpError(400, 'Escolha quem vai receber.')
  }

  // Um envio por telefone; número inválido fica de fora (e a tela é avisada).
  const vistos = new Set<string>()
  const lista: { contact_id: string; name: string | null; phone: string }[] = []
  let semTelefone = 0
  for (const c of contatos) {
    const phone = normalizePhone(c.phone ?? '')
    if (phone.length < 10 || phone.length > 15) { semTelefone++; continue }
    if (vistos.has(phone)) continue
    vistos.add(phone)
    lista.push({ contact_id: c.id, name: c.name, phone })
  }
  if (lista.length === 0) throw new HttpError(400, 'Nenhum contato com telefone válido na seleção.')
  if (lista.length > MAX_DESTINATARIOS) throw new HttpError(400, `Máximo de ${MAX_DESTINATARIOS} contatos por campanha. Filtre ou divida a lista.`)

  const { data: b, error } = await admin.from('broadcasts').insert({
    organization_id: org, created_by: userId, session_id: s.id, name, kind,
    body: text || null,
    media_path: media?.path ?? null, media_mime: media?.mime ?? null, media_name: media?.name ?? null,
    delay_seconds: delay, scheduled_at: quando.toISOString(), total: lista.length,
  }).select('id').single()
  if (error || !b) throw new HttpError(500, 'Não foi possível criar a campanha.')

  for (let i = 0; i < lista.length; i += 500) {
    const { error: e2 } = await admin.from('broadcast_recipients').insert(
      lista.slice(i, i + 500).map((r) => ({ ...r, broadcast_id: b.id, organization_id: org })),
    )
    if (e2) {
      await admin.from('broadcasts').delete().eq('id', b.id)
      console.error('[broadcast] destinatários', e2.message)
      throw new HttpError(500, 'Não foi possível salvar a lista de contatos.')
    }
  }

  // Imediato: já aciona o envio, sem esperar o próximo minuto do cron.
  if (quando.getTime() <= Date.now() + 5_000) waitUntil(acionarEnvio())
  return { id: b.id, total: lista.length, sem_telefone: semTelefone }
}

async function cancel(org: string, body: Json) {
  const id = String(body?.id ?? '')
  const { data: b } = await admin.from('broadcasts').select('id, status').eq('id', id).eq('organization_id', org).maybeSingle()
  if (!b) throw new HttpError(404, 'Campanha não encontrada.')
  if (b.status !== 'agendada' && b.status !== 'enviando') throw new HttpError(400, 'Esta campanha já terminou.')
  await admin.from('broadcasts').update({ status: 'cancelada', finished_at: new Date().toISOString() }).eq('id', id)
  return { ok: true }
}

async function acionarEnvio() {
  // O banco chama o worker (pg_net); se falhar, o cron pega em até 1 minuto.
  await admin.rpc('broadcast_acionar').then(() => null, () => null)
}

function waitUntil(p: Promise<unknown>) {
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime
  if (rt?.waitUntil) rt.waitUntil(p)
}
