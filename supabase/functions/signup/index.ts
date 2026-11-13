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
 *   { organization_name, full_name, password, email, doc, plan_id, website }
 *
 * O login é o e-mail. A conta nasce SEM e-mail confirmado: só entra depois de
 * clicar no link enviado (verificação). O e-mail sai do domínio da Infuse.
 */
import { createClient } from 'npm:@supabase/supabase-js@2'
import { enviarEmailMarca, novoCodigo, sha256 } from '../_shared/email.ts'
import { cnpjValido, cpfValido } from '../_shared/doc.ts'
import { usuarioGoogle } from '../_shared/google.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
}
const APP_URL_FIXO = (Deno.env.get('APP_URL') ?? '').replace(/\/+$/, '')

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  try {
    const body = await req.json().catch(() => ({}))

    // Robô preenche o campo escondido; gente não.
    if (typeof body?.website === 'string' && body.website.trim() !== '') return json({ ok: true })

    // Cadastro de empresa por quem entrou com o Google: a conta já existe (sem organização).
    const viaGoogle = body?.action === 'google'
    const organizationName = String(body?.organization_name ?? '').trim()
    const fullName = String(body?.full_name ?? '').trim()
    const password = String(body?.password ?? '')
    let email = String(body?.email ?? '').trim().toLowerCase()
    let googleUser: Awaited<ReturnType<typeof usuarioGoogle>> | null = null
    if (viaGoogle) {
      try { googleUser = await usuarioGoogle(req, admin) } catch (e) { return json({ error: e instanceof Error ? e.message : 'Não autenticado.' }, 400) }
      email = googleUser.email
    }
    const doc = String(body?.doc ?? '').replace(/\D/g, '')
    const planId = String(body?.plan_id ?? '')

    if (organizationName.length < 2 || organizationName.length > 80) return json({ error: 'Informe o nome da empresa (2 a 80 letras).' }, 400)
    if (fullName.length < 2 || fullName.length > 80) return json({ error: 'Informe o seu nome.' }, 400)
    if (!viaGoogle && password.length < 8) return json({ error: 'A senha precisa ter ao menos 8 caracteres.' }, 400)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.endsWith('@infuse.local')) return json({ error: 'E-mail inválido.' }, 400)
    if (!(cpfValido(doc) || cnpjValido(doc))) return json({ error: 'CPF ou CNPJ inválido.' }, 400)

    // Freio por IP.
    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'desconhecido'
    const desde = new Date(Date.now() - 3600_000).toISOString()
    const { count } = await admin.from('signup_attempts').select('id', { count: 'exact', head: true }).eq('ip', ip).gte('created_at', desde)
    if ((count ?? 0) >= 5) return json({ error: 'Muitas tentativas. Tente de novo mais tarde.' }, 429)
    await admin.from('signup_attempts').insert({ ip })
    await admin.from('signup_attempts').delete().lt('created_at', new Date(Date.now() - 86_400_000).toISOString())

    const { data: plano } = await admin.from('plans').select('id').eq('id', planId).eq('active', true).maybeSingle()

    if (viaGoogle && googleUser) {
      const { data: org, error: orgErr } = await admin.from('organizations').insert({ name: organizationName }).select('id').single()
      if (orgErr || !org) { console.error('[signup google] org', orgErr?.message); return json({ error: 'Não foi possível criar a conta. Tente de novo.' }, 500) }
      const { error: perfErr } = await admin.from('users').insert({
        id: googleUser.id, organization_id: org.id, email, username: email, full_name: fullName, role: 'admin',
      })
      if (perfErr) {
        console.error('[signup google] perfil', perfErr.message)
        await admin.from('organizations').delete().eq('id', org.id)
        return json({ error: 'Não foi possível criar a conta. Tente de novo.' }, 500)
      }
      await admin.from('subscriptions').update({
        ...(plano ? { plan_id: plano.id } : {}),
        billing_name: organizationName, billing_email: email, billing_doc: doc, updated_at: new Date().toISOString(),
      }).eq('organization_id', org.id)
      return json({ ok: true })
    }

    // O e-mail é o login. "username" guarda o próprio e-mail (único) por compatibilidade.
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
      // Marca de "criado pelo servidor": o banco recusa cadastro direto sem ela (153).
      app_metadata: { servidor: true },
      user_metadata: { username: email, full_name: fullName, organization_name: organizationName },
    })
    if (createErr || !created?.user) {
      const jaExiste = /already been registered|already exists|duplicate/i.test(createErr?.message ?? '')
      if (!jaExiste) console.error('[signup]', createErr?.message)
      return json({ error: jaExiste ? 'Este e-mail já tem uma conta. Entre ou use "Esqueci minha senha".' : 'Não foi possível criar a conta. Tente de novo.' }, 400)
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

    // E-mail de verificação (a conta só entra depois de confirmar).
    const base = APP_URL_FIXO || (req.headers.get('origin') ?? '').replace(/\/+$/, '')
    let emailSent = false
    if (base) {
      const codigo = novoCodigo()
      await admin.from('auth_tokens').insert({
        user_id: created.user.id, kind: 'verify', token_hash: await sha256(codigo),
        expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
      })
      emailSent = await enviarEmailMarca({
        to: email, base,
        subject: 'Confirme seu e-mail no Infuse CRM',
        titulo: 'Confirme seu e-mail',
        paragrafos: [`Olá, ${fullName}! Sua conta da empresa ${organizationName} foi criada. Falta só confirmar que este e-mail é seu para começar o teste grátis.`],
        botao: { texto: 'Confirmar e-mail', url: `${base}/verificar-email/${codigo}` },
        rodape: 'O link vale por 24 horas e só pode ser usado uma vez.',
        aviso: 'Você recebeu este e-mail porque alguém criou uma conta no Infuse CRM com este endereço. Se não foi você, ignore.',
      })
    }
    return json({ ok: true, email, email_sent: emailSent })
  } catch (err) {
    console.error('[signup]', err instanceof Error ? err.message : err)
    return json({ error: 'Erro interno. Tente de novo.' }, 500)
  }
})
