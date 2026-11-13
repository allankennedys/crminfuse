/**
 * Edge Function: invite
 *
 * Convites para entrar numa organização. Só o administrador cria; quem recebe
 * aceita pelo link (sem login).
 *
 *   JWT de administrador:
 *     { action: 'create', role: 'atendente'|'admin', email, permissions? } → { url, email_sent }
 *     { action: 'list' }                                                      → { invites }
 *     { action: 'revoke', id }                                                → { ok }
 *   Público (o código do link é o segredo):
 *     { action: 'info', token }                                  → { organization, role }
 *     { action: 'accept', token, full_name, password }            → { ok, email }
 *
 * Secrets opcionais para enviar o convite por e-mail: RESEND_API_KEY e
 * MAIL_FROM (ex.: "Infuse <convites@seudominio.com>"). Sem eles, o link só é
 * mostrado ao administrador para ele mandar como quiser.
 */
import { createClient } from 'npm:@supabase/supabase-js@2'
import { usuarioGoogle } from '../_shared/google.ts'
import { acessoDaOrganizacao, MSG_SEM_ACESSO } from '../_shared/assinatura.ts'
import { enviarEmailMarca, novoCodigo, sha256 } from '../_shared/email.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
}
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
      return json({ organization: (Array.isArray(org) ? org[0]?.name : org?.name) ?? '', role: inv.role, email: inv.email })
    }

    if (action === 'accept') {
      const inv = await convitePorCodigo(String(body?.token ?? ''))
      const fullName = String(body?.full_name ?? '').trim()
      const password = String(body?.password ?? '')
      if (fullName.length < 2 || fullName.length > 80) throw new HttpError(400, 'Informe o seu nome.')
      // O e-mail do convite é o login: o convidado só escolhe nome e senha.
      const email = String(inv.email ?? '').toLowerCase()
      if (!email) throw new HttpError(400, 'Este convite não tem e-mail. Peça um novo ao administrador.')
      if (password.length < 8) throw new HttpError(400, 'A senha precisa ter ao menos 8 caracteres.')

      const acesso = await acessoDaOrganizacao(admin, inv.organization_id)
      if (acesso !== 'total') throw new HttpError(402, 'A assinatura desta empresa não está em dia. Avise o administrador.')

      // Reserva o convite antes de criar a conta: dois cliques não usam o mesmo link duas vezes.
      const { data: reservado } = await admin
        .from('invitations').update({ used_at: new Date().toISOString() })
        .eq('id', inv.id).is('used_at', null).is('revoked_at', null).select('id')
      if (!reservado?.length) throw new HttpError(410, 'Este convite já foi usado.')

      const desfazer = async () => { await admin.from('invitations').update({ used_at: null }).eq('id', inv.id) }

      // Quem abriu o link recebido nesse e-mail provou que ele é dele: já nasce confirmado.
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: { servidor: true },
        user_metadata: { username: email, full_name: fullName },
      })
      if (createErr || !created?.user) {
        await desfazer()
        const jaExiste = /already been registered|already exists|duplicate/i.test(createErr?.message ?? '')
        throw new HttpError(400, jaExiste ? 'Este e-mail já tem uma conta. Entre com ela, ou peça um convite para outro e-mail.' : 'Não foi possível criar a conta.')
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
      return json({ ok: true, email })
    }

    // Convite aceito por quem entrou com o Google (conta já existe, sem empresa).
    if (action === 'accept_google') {
      let gu: Awaited<ReturnType<typeof usuarioGoogle>>
      try { gu = await usuarioGoogle(req, admin) } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : 'Não autenticado.') }
      const inv = await convitePorCodigo(String(body?.token ?? ''))
      if (String(inv.email ?? '').toLowerCase() !== gu.email) {
        throw new HttpError(400, 'Este convite é para outro e-mail. Entre com a conta Google do e-mail que foi convidado.')
      }
      const acesso = await acessoDaOrganizacao(admin, inv.organization_id)
      if (acesso !== 'total') throw new HttpError(402, 'A assinatura desta empresa não está em dia. Avise o administrador.')
      const { data: reservado } = await admin
        .from('invitations').update({ used_at: new Date().toISOString() })
        .eq('id', inv.id).is('used_at', null).is('revoked_at', null).select('id')
      if (!reservado?.length) throw new HttpError(410, 'Este convite já foi usado.')
      const { error: insErr } = await admin.from('users').insert({
        id: gu.id, organization_id: inv.organization_id, email: gu.email, username: gu.email,
        full_name: gu.nome || gu.email.split('@')[0], role: inv.role,
        ...(inv.permissions && inv.role !== 'admin' ? { permissions: inv.permissions } : {}),
      })
      if (insErr) {
        await admin.from('invitations').update({ used_at: null }).eq('id', inv.id)
        if (/Limite de usuários/.test(insErr.message ?? '')) throw new HttpError(402, 'A empresa atingiu o limite de usuários do plano. Avise o administrador.')
        console.error('[invite accept_google]', insErr.message)
        throw new HttpError(500, 'Não foi possível entrar na empresa.')
      }
      await admin.from('invitations').update({ used_by: gu.id }).eq('id', inv.id)
      return json({ ok: true })
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
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.endsWith('@infuse.local')) throw new HttpError(400, 'Informe o e-mail da pessoa que vai entrar.')
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
      const { data: o } = await admin.from('organizations').select('name').eq('id', org).maybeSingle()
      const orgNome = o?.name ?? 'sua empresa'
      const emailSent = await enviarEmailMarca({
        to: email, base,
        subject: `Você foi convidado para ${orgNome} no Infuse CRM`,
        titulo: 'Você foi convidado',
        paragrafos: [`Você foi convidado para entrar em ${orgNome} no Infuse CRM. Clique no botão para criar sua senha e entrar.`],
        botao: { texto: 'Aceitar convite', url },
        rodape: 'O link vale por 7 dias e só pode ser usado uma vez.',
        aviso: `Você recebeu este e-mail porque alguém da empresa ${orgNome} convidou este endereço. Se não esperava, ignore.`,
      })
      return json({ url, email_sent: emailSent })
    }

    throw new HttpError(400, 'Ação desconhecida')
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status)
    console.error('[invite]', err instanceof Error ? err.message : err)
    return json({ error: 'Erro interno. Tente de novo.' }, 500)
  }
})
