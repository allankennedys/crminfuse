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
import { chaveServidor } from '../_shared/servidor.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
}

const AUTH_EMAIL_DOMAIN = 'infuse.local'
// Renames no enum do banco: 'crm_only' → 'sdr' (054), 'viewer' → 'gestor' (056).
// Neste projeto: só admin e atendente.
const VALID_ROLES = ['admin', 'atendente'] as const

/**
 * Dono da plataforma: única conta que pode criar admins donos de NOVAS
 * organizações (provisionar novos tenants). Vem do secret OWNER_EMAIL.
 * Sem o secret, ninguém é dono (fail-closed) — nenhum email fica no código.
 */
// Aceita mais de um e-mail separado por vírgula: ao trocar o e-mail de acesso do dono, o antigo e o novo valem.
const OWNER_EMAILS = (Deno.env.get('OWNER_EMAIL') ?? '').toLowerCase().split(',').map((e) => e.trim()).filter(Boolean)
const isOwnerEmail = (e: string | null | undefined) => OWNER_EMAILS.includes((e ?? '').toLowerCase())

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
    const isOwner = isOwnerEmail(user.email)

    // Reatribui as conversas abertas de `fromId` (mesma organização do admin, ou
    // qualquer uma se for o dono). Devolve quantas mudaram de mãos.
    const reassign = async (fromId: string, mode: unknown, to: unknown):
      Promise<{ moved?: number; error?: string; status?: number }> => {
      if (!fromId) return { error: 'Usuário não informado.' }
      if (mode !== 'user' && mode !== 'random' && mode !== 'queue') return { error: 'Escolha o destino das conversas.' }
      const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      const { data: from } = await svc.from('users').select('organization_id').eq('id', fromId).maybeSingle()
      if (!from) return { error: 'Usuário não encontrado.', status: 404 }
      if (from.organization_id !== profile.organization_id && !isOwner) {
        return { error: 'Sem permissão para usuários de outra organização.', status: 403 }
      }
      if (mode === 'user') {
        const { data: dest } = await svc.from('users').select('organization_id, is_active').eq('id', String(to ?? '')).maybeSingle()
        if (!dest || !dest.is_active || dest.organization_id !== from.organization_id) {
          return { error: 'Escolha um atendente ativo da mesma organização.' }
        }
      }
      const { data, error } = await svc.rpc('wa_reassign_user', {
        p_from: fromId, p_mode: mode, p_to: mode === 'user' ? String(to) : null,
      })
      if (error) { console.error('reassign:', error.message); return { error: 'Falha ao transferir os atendimentos.', status: 500 } }
      return { moved: Number(data ?? 0) }
    }

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

    // Ação: passar as conversas abertas de um atendente para outro, para a fila
    // ou distribuir ao acaso. Usada antes de excluir ou desativar.
    if (body?.action === 'reassign') {
      const r = await reassign(String(body?.user_id ?? ''), body?.mode, body?.to)
      if (r.error) return json({ error: r.error }, r.status ?? 400)
      return json({ ok: true, moved: r.moved })
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
      if (isOwnerEmail(target.email)) {
        return json({ error: 'A conta do dono da plataforma não pode ser excluída.' }, 403)
      }

      // Membro desta empresa (mesmo que esteja ativo em outra): sair daqui não apaga a conta se ele tem outras empresas.
      const { data: vinculo } = await adminDel
        .from('memberships').select('user_id').eq('user_id', targetId).eq('organization_id', profile.organization_id).maybeSingle()
      const crossOrg = !vinculo && target.organization_id !== profile.organization_id
      if (crossOrg && !isOwner) {
        return json({ error: 'Sem permissão para excluir usuários de outra organização.' }, 403)
      }

      if (body?.mode) {
        const r = await reassign(targetId, body.mode, body.to)
        if (r.error) return json({ error: r.error }, r.status ?? 400)
      }

      if (vinculo) {
        const { data: restou } = await adminDel.rpc('remover_vinculo', { p_user: targetId, p_org: profile.organization_id })
        if (restou) return json({ ok: true })
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
      if (isOwnerEmail(target.email) && !isOwner) {
        return json({ error: 'A senha do dono da plataforma não pode ser alterada por outro admin.' }, 403)
      }

      const crossOrg = target.organization_id !== profile.organization_id
      if (crossOrg && !isOwner) {
        return json({ error: 'Sem permissão para alterar a senha de usuários de outra organização.' }, 403)
      }

      // Quem participa de mais de uma empresa tem a mesma senha em todas: um admin não pode
      // redefini-la (daria acesso às outras empresas). A própria pessoa usa "Esqueci minha senha".
      const { count: nEmpresas } = await adminPw.from('memberships').select('user_id', { count: 'exact', head: true }).eq('user_id', targetId)
      if ((nEmpresas ?? 0) > 1 && !isOwner) {
        return json({ error: 'Esta pessoa participa de outras empresas. Ela mesma precisa redefinir a senha ("Esqueci minha senha").' }, 403)
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
    const role = newOrganization ? 'admin' : (VALID_ROLES.includes(body?.role) ? body.role : 'atendente')

    if (!/^[a-z0-9._-]+$/.test(username)) {
      return json({ error: 'Usuário só pode ter letras, números, ponto, hífen ou underline.' }, 400)
    }
    if (password.length < 6) {
      return json({ error: 'A senha precisa ter ao menos 6 caracteres.' }, 400)
    }

    // Usuário novo na organização só entra por convite (função invite): a
    // criação direta com senha foi desativada.
    if (!newOrganization) {
      return json({ error: 'Para adicionar uma pessoa, gere um convite em Configurações → Usuários.' }, 410)
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

    // Assinatura em atraso ou suspensa: não cria usuário novo na organização.
    if (!newOrganization) {
      const { data: acesso } = await admin.rpc('org_acesso', { p_org: profile.organization_id })
      if (acesso && acesso !== 'total') {
        return json({ error: 'Sua assinatura precisa estar em dia para criar usuários. Veja Configurações → Plano e cobrança.' }, 402)
      }
    }

    // Cria o usuário já confirmado — sem tocar na sessão de quem chamou.
    // O trigger handle_new_user lê `organization_name` do metadata para
    // nomear a org que ele cria (relevante só no fluxo de org nova).
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        servidor_key: await chaveServidor(admin),
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
      // Limite do plano (gatilho limite_atendentes): a mensagem já é para o usuário.
      if (/Limite de usuários/.test(updErr.message ?? '')) return json({ error: updErr.message }, 402)
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
