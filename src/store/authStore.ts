import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { ALL_PERMISSIONS } from '@/lib/permissions'
import type { UserProfile } from '@/types'
import type { Session } from '@supabase/supabase-js'

/** Domínio interno usado para transformar username em email do Supabase Auth. */
export const AUTH_EMAIL_DOMAIN = 'phgroups.local'

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

export const useAuthStore = create<AuthState>((set) => ({
  session: null,
  profile: null,
  permissions: [],
  loading: true,

  initialize: async () => {
    const { data: { session } } = await supabase.auth.getSession()
    const profile = session ? await fetchProfile(session.user.id) : null
    set({ session, profile, permissions: await resolvePermissions(profile), loading: false })

    supabase.auth.onAuthStateChange(async (_event, session) => {
      const profile = session ? await fetchProfile(session.user.id) : null
      set({ session, profile, permissions: await resolvePermissions(profile) })
    })
  },

  signIn: async (username, password) => {
    const { error } = await supabase.auth.signInWithPassword({
      email: identifierToEmail(username),
      password,
    })
    if (error) throw error
  },

  signOut: async () => {
    await supabase.auth.signOut()
    set({ session: null, profile: null, permissions: [] })
  },
}))
