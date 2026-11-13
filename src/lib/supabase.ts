import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_API_URL
const supabaseAnonKey = import.meta.env.VITE_API_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('[Infuse CRM] Endereço do servidor não configurado.')
}

/**
 * O login manda um cabeçalho de versão com o nome do fornecedor do backend.
 * Ele sai daqui como X-Api-Version e o Worker do domínio devolve o nome
 * original ao repassar (e faz o caminho inverso na resposta) — assim a aba
 * Rede do navegador não mostra o fornecedor.
 */
const VERSAO_ORIGINAL = 'x-supabase-api-version'
const VERSAO = 'x-api-version'

const fetchDaInfuse: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  const versao = headers.get(VERSAO_ORIGINAL)
  if (versao === null) return fetch(input, init)
  headers.delete(VERSAO_ORIGINAL)
  headers.set(VERSAO, versao)
  const res = await fetch(input, { ...init, headers })
  const devolvida = res.headers.get(VERSAO)
  if (devolvida === null) return res
  const h = new Headers(res.headers)
  h.set(VERSAO_ORIGINAL, devolvida)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
}

/**
 * O endereço é o da Infuse (api.infusesoftware.com — proxy na Cloudflare,
 * cloudflare/api-proxy). Nome da sessão, identificação do cliente e
 * cabeçalhos também são próprios, para o navegador não mostrar o fornecedor
 * do backend.
 */
export const supabase = createClient(supabaseUrl ?? '', supabaseAnonKey ?? '', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: 'infuse-crm-auth',
  },
  global: {
    headers: { 'X-Client-Info': 'infuse-crm' },
    fetch: fetchDaInfuse,
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
