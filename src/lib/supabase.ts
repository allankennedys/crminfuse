import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('[Infuse Groups] Variáveis VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY não configuradas.')
}

export const supabase = createClient(supabaseUrl ?? '', supabaseAnonKey ?? '', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
  realtime: {
    params: { eventsPerSecond: 10 },
  },
})

/**
 * Região das Edge Functions = a do banco (eu-west-3). Sem isto o Supabase
 * roda a função perto de quem chama — no Brasil, São Paulo — e cada consulta
 * dela ao banco atravessa o oceano (umas cinco por mensagem enviada).
 */
export { FunctionRegion } from '@supabase/supabase-js'
export const FUNCTIONS_REGION = 'eu-west-3' as const
