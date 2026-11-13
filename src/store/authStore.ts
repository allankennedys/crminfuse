import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { ALL_PERMISSIONS } from '@/lib/permissions'
import type { UserProfile } from '@/types'
import type { Session } from '@supabase/supabase-js'

/** Domínio interno usado para transformar username em email do Supabase Auth. */
export const AUTH_EMAIL_DOMAIN = 'infuse.local'

// Nota: quem é o "dono da plataforma" é decidido no servidor (Edge Function
// admin-users, secret OWNER_EMAIL). O cliente descobre via action 'whoami' —
// assim o email do dono nunca entra no bundle.

/**
 * Converte o identificador digitado em email para o Supabase Auth.
 * Se já contém "@", é tratado como email literal (compatível com contas
 * antigas criadas por email real); caso contrário vira username@dominio.
 */
export function identifierToEmail(identifier: string): string {
  const id = identifier.trim().toLowerCase()
  return id.includes('@') ? id : `${id}@${AUTH_EMAIL_DOMAIN}`
}

interface AuthState {
  session: Session | null
  profile: UserProfile | null
  /** Já resolvidas: personalizadas, ou o preset do cargo vindo do banco. */
  permissions: string[]
  /** Nome da organização — aparece no cabeçalho do CRM, ao lado da logo. */
  organizationName: string | null
  setOrganizationName: (name: string) => void
  loading: boolean
  initialize: () => Promise<void>
  signIn: (username: string, password: string) => Promise<void>
  signOut: () => Promise<void>
}

/**
 * "Este usuário pode X?" para a tela. É espelho da regra, não a regra: quem
 * decide de verdade é current_user_can() na RLS. Serve para não desenhar
 * botão que só vai dar erro.
 */
export function useCan(): (perm: string) => boolean {
  const permissions = useAuthStore((s) => s.permissions)
  return (perm: string) => permissions.includes(perm)
}

async function fetchOrganizationName(profile: UserProfile | null): Promise<string | null> {
  if (!profile) return null
  const { data } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', profile.organization_id)
    .maybeSingle<{ name: string }>()
  return data?.name ?? null
}

async function fetchProfile(userId: string): Promise<UserProfile | null> {
  const { data } = await supabase.from('users').select('*').eq('id', userId).single<UserProfile>()
  return data
}

/**
 * A lista efetiva de permissões do usuário logado.
 *
 * Com `permissions` preenchido a resposta já está no perfil. Com null, o
 * usuário segue o preset do cargo — e quem sabe qual é o preset é o BANCO
 * (role_permissions, 055). Uma RPC por sessão evita manter uma segunda cópia
 * das listas no bundle, que sairia do lugar na primeira mudança de regra.
 *
 * Admin nunca consulta nada: tem tudo por definição, e é assim que
 * current_user_can responde do outro lado.
 *
 * Falhando a RPC, devolve lista vazia — a tela esconde tudo em vez de
 * liberar. O banco recusaria de qualquer jeito; o que se evita aqui é
 * oferecer um botão que só dá erro.
 */
async function resolvePermissions(profile: UserProfile | null): Promise<string[]> {
  if (!profile || !profile.is_active) return []
  if (profile.role === 'admin') return ALL_PERMISSIONS
  if (profile.permissions) return profile.permissions

  const { data, error } = await supabase.rpc('permissions_preset', { p_role: profile.role })
  if (error) return []
  return (data as string[] | null) ?? []
}

/**
 * O serviço de login responde em inglês ("Invalid login credentials"); a
 * tela mostra em português, sem repassar texto do backend.
 */
function mensagemDeLogin(error: { code?: string; status?: number; message?: string }): string {
  const code = error.code ?? ''
  const msg = (error.message ?? '').toLowerCase()
  if (code === 'email_not_confirmed' || msg.includes('not confirmed')) return 'EMAIL_NAO_CONFIRMADO'
  if (code === 'invalid_credentials' || msg.includes('invalid login')) return 'E-mail ou senha incorretos.'
  if (code === 'user_banned' || msg.includes('banned')) return 'Este usuário está desativado. Fale com o administrador.'
  if (code.includes('rate_limit') || error.status === 429) return 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.'
  if (code === 'validation_failed') return 'Preencha e-mail e senha.'
  return 'Não foi possível entrar agora. Tente de novo em instantes.'
}

export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  profile: null,
  permissions: [],
  organizationName: null,
  setOrganizationName: (name) => set({ organizationName: name }),
  loading: true,

  initialize: async () => {
    const { data: { session } } = await supabase.auth.getSession()
    const profile = session ? await fetchProfile(session.user.id) : null
    const [permissions, organizationName] = await Promise.all([resolvePermissions(profile), fetchOrganizationName(profile)])
    set({ session, profile, permissions, organizationName, loading: false })

    supabase.auth.onAuthStateChange(async (_event, session) => {
      const profile = session ? await fetchProfile(session.user.id) : null
      const [permissions, organizationName] = await Promise.all([resolvePermissions(profile), fetchOrganizationName(profile)])
      set({ session, profile, permissions, organizationName })
    })
  },

  signIn: async (username, password) => {
    const { error } = await supabase.auth.signInWithPassword({
      email: identifierToEmail(username),
      password,
    })
    if (error) throw new Error(mensagemDeLogin(error))
  },

  signOut: async () => {
    await supabase.auth.signOut()
    set({ session: null, profile: null, permissions: [], organizationName: null })
  },
}))
