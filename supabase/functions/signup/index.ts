/**
 * Edge Function: signup  (pública, sem JWT)
 *
 * Cadastro de uma organização nova: cria o usuário administrador (o gatilho
 * handle_new_user cria a organização e a assinatura de teste de 7 dias) e grava
 * o plano escolhido e os dados de cobrança. O app entra em seguida com o
 * usuário e a senha escolhidos.
 *
 * Proteções: honeypot, no máximo 5 cadastros por hora por IP, validação de
 * CPF/CNPJ (dígitos verificadores) e de e-mail.
 *
 *   { organization_name, full_name, username, password, email, doc, plan_id, website }
 */
import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
}
const AUTH_EMAIL_DOMAIN = 'infuse.local'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

function cpfValido(d: string): boolean {
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false
  const dv = (base: string, pesoInicial: number) => {
    let soma = 0
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (pesoInicial - i)
    const r = (soma * 10) % 11
    return r === 10 ? 0 : r
  }
  return dv(d.slice(0, 9), 10) === Number(d[9]) && dv(d.slice(0, 10), 11) === Number(d[10])
}

function cnpjValido(d: string): boolean {
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false
  const dv = (base: string) => {
    const pesos = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    const soma = [...base].reduce((s, c, i) => s + Number(c) * pesos[i], 0)
    const r = soma % 11
    return r < 2 ? 0 : 11 - r
  }
  return dv(d.slice(0, 12)) === Number(d[12]) && dv(d.slice(0, 13)) === Number(d[13])
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  try {
    const body = await req.json().catch(() => ({}))

    // Robô preenche o campo escondido; gente não.
    if (typeof body?.website === 'string' && body.website.trim() !== '') return json({ ok: true })

    const organizationName = String(body?.organization_name ?? '').trim()
    const fullName = String(body?.full_name ?? '').trim()
    const username = String(body?.username ?? '').trim().toLowerCase()
    const password = String(body?.password ?? '')
    const email = String(body?.email ?? '').trim().toLowerCase()
    const doc = String(body?.doc ?? '').replace(/\D/g, '')
    const planId = String(body?.plan_id ?? '')

    if (organizationName.length < 2 || organizationName.length > 80) return json({ error: 'Informe o nome da empresa (2 a 80 letras).' }, 400)
    if (fullName.length < 2 || fullName.length > 80) return json({ error: 'Informe o seu nome.' }, 400)
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return json({ error: 'Usuário: 3 a 30 caracteres, só letras, números, ponto, hífen ou underline.' }, 400)
    if (password.length < 8) return json({ error: 'A senha precisa ter ao menos 8 caracteres.' }, 400)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: 'E-mail inválido.' }, 400)
    if (!(cpfValido(doc) || cnpjValido(doc))) return json({ error: 'CPF ou CNPJ inválido.' }, 400)

    // Freio por IP.
    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'desconhecido'
    const desde = new Date(Date.now() - 3600_000).toISOString()
    const { count } = await admin.from('signup_attempts').select('id', { count: 'exact', head: true }).eq('ip', ip).gte('created_at', desde)
    if ((count ?? 0) >= 5) return json({ error: 'Muitas tentativas. Tente de novo mais tarde.' }, 429)
    await admin.from('signup_attempts').insert({ ip })
    await admin.from('signup_attempts').delete().lt('created_at', new Date(Date.now() - 86_400_000).toISOString())

    const { data: plano } = await admin.from('plans').select('id').eq('id', planId).eq('active', true).maybeSingle()

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: `${username}@${AUTH_EMAIL_DOMAIN}`,
      password,
      email_confirm: true,
      user_metadata: { username, full_name: fullName, organization_name: organizationName },
    })
    if (createErr || !created?.user) {
      const jaExiste = /already been registered|already exists|duplicate/i.test(createErr?.message ?? '')
      if (!jaExiste) console.error('[signup]', createErr?.message)
      return json({ error: jaExiste ? 'Esse nome de usuário já está em uso.' : 'Não foi possível criar a conta. Tente de novo.' }, 400)
    }

    // O gatilho já criou a organização e a assinatura de teste; aqui entram o plano e a cobrança.
    const { data: perfil } = await admin.from('users').select('organization_id').eq('id', created.user.id).maybeSingle()
    if (perfil?.organization_id) {
      await admin.from('subscriptions').update({
        ...(plano ? { plan_id: plano.id } : {}),
        billing_name: organizationName,
        billing_email: email,
        billing_doc: doc,
        updated_at: new Date().toISOString(),
      }).eq('organization_id', perfil.organization_id)
    }

    return json({ ok: true, username })
  } catch (err) {
    console.error('[signup]', err instanceof Error ? err.message : err)
    return json({ error: 'Erro interno. Tente de novo.' }, 500)
  }
})
