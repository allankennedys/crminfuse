import { createClient } from '@supabase/supabase-js'

/**
 * Client de LEITURA de um segundo projeto Supabase (outro database).
 * Use só para consultar tabelas externas — a tabela lá precisa de uma
 * policy RLS de select para a role `anon`.
 */
const url = import.meta.env.VITE_SUPABASE_EXTERNO_URL
const anonKey = import.meta.env.VITE_SUPABASE_EXTERNO_ANON_KEY

if (!url || !anonKey) {
  console.warn('[Infuse Groups] Variáveis VITE_SUPABASE_EXTERNO_URL / VITE_SUPABASE_EXTERNO_ANON_KEY não configuradas.')
}

export const supabaseExterno = createClient(url ?? '', anonKey ?? '', {
  // Sem sessão/realtime: é só consulta pontual de leitura.
  auth: { persistSession: false, autoRefreshToken: false },
})
