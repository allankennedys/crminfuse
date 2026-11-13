/**
 * Edge Function: invite
 *
 * Convites para entrar numa organização. Só o administrador cria; quem recebe
 * aceita pelo link (sem login).
 *
 *   JWT de administrador:
 *     { action: 'create', role: 'atendente'|'admin', email?, permissions? } → { url, email_sent }
 *     { action: 'list' }                                                      → { invites }
 *     { action: 'revoke', id }                                                → { ok }
 *   Público (o código do link é o segredo):
 *     { action: 'info', token }                                  → { organization, role }
 *     { action: 'accept', token, full_name, username, password } → { ok, username }
 *
 * Secrets opcionais para enviar o convite por e-mail: RESEND_API_KEY e
 * MAIL_FROM (ex.: "Infuse <convites@seudominio.com>"). Sem eles, o link só é
 * mostrado ao administrador para ele mandar como quiser.
 */
import { createClient } from 'npm:@supabase/supabase-js@2'
import { acessoDaOrganizacao, MSG_SEM_ACESSO } from '../_shared/assinatura.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
}
const AUTH_EMAIL_DOMAIN = 'infuse.local'
const APP_URL_FIXO = (Deno.env.get('APP_URL') ?? '').replace(/\/+$/, '')

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
})

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

async function sha256(texto: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function novoCodigo(): string {
  const b = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** O convite válido (existe, não usado, não revogado, não vencido) ou erro em português. */
async function convitePorCodigo(token: string) {
  if (token.length < 20) throw new HttpError(404, 'Convite inválido.')
  const { data: inv } = await admin
    .from('invitations')
    .select('id, organization_id, role, email, permissions, expires_at, used_at, revoked_at, organizations(name)')
    .eq('token_hash', await sha256(token))
    .maybeSingle()
  if (!inv) throw new HttpError(404, 'Convite inválido.')
  if (inv.revoked_at) throw new HttpError(410, 'Este convite foi cancelado. Peça um novo ao administrador.')
  if (inv.used_at) throw new HttpError(410, 'Este convite já foi usado.')
  if (new Date(inv.expires_at).getTime() < Date.now()) throw new HttpError(410, 'Este convite venceu. Peça um novo ao administrador.')
  return inv
}

async function enviarEmail(para: string, orgNome: string, url: string, base: string): Promise<boolean> {
  const key = Deno.env.get('RESEND_API_KEY') ?? ''
  const from = Deno.env.get('MAIL_FROM') ?? ''
  if (!key || !from) return false
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
  const org = esc(orgNome)
  const link = esc(url)
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border-radius:14px;border:1px solid #e3e6ec;">
      <tr><td style="padding:28px 32px 8px;">
        <img src="${esc(base)}/logo-navy.png" alt="Infuse" height="30" style="display:block;height:30px;border:0;">
      </td></tr>
      <tr><td style="padding:8px 32px 0;font-family:Arial,Helvetica,sans-serif;color:#0b1b3a;">
        <h1 style="font-size:20px;line-height:1.3;margin:12px 0 10px;">Você foi convidado</h1>
        <p style="font-size:15px;line-height:1.55;margin:0 0 18px;color:#3b4660;">
          Você foi convidado para entrar em <strong style="color:#0b1b3a;">${org}</strong> no Infuse CRM.
          Clique no botão para escolher seu usuário e senha.
        </p>
      </td></tr>
      <tr><td style="padding:0 32px 8px;">
        <a href="${link}" style="display:inline-block;background:#1f6fe0;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:9px;">Aceitar convite</a>
      </td></tr>
      <tr><td style="padding:16px 32px 28px;font-family:Arial,Helvetica,sans-serif;font-size:12.5px;line-height:1.5;color:#6b7690;">
        O link vale por 7 dias e só pode ser usado uma vez. Se o botão não abrir, copie este endereço no navegador:<br>
        <span style="word-break:break-all;color:#1f6fe0;">${link}</span>
      </td></tr>
    </table>
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:11.5px;color:#8a93a8;margin:14px 0 0;">
      Você recebeu este e-mail porque alguém da empresa ${org} convidou este endereço. Se não esperava, ignore.
    </p>
  </td></tr>
</table></body></html>`
  const text = `Você foi convidado para entrar em ${orgNome} no Infuse CRM.\n\nAceite o convite aqui: ${url}\n\nO link vale por 7 dias e só pode ser usado uma vez. Se você não esperava este convite, ignore este e-mail.`
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [para], subject: `Você foi convidado para ${orgNome} no Infuse CRM`, html, text }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null)
  if (!res?.ok) console.error('[invite] resend', res?.status, await res?.text().catch(() => ''))
  return Boolean(res?.ok)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  try {
    const body = await req.json().catch(() => ({}))
    const action = String(body?.action ?? '')

    // ---------- Público ----------
    if (action === 'info') {
      const inv = await convitePorCodigo(String(body?.token ?? ''))
      // deno-lint-ignore no-explicit-any
      const org = (inv as any).organizations
      return json({ organization: (Array.isArray(org) ? org[0]?.name : org?.name) ?? '', role: inv.role })
    }

    if (action === 'accept') {
      const inv = await convitePorCodigo(String(body?.token ?? ''))
      const fullName = String(body?.full_name ?? '').trim()
      const username = String(body?.username ?? '').trim().toLowerCase()
      const password = String(body?.password ?? '')
      if (fullName.length < 2 || fullName.length > 80) throw new HttpError(400, 'Informe o seu nome.')
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new HttpError(400, 'Usuário: 3 a 30 caracteres, só letras, números, ponto, hífen ou underline.')
      if (password.length < 8) throw new HttpError(400, 'A senha precisa ter ao menos 8 caracteres.')

      const acesso = await acessoDaOrganizacao(admin, inv.organization_id)
      if (acesso !== 'total') throw new HttpError(402, 'A assinatura desta empresa não está em dia. Avise o administrador.')

      // Reserva o convite antes de criar a conta: dois cliques não usam o mesmo link duas vezes.
      const { data: reservado } = await admin
        .from('invitations').update({ used_at: new Date().toISOString() })
        .eq('id', inv.id).is('used_at', null).is('revoked_at', null).select('id')
      if (!reservado?.length) throw new HttpError(410, 'Este convite já foi usado.')

      const desfazer = async () => { await admin.from('invitations').update({ used_at: null }).eq('id', inv.id) }

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email: `${username}@${AUTH_EMAIL_DOMAIN}`,
        password,
        email_confirm: true,
        user_metadata: { username, full_name: fullName },
      })
      if (createErr || !created?.user) {
        await desfazer()
        const jaExiste = /already been registered|already exists|duplicate/i.test(createErr?.message ?? '')
        throw new HttpError(400, jaExiste ? 'Esse nome de usuário já está em uso. Escolha outro.' : 'Não foi possível criar a conta.')
      }
      const newId = created.user.id

      // O gatilho criou uma organização própria para o usuário novo: guarda o id
      // para apagar depois que ele for movido para a organização do convite.
      const { data: fresh } = await admin.from('users').select('organization_id').eq('id', newId).maybeSingle()
      const orfa = fresh?.organization_id as string | undefined

      const { error: updErr } = await admin.from('users').update({
        organization_id: inv.organization_id,
        role: inv.role,
        ...(inv.permissions && inv.role !== 'admin' ? { permissions: inv.permissions } : {}),
      }).eq('id', newId)
      if (updErr) {
        await admin.auth.admin.deleteUser(newId)
        if (orfa && orfa !== inv.organization_id) await admin.from('organizations').delete().eq('id', orfa)
        await desfazer()
        if (/Limite de usuários/.test(updErr.message ?? '')) throw new HttpError(402, 'A empresa atingiu o limite de usuários do plano. Avise o administrador.')
        throw new HttpError(500, 'Não foi possível entrar na empresa.')
      }

      if (orfa && orfa !== inv.organization_id) {
        const { count } = await admin.from('users').select('id', { count: 'exact', head: true }).eq('organization_id', orfa)
        if ((count ?? 0) === 0) await admin.from('organizations').delete().eq('id', orfa)
      }
      await admin.from('invitations').update({ used_by: newId }).eq('id', inv.id)
      return json({ ok: true, username })
    }

    // ---------- Administrador ----------
    const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
      auth: { persistSession: false },
    })
    const { data: { user } } = await userClient.auth.getUser()
    if (!user) throw new HttpError(401, 'Não autenticado')
    const { data: perfil } = await userClient.from('users').select('organization_id, role, is_active').eq('id', user.id).single()
    if (!perfil?.is_active || perfil.role !== 'admin') throw new HttpError(403, 'Só administradores gerenciam convites')
    const org = perfil.organization_id as string

    if (action === 'list') {
      const { data } = await admin
        .from('invitations')
        .select('id, role, email, created_at, expires_at')
        .eq('organization_id', org).is('used_at', null).is('revoked_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
      return json({ invites: data ?? [] })
    }

    if (action === 'revoke') {
      const { error } = await admin.from('invitations').update({ revoked_at: new Date().toISOString() })
        .eq('id', String(body?.id ?? '')).eq('organization_id', org).is('used_at', null)
      if (error) throw new HttpError(500, 'Falha ao cancelar o convite.')
      return json({ ok: true })
    }

    if (action === 'create') {
      const role = body?.role === 'admin' ? 'admin' : 'atendente'
      const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'E-mail inválido.')
      const permissions = Array.isArray(body?.permissions) && role !== 'admin'
        ? (body.permissions as unknown[]).filter((p): p is string => typeof p === 'string').slice(0, 200)
        : null

      const acesso = await acessoDaOrganizacao(admin, org)
      if (acesso !== 'total') throw new HttpError(402, MSG_SEM_ACESSO[acesso] ?? MSG_SEM_ACESSO.bloqueado)

      // O limite do plano conta todos os usuários (administradores inclusive) e os convites pendentes.
      const { data: ass } = await admin.from('subscriptions').select('plans(max_agents)').eq('organization_id', org).maybeSingle()
      // deno-lint-ignore no-explicit-any
      const max = (ass as any)?.plans?.max_agents as number | undefined
      if (max !== undefined) {
        const { data: uso } = await admin.rpc('org_uso', { p_org: org })
        const { count: pend } = await admin.from('invitations').select('id', { count: 'exact', head: true })
          .eq('organization_id', org).is('used_at', null).is('revoked_at', null).gt('expires_at', new Date().toISOString())
        const total = (uso?.agents ?? 0) + (pend ?? 0)
        if (total >= max) {
          throw new HttpError(402, `Limite de usuários do seu plano atingido (${total} de ${max}, contando convites pendentes). Faça upgrade em Configurações → Plano e cobrança.`)
        }
      }

      const token = novoCodigo()
      const { error } = await admin.from('invitations').insert({
        organization_id: org, role, email: email || null, permissions, token_hash: await sha256(token), created_by: user.id,
      })
      if (error) throw new HttpError(500, 'Falha ao criar o convite.')

      // Endereço do app: o secret APP_URL, ou o de onde o administrador está acessando.
      const base = APP_URL_FIXO || (req.headers.get('origin') ?? '').replace(/\/+$/, '')
      if (!base) throw new HttpError(500, 'Endereço do sistema não configurado (secret APP_URL).')
      const url = `${base}/convite/${token}`
      let emailSent = false
      if (email) {
        const { data: o } = await admin.from('organizations').select('name').eq('id', org).maybeSingle()
        emailSent = await enviarEmail(email, o?.name ?? 'sua empresa', url, base)
      }
      return json({ url, email_sent: emailSent })
    }

    throw new HttpError(400, 'Ação desconhecida')
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status)
    console.error('[invite]', err instanceof Error ? err.message : err)
    return json({ error: 'Erro interno. Tente de novo.' }, 500)
  }
})
