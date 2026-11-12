/**
 * Edge Function: admin-users
 *
 * Cria um novo usuário na organização do admin autenticado — do lado do
 * servidor, com service_role. É isso que evita o bug clássico do
 * `supabase.auth.signUp()` no navegador, que TROCA a sessão ativa para o
 * usuário recém-criado (o admin acabava logado na conta nova).
 *
 * Fluxo:
 *  1. Valida que quem chamou é admin ativo da org.
 *  2. Cria o auth user já confirmado (admin.createUser) — não mexe na
 *     sessão de quem chamou.
 *  3. O trigger handle_new_user cria uma org + perfil (role admin) próprios;
 *     aqui movo o usuário para a org do admin, aplico a role pedida e
 *     removo a organização órfã que o trigger criou.
 *
 * Secrets necessários: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const AUTH_EMAIL_DOMAIN = 'phgroups.local'
// Renames no enum do banco: 'crm_only' → 'sdr' (054), 'viewer' → 'gestor' (056).
const VALID_ROLES = ['admin', 'operator', 'gestor', 'sdr'] as const

/**
 * Dono da plataforma: única conta que pode criar admins donos de NOVAS
 * organizações (provisionar novos tenants). Vem do secret OWNER_EMAIL.
 * Sem o secret, ninguém é dono (fail-closed) — nenhum email fica no código.
 */
const OWNER_EMAIL = (Deno.env.get('OWNER_EMAIL') ?? '').toLowerCase()

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  try {
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    )

    const { data: { user } } = await userClient.auth.getUser()
    if (!user) return json({ error: 'Não autenticado' }, 401)

    const { data: profile } = await userClient
      .from('users')
      .select('organization_id, role, is_active')
      .eq('id', user.id)
      .single()

    if (!profile?.is_active || profile.role !== 'admin') {
      return json({ error: 'Apenas administradores podem criar usuários' }, 403)
    }

    const body = await req.json().catch(() => ({}))
    const isOwner = OWNER_EMAIL !== '' && (user.email ?? '').toLowerCase() === OWNER_EMAIL

    // Ação: informar se quem chamou é o dono da plataforma. Assim a UI decide
    // o que mostrar sem precisar conhecer o email do dono (não vai no bundle).
    if (body?.action === 'whoami') {
      return json({ ok: true, is_owner: isOwner })
    }

    // Ação: listar todos os usuários de todas as organizações (só o dono).
    if (body?.action === 'list') {
      if (!isOwner) {
        return json({ error: 'Apenas o dono da plataforma pode ver todas as organizações.' }, 403)
      }
      const adminList = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      )
      const { data, error } = await adminList
        .from('users')
        .select('id, username, full_name, email, role, is_active, created_at, organization_id, organizations(name)')
        .order('created_at')
      if (error) {
        console.error('admin-users list:', error.message)
        return json({ error: 'Falha ao listar usuários.' }, 500)
      }
      return json({ ok: true, users: data ?? [] })
    }

    // Ação: excluir um usuário (remove o auth user; o perfil cai por cascade).
    if (body?.action === 'delete') {
      const targetId = String(body?.user_id ?? '')
      if (!targetId) return json({ error: 'Usuário não informado.' }, 400)
      if (targetId === user.id) return json({ error: 'Você não pode excluir a própria conta.' }, 400)

      const adminDel = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      )
      const { data: target } = await adminDel
        .from('users')
        .select('organization_id, email')
        .eq('id', targetId)
        .maybeSingle()

      if (!target) return json({ error: 'Usuário não encontrado.' }, 404)
      if ((target.email ?? '').toLowerCase() === OWNER_EMAIL) {
        return json({ error: 'A conta do dono da plataforma não pode ser excluída.' }, 403)
      }

      const crossOrg = target.organization_id !== profile.organization_id
      if (crossOrg && !isOwner) {
        return json({ error: 'Sem permissão para excluir usuários de outra organização.' }, 403)
      }

      const { error: delErr } = await adminDel.auth.admin.deleteUser(targetId)
      if (delErr) {
        console.error('admin-users delete:', delErr.message)
        return json({ error: 'Falha ao excluir usuário.' }, 500)
      }

      // Se a exclusão esvaziou a organização (tenant de outro), remove a org.
      if (crossOrg) {
        const { count } = await adminDel
          .from('users')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', target.organization_id)
        if ((count ?? 0) === 0) {
          await adminDel.from('organizations').delete().eq('id', target.organization_id)
        }
      }

      return json({ ok: true })
    }

    // Ação: definir/resetar a senha de um usuário. NÃO existe "ver senha": o
    // Supabase guarda só o hash bcrypt, irreversível. O controle de acesso do
    // admin é feito redefinindo a senha e repassando-a — nunca lendo a atual.
    if (body?.action === 'set_password') {
      const targetId = String(body?.user_id ?? '')
      const newPassword = String(body?.password ?? '')
      if (!targetId) return json({ error: 'Usuário não informado.' }, 400)
      if (newPassword.length < 6) {
        return json({ error: 'A senha precisa ter ao menos 6 caracteres.' }, 400)
      }

      const adminPw = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      )
      const { data: target } = await adminPw
        .from('users')
        .select('organization_id, email')
        .eq('id', targetId)
        .maybeSingle()

      if (!target) return json({ error: 'Usuário não encontrado.' }, 404)

      // A senha do dono da plataforma só o próprio dono redefine — impede que
      // um admin da mesma org assuma a conta dona por reset.
      if ((target.email ?? '').toLowerCase() === OWNER_EMAIL && !isOwner) {
        return json({ error: 'A senha do dono da plataforma não pode ser alterada por outro admin.' }, 403)
      }

      const crossOrg = target.organization_id !== profile.organization_id
      if (crossOrg && !isOwner) {
        return json({ error: 'Sem permissão para alterar a senha de usuários de outra organização.' }, 403)
      }

      const { error: pwErr } = await adminPw.auth.admin.updateUserById(targetId, { password: newPassword })
      if (pwErr) {
        console.error('admin-users set_password:', pwErr.message)
        return json({ error: 'Falha ao definir a senha.' }, 500)
      }
      return json({ ok: true })
    }

    const username = String(body?.username ?? '').trim().toLowerCase()
    const password = String(body?.password ?? '')
    const fullName = typeof body?.full_name === 'string' ? body.full_name.trim() : ''
    const newOrganization = body?.new_organization === true
    const organizationName = typeof body?.organization_name === 'string' ? body.organization_name.trim() : ''
    // Numa org nova o usuário é sempre o admin dono; senão respeita a role pedida.
    const role = newOrganization ? 'admin' : (VALID_ROLES.includes(body?.role) ? body.role : 'operator')

    if (!/^[a-z0-9._-]+$/.test(username)) {
      return json({ error: 'Usuário só pode ter letras, números, ponto, hífen ou underline.' }, 400)
    }
    if (password.length < 6) {
      return json({ error: 'A senha precisa ter ao menos 6 caracteres.' }, 400)
    }

    // Só o dono da plataforma pode provisionar novas organizações.
    if (newOrganization && !isOwner) {
      return json({ error: 'Apenas o dono da plataforma pode criar novas organizações.' }, 403)
    }

    const email = username.includes('@') ? username : `${username}@${AUTH_EMAIL_DOMAIN}`

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // Cria o usuário já confirmado — sem tocar na sessão de quem chamou.
    // O trigger handle_new_user lê `organization_name` do metadata para
    // nomear a org que ele cria (relevante só no fluxo de org nova).
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        username,
        full_name: fullName || null,
        ...(newOrganization && organizationName ? { organization_name: organizationName } : {}),
      },
    })

    if (createErr || !created?.user) {
      if (createErr) console.error('admin-users create:', createErr.message)
      const msg = /already been registered|already exists|duplicate/i.test(createErr?.message ?? '')
        ? 'Esse nome de usuário já está em uso.'
        : 'Falha ao criar usuário.'
      return json({ error: msg }, 400)
    }

    const newId = created.user.id

    // Org nova: o trigger já criou a organização (nome vindo do metadata) e o
    // perfil como admin dono. Nada a mover nem limpar.
    if (newOrganization) {
      return json({ ok: true, id: newId, new_organization: true })
    }

    // Fluxo padrão — o trigger criou uma org própria (role admin). Captura para limpar depois.
    const { data: fresh } = await admin
      .from('users')
      .select('organization_id')
      .eq('id', newId)
      .maybeSingle()
    const orphanOrg = fresh?.organization_id as string | undefined

    // Move para a org do admin e aplica a role pedida.
    const { error: updErr } = await admin
      .from('users')
      .update({ organization_id: profile.organization_id, role })
      .eq('id', newId)

    if (updErr) {
      // Não deixa auth user solto se o vínculo falhou.
      await admin.auth.admin.deleteUser(newId)
      return json({ error: 'Falha ao vincular o usuário à organização' }, 500)
    }

    // Remove a organização órfã criada pelo trigger (se ficou sem usuários).
    if (orphanOrg && orphanOrg !== profile.organization_id) {
      const { count } = await admin
        .from('users')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orphanOrg)
      if ((count ?? 0) === 0) {
        await admin.from('organizations').delete().eq('id', orphanOrg)
      }
    }

    return json({ ok: true, id: newId })
  } catch (err) {
    console.error('admin-users:', err instanceof Error ? err.message : err)
    return json({ error: 'Erro interno' }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
