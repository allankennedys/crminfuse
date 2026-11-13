/**
 * Quem chamou entrou com o Google e ainda NÃO tem organização (perfil)?
 * Devolve o usuário; senão lança um Error com mensagem em português.
 */
// deno-lint-ignore no-explicit-any
export async function usuarioGoogle(req: Request, admin: any): Promise<{ id: string; email: string; nome: string }> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: { user } } = await admin.auth.getUser(token)
  if (!user) throw new Error('Não autenticado.')
  const providers: string[] = user.app_metadata?.providers ?? []
  if (!providers.includes('google') || !user.email || !user.email_confirmed_at) {
    throw new Error('Entre com uma conta Google com e-mail verificado.')
  }
  const { data: perfil } = await admin.from('users').select('id').eq('id', user.id).maybeSingle()
  if (perfil) throw new Error('Esta conta já pertence a uma empresa.')
  const nome = String(user.user_metadata?.full_name ?? user.user_metadata?.name ?? '').trim()
  return { id: user.id, email: String(user.email).toLowerCase(), nome }
}
