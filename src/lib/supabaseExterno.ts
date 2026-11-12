import { createClient } from '@supabase/supabase-js'

/**
 * Client de LEITURA de um segundo projeto Supabase (outro database).
 * Use só para consultar tabelas externas — a tabela lá precisa de uma
 * policy RLS de select para a role `anon`.
 */
const url = import.meta.env.VITE_SUPABASE_EXTERNO_URL
const anonKey = import.meta.env.VITE_SUPABASE_EXTERNO_ANON_KEY

/** false = módulo externo (jornada/comprovantes) desligado nesta instalação. */
export const EXTERNO_CONFIGURADO = Boolean(url && anonKey)

if (!EXTERNO_CONFIGURADO) {
  console.warn('[Infuse] VITE_SUPABASE_EXTERNO_URL / VITE_SUPABASE_EXTERNO_ANON_KEY não configuradas — jornada e comprovantes desligados.')
}

// createClient('') lança "supabaseUrl is required" no import e derruba o app
// inteiro. Sem configuração, o client aponta para um host que nunca resolve
// (.invalid, RFC 2606): as consultas falham sozinhas e quem chama já trata.
export const supabaseExterno = createClient(url || 'https://externo.invalid', anonKey || 'nao-configurado', {
  // Sem sessão/realtime: é só consulta pontual de leitura.
  auth: { persistSession: false, autoRefreshToken: false },
})
