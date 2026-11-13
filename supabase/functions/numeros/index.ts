/**
 * Edge Function: numeros
 *
 * Os números de WhatsApp de cada usuário: criar, QR Code, status, reconectar,
 * desconectar e remover. Fala com o servidor de WhatsApp por dentro e devolve
 * ao painel SÓ o que a tela usa — nunca a resposta crua do servidor, nem os
 * caminhos dele. O navegador não tem como saber que servidor é esse.
 *
 * Ações (POST, corpo JSON):
 *   { action: 'create' }                         → { session, qr }
 *   { action: 'qr',         session_id }         → { qr, connected }
 *   { action: 'status',     session_id }         → { status }
 *   { action: 'reconnect' | 'disconnect' | 'remove', session_id } → { ok: true }
 * Erro: { error: 'mensagem em português' } com o status HTTP.
 *
 * QUEM PODE
 *   • Permissão perguntada ao banco (current_user_can): painel.numeros.editar
 *     para mexer, painel.numeros.ver para consultar o status.
 *   • O número tem que ser DO USUÁRIO (created_by) — ou sem dono, para o
 *     admin. O servidor de WhatsApp é compartilhado com outros sistemas (117):
 *     o nome da instância é gerado aqui e nenhuma existente é "adotada".
 *
 * Secrets: EVOLUTION_API_URL, EVOLUTION_API_KEY, INSTANCE_PREFIX (opcional)
 */

import { createClient } from 'npm:@supabase/supabase-js@2'
import QRCode from 'npm:qrcode@1.5.4'
import { autoEnableChat } from '../_shared/chatEnable.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
})

// deno-lint-ignore no-explicit-any
type Json = any

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

const FALHA_SERVIDOR = 'O WhatsApp não respondeu agora. Tente de novo em instantes.'

interface Sessao {
  id: string
  organization_id: string
  instance_name: string
  created_by: string | null
  phone_number: string | null
  status: string
  chat_enabled?: boolean
  chat_manual_off?: boolean
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

    const { data: profile } = await userClient
      .from('users')
      .select('organization_id, role')
      .eq('id', user.id)
      .single()
    if (!profile) throw new HttpError(403, 'Usuário sem acesso a esta organização')

    const body = await req.json().catch(() => ({}))
    const action = String(body?.action ?? '')
    const perm = action === 'status' ? 'painel.numeros.ver' : 'painel.numeros.editar'
    if (!['create', 'qr', 'status', 'reconnect', 'disconnect', 'remove'].includes(action)) {
      throw new HttpError(400, 'Ação desconhecida')
    }

    const { data: pode, error: permErro } = await userClient.rpc('current_user_can', { p_perm: perm })
    if (permErro) throw new HttpError(500, 'Falha ao verificar permissão')
    if (pode !== true) throw new HttpError(403, 'Seu perfil não tem permissão para gerenciar números')

    if (action === 'create') return json(await criar(profile.organization_id, user.id))

    const sessao = await sessaoDoUsuario(body?.session_id, profile, user.id)
    switch (action) {
      case 'qr': return json(await qr(sessao))
      case 'status': return json(await status(sessao))
      case 'reconnect': return json(await reconectar(sessao))
      case 'disconnect': return json(await desconectar(sessao))
      case 'remove': return json(await remover(sessao))
    }
    throw new HttpError(400, 'Ação desconhecida')
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status)
    console.error('[numeros]', err)
    return json({ error: 'Erro interno. Tente de novo.' }, 500)
  }
})

// ---------------------------------------------------------------------------

/** O número tem que ser deste usuário (ou sem dono, para o admin). */
async function sessaoDoUsuario(
  id: unknown,
  profile: { organization_id: string; role: string },
  userId: string,
): Promise<Sessao> {
  if (typeof id !== 'string' || !id) throw new HttpError(400, 'Número não informado')
  const { data } = await admin
    .from('whatsapp_sessions')
    .select('id, organization_id, instance_name, created_by, phone_number, status, chat_enabled, chat_manual_off')
    .eq('id', id)
    .maybeSingle<Sessao>()
  const dono = data && data.organization_id === profile.organization_id && (
    data.created_by === userId || (data.created_by === null && profile.role === 'admin')
  )
  if (!dono) throw new HttpError(404, 'Número não encontrado entre os seus')
  return data!
}

async function servidor(method: string, path: string, body?: unknown) {
  const base = (Deno.env.get('EVOLUTION_API_URL') ?? '').replace(/\/+$/, '')
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', apikey: Deno.env.get('EVOLUTION_API_KEY') ?? '' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    })
    let data: Json = null
    try { data = await res.json() } catch { /* sem corpo */ }
    return { ok: res.ok, status: res.status, data }
  } catch {
    return { ok: false, status: 0, data: null as Json }
  }
}

const inst = (s: Sessao) => encodeURIComponent(s.instance_name)

/**
 * O QR é desenhado aqui, nas cores da Infuse, a partir do código que o
 * servidor devolve (a imagem pronta dele tem a cor e o jeito dele). Sem o
 * código, vai a imagem do servidor mesmo.
 */
async function desenharQr(dados: Json): Promise<string | null> {
  const code = typeof dados?.code === 'string' ? dados.code : ''
  if (code) {
    try {
      return await QRCode.toDataURL(code, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 320,
        color: { dark: '#0b1b3a', light: '#ffffff' },
      })
    } catch { /* cai na imagem do servidor */ }
  }
  return typeof dados?.base64 === 'string' ? dados.base64 : null
}

function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Cria a instância com nome próprio e só então registra o número, já com
 * dono. Nome existente = sorteia outro; nunca reaproveita.
 */
async function criar(organizationId: string, userId: string) {
  const prefix = (Deno.env.get('INSTANCE_PREFIX') ?? 'infuse').toLowerCase().replace(/[^a-z0-9]/g, '') || 'inst'

  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const name = `${prefix}-${randomSuffix()}`

    // Já existe no servidor (de quem for)? Então não é nosso: outro nome.
    const existe = await servidor('GET', `/instance/connectionState/${name}`)
    if (existe.ok) continue

    const created = await servidor('POST', '/instance/create', {
      instanceName: name,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    })
    if (!created.ok) {
      // 403/409 = o nome apareceu entre a consulta e a criação. Outro nome.
      if (created.status === 403 || created.status === 409) continue
      throw new HttpError(502, 'Não foi possível criar o número agora. Tente de novo.')
    }

    const { data: session, error } = await admin.from('whatsapp_sessions').insert({
      organization_id: organizationId,
      instance_name: name,
      created_by: userId,
      status: 'connecting',
    }).select().single()

    if (error) {
      // Não deixa instância órfã no servidor compartilhado.
      await servidor('DELETE', `/instance/delete/${name}`)
      throw new HttpError(500, 'Falha ao registrar o número')
    }

    // O número já nasce no atendimento: não depende de ninguém ligar depois.
    await autoEnableChat(admin, servidor, { id: session.id, instance_name: name })
    return { session: { ...session, chat_enabled: true }, qr: await desenharQr(created.data?.qrcode) }
  }

  throw new HttpError(409, 'Não foi possível gerar um nome livre para o número. Tente de novo.')
}

/** QR Code para conectar. Já conectado = sem QR. */
async function qr(s: Sessao) {
  const res = await servidor('GET', `/instance/connect/${inst(s)}`)
  if (!res.ok) throw new HttpError(502, 'Não foi possível gerar o QR Code. Tente de novo.')
  const conectado = res.data?.instance?.state === 'open'
  return { qr: conectado ? null : await desenharQr(res.data), connected: conectado }
}

/** Estado real do número; grava no banco (e o telefone, na 1ª conexão). */
async function status(s: Sessao) {
  const res = await servidor('GET', `/instance/connectionState/${inst(s)}`)
  const state = res.data?.instance?.state
  const novo = !res.ok ? 'error' : state === 'open' ? 'connected' : state === 'connecting' ? 'connecting' : 'disconnected'

  const patch: Record<string, unknown> = { status: novo, last_seen_at: new Date().toISOString() }
  // Conectou e ainda não sabemos o telefone: o nome é gerado, então o
  // telefone é o que o usuário reconhece na lista.
  if (novo === 'connected' && !s.phone_number) {
    const phone = await telefone(s.instance_name)
    if (phone) patch.phone_number = phone
  }
  await admin.from('whatsapp_sessions').update(patch).eq('id', s.id)
  // Conectou e ainda não está no atendimento (número criado antes desta regra):
  // liga sozinho, a menos que a instância tenha o webhook de outro sistema.
  if (novo === 'connected' && !s.chat_enabled) await autoEnableChat(admin, servidor, s)
  return { status: novo }
}

async function reconectar(s: Sessao) {
  const res = await servidor('POST', `/instance/restart/${inst(s)}`)
  if (!res.ok && res.status !== 404) throw new HttpError(502, FALHA_SERVIDOR)
  await admin.from('whatsapp_sessions').update({ status: 'connecting' }).eq('id', s.id)
  return { ok: true }
}

/**
 * Desconecta de verdade (logout): o aparelho sai de "Aparelhos conectados"
 * e o QR volta a ser emitido. O número continua cadastrado.
 */
async function desconectar(s: Sessao) {
  const res = await servidor('DELETE', `/instance/logout/${inst(s)}`)
  // 400/404 = já estava desconectado; o objetivo está cumprido.
  if (!res.ok && res.status !== 400 && res.status !== 404) throw new HttpError(502, FALHA_SERVIDOR)
  await admin.from('whatsapp_sessions')
    .update({ status: 'disconnected', last_seen_at: new Date().toISOString() })
    .eq('id', s.id)
  return { ok: true }
}

/**
 * Remove de vez: apaga a instância (o que desconecta o aparelho) e o número
 * do painel. "Tirar só do painel" deixaria uma instância órfã no servidor
 * compartilhado, conectada ao celular do cliente.
 */
async function remover(s: Sessao) {
  const res = await servidor('DELETE', `/instance/delete/${inst(s)}`)
  if (!res.ok && res.status !== 404) throw new HttpError(502, FALHA_SERVIDOR)
  const { error } = await admin.from('whatsapp_sessions').delete().eq('id', s.id)
  if (error) throw new HttpError(500, 'Falha ao remover o número')
  return { ok: true }
}

/** Telefone do número conectado, perguntado só para esta instância. */
async function telefone(instance: string): Promise<string | null> {
  const res = await servidor('GET', `/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`)
  const list: Json[] = Array.isArray(res.data) ? res.data : []
  // Filtra de novo pelo nome: versões antigas ignoram o parâmetro e devolvem
  // todas as instâncias do servidor.
  const mine = list.find((i) => (i?.name ?? i?.instance?.instanceName) === instance)
  const jid = String(mine?.ownerJid ?? mine?.instance?.owner ?? '')
  const digits = jid.split('@')[0].replace(/\D/g, '')
  return digits.length >= 10 ? digits : null
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

