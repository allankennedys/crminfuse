/**
 * Edge Function: auth-email  (pública; change_email exige login)
 *
 * Verificação de e-mail, recuperação de senha e troca de e-mail de acesso, com
 * e-mails na identidade da Infuse (Resend, domínio da Infuse).
 *
 *   { action: 'send_verification', email }         → { ok }  reenvia o e-mail de verificação
 *   { action: 'verify', token }                    → { ok, email }
 *   { action: 'request_reset', email }             → { ok }  sempre ok (não revela se o e-mail existe)
 *   { action: 'reset', token, password }           → { ok }
 *   { action: 'change_email', new_email }  (JWT)   → { ok }  envia confirmação para o endereço NOVO
 *   { action: 'confirm_email_change', token }      → { ok, email }
 */
import { createClient } from 'npm:@supabase/supabase-js@2'
import { enviarEmailMarca, novoCodigo, sha256 } from '../_shared/email.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
}
const APP_URL_FIXO = (Deno.env.get('APP_URL') ?? '').replace(/\/+$/, '')
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
})

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

/** Freio por IP (tabela do cadastro): `chave` separa os usos. */
async function freioIp(req: Request, chave: string, max: number) {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'desconhecido'
  const marca = `${chave}:${ip}`
  const { count } = await admin.from('signup_attempts').select('id', { count: 'exact', head: true })
    .eq('ip', marca).gte('created_at', new Date(Date.now() - 3600_000).toISOString())
  if ((count ?? 0) >= max) throw new HttpError(429, 'Muitas tentativas. Tente de novo mais tarde.')
  await admin.from('signup_attempts').insert({ ip: marca })
}

async function usuarioPorEmail(email: string) {
  const { data } = await admin.from('users').select('id, email, full_name, is_active').ilike('email', email).maybeSingle()
  return data
}

/** Cria o token e devolve o código (que vai no link). Só um token ativo por tipo e usuário. */
async function criarToken(userId: string, kind: 'verify' | 'reset' | 'email_change', horas: number, newEmail?: string) {
  await admin.from('auth_tokens').update({ used_at: new Date().toISOString() })
    .eq('user_id', userId).eq('kind', kind).is('used_at', null)
  const codigo = novoCodigo()
  const { error } = await admin.from('auth_tokens').insert({
    user_id: userId, kind, token_hash: await sha256(codigo), new_email: newEmail ?? null,
    expires_at: new Date(Date.now() + horas * 3600_000).toISOString(),
  })
  if (error) throw new HttpError(500, 'Não foi possível gerar o link.')
  return codigo
}

/** Quantos tokens deste tipo o usuário pediu na última hora (freio por conta). */
async function pedidosRecentes(userId: string, kind: string) {
  const { count } = await admin.from('auth_tokens').select('id', { count: 'exact', head: true })
    .eq('user_id', userId).eq('kind', kind).gte('created_at', new Date(Date.now() - 3600_000).toISOString())
  return count ?? 0
}

async function tokenValido(codigo: string, kind: string) {
  if (codigo.length < 20) throw new HttpError(404, 'Link inválido.')
  const { data: t } = await admin.from('auth_tokens').select('id, user_id, new_email, expires_at, used_at')
    .eq('token_hash', await sha256(codigo)).eq('kind', kind).maybeSingle()
  if (!t) throw new HttpError(404, 'Link inválido.')
  if (t.used_at) throw new HttpError(410, 'Este link já foi usado.')
  if (new Date(t.expires_at).getTime() < Date.now()) throw new HttpError(410, 'Este link venceu. Peça um novo.')
  return t
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  try {
    const body = await req.json().catch(() => ({}))
    const action = String(body?.action ?? '')
    const base = APP_URL_FIXO || (req.headers.get('origin') ?? '').replace(/\/+$/, '')
    if (!base) throw new HttpError(500, 'Endereço do sistema não configurado (secret APP_URL).')

    // ---------- Verificação do e-mail do cadastro ----------
    if (action === 'send_verification') {
      await freioIp(req, 'verif', 10)
      const email = String(body?.email ?? '').trim().toLowerCase()
      if (!EMAIL_RE.test(email)) return json({ ok: true })
      const u = await usuarioPorEmail(email)
      if (u) {
        const { data: au } = await admin.auth.admin.getUserById(u.id)
        if (au?.user && !au.user.email_confirmed_at && (await pedidosRecentes(u.id, 'verify')) < 3) {
          const codigo = await criarToken(u.id, 'verify', 24)
          await enviarEmailMarca({
            to: email, base,
            subject: 'Confirme seu e-mail no Infuse CRM',
            titulo: 'Confirme seu e-mail',
            paragrafos: [`Olá${u.full_name ? `, ${u.full_name}` : ''}! Falta só confirmar que este e-mail é seu para começar a usar o Infuse CRM.`],
            botao: { texto: 'Confirmar e-mail', url: `${base}/verificar-email/${codigo}` },
            rodape: 'O link vale por 24 horas e só pode ser usado uma vez.',
            aviso: 'Você recebeu este e-mail porque alguém criou uma conta no Infuse CRM com este endereço. Se não foi você, ignore.',
          })
        }
      }
      return json({ ok: true })
    }

    if (action === 'verify') {
      const t = await tokenValido(String(body?.token ?? ''), 'verify')
      const { error } = await admin.auth.admin.updateUserById(t.user_id, { email_confirm: true })
      if (error) throw new HttpError(500, 'Não foi possível confirmar o e-mail.')
      await admin.from('auth_tokens').update({ used_at: new Date().toISOString() }).eq('id', t.id)
      const { data: au } = await admin.auth.admin.getUserById(t.user_id)
      return json({ ok: true, email: au?.user?.email ?? '' })
    }

    // ---------- Recuperação de senha ----------
    if (action === 'request_reset') {
      await freioIp(req, 'reset', 10)
      const email = String(body?.email ?? '').trim().toLowerCase()
      if (EMAIL_RE.test(email)) {
        const u = await usuarioPorEmail(email)
        // Conta antiga com e-mail interno (@infuse.local) não tem caixa de entrada: nada a enviar.
        if (u && u.is_active && (await pedidosRecentes(u.id, 'reset')) < 3) {
          const codigo = await criarToken(u.id, 'reset', 1)
          await enviarEmailMarca({
            to: email, base,
            subject: 'Redefinir sua senha no Infuse CRM',
            titulo: 'Redefinir sua senha',
            paragrafos: ['Recebemos um pedido para redefinir a senha da sua conta no Infuse CRM. Clique no botão para escolher uma senha nova.'],
            botao: { texto: 'Escolher nova senha', url: `${base}/redefinir-senha/${codigo}` },
            rodape: 'O link vale por 1 hora e só pode ser usado uma vez.',
            aviso: 'Se você não pediu isso, ignore este e-mail: a sua senha continua a mesma.',
          })
        }
      }
      return json({ ok: true })
    }

    if (action === 'reset') {
      const password = String(body?.password ?? '')
      if (password.length < 8) throw new HttpError(400, 'A senha precisa ter ao menos 8 caracteres.')
      const t = await tokenValido(String(body?.token ?? ''), 'reset')
      // Quem recebeu o link na caixa de entrada provou que o e-mail é dele.
      const { error } = await admin.auth.admin.updateUserById(t.user_id, { password, email_confirm: true })
      if (error) throw new HttpError(500, 'Não foi possível trocar a senha.')
      await admin.from('auth_tokens').update({ used_at: new Date().toISOString() }).eq('user_id', t.user_id).eq('kind', 'reset').is('used_at', null)
      return json({ ok: true })
    }

    // ---------- Troca do e-mail de acesso ----------
    if (action === 'change_email') {
      const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
        auth: { persistSession: false },
      })
      const { data: { user } } = await userClient.auth.getUser()
      if (!user) throw new HttpError(401, 'Não autenticado')
      const novo = String(body?.new_email ?? '').trim().toLowerCase()
      if (!EMAIL_RE.test(novo) || novo.endsWith('@infuse.local')) throw new HttpError(400, 'E-mail inválido.')
      if (await usuarioPorEmail(novo)) throw new HttpError(409, 'Este e-mail já tem uma conta.')
      if ((await pedidosRecentes(user.id, 'email_change')) >= 3) throw new HttpError(429, 'Muitas tentativas. Tente de novo mais tarde.')
      const codigo = await criarToken(user.id, 'email_change', 24, novo)
      const ok = await enviarEmailMarca({
        to: novo, base,
        subject: 'Confirme o novo e-mail da sua conta no Infuse CRM',
        titulo: 'Confirme seu novo e-mail',
        paragrafos: ['Você pediu para usar este endereço para entrar no Infuse CRM. Confirme para concluir a troca.'],
        botao: { texto: 'Confirmar novo e-mail', url: `${base}/confirmar-email/${codigo}` },
        rodape: 'O link vale por 24 horas e só pode ser usado uma vez.',
        aviso: 'Se você não pediu isso, ignore este e-mail: nada muda na conta.',
      })
      if (!ok) throw new HttpError(502, 'Não foi possível enviar o e-mail agora. Tente de novo.')
      return json({ ok: true })
    }

    if (action === 'confirm_email_change') {
      const t = await tokenValido(String(body?.token ?? ''), 'email_change')
      const novo = String(t.new_email ?? '').toLowerCase()
      if (!novo) throw new HttpError(400, 'Link inválido.')
      if (await usuarioPorEmail(novo)) throw new HttpError(409, 'Este e-mail já tem uma conta.')
      const { error } = await admin.auth.admin.updateUserById(t.user_id, { email: novo, email_confirm: true })
      if (error) throw new HttpError(500, 'Não foi possível trocar o e-mail.')
      await admin.from('users').update({ email: novo, username: novo }).eq('id', t.user_id)
      await admin.from('auth_tokens').update({ used_at: new Date().toISOString() }).eq('id', t.id)
      return json({ ok: true, email: novo })
    }

    throw new HttpError(400, 'Ação desconhecida')
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status)
    console.error('[auth-email]', err instanceof Error ? err.message : err)
    return json({ error: 'Erro interno. Tente de novo.' }, 500)
  }
})
