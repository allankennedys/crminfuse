/**
 * numerosService — os números de WhatsApp do usuário, pela função `numeros`
 * do servidor. O painel só conhece ações (criar, QR, status...) e recebe só
 * o que a tela usa; o servidor de WhatsApp por trás fica invisível daqui.
 */

import { supabase, FunctionRegion } from '@/lib/supabase'
import type { SessionStatus, WhatsAppSession } from '@/types'

async function numeros<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('numeros', { body, region: FunctionRegion.EuWest3 })
  if (error) {
    let msg = 'Falha de comunicação com o servidor. Tente de novo.'
    try {
      const ctx = (error as { context?: Response }).context
      const j = ctx ? await ctx.json() : null
      if (typeof j?.error === 'string' && j.error) msg = j.error
    } catch { /* corpo não era JSON */ }
    throw new Error(msg)
  }
  if (data?.error) throw new Error(data.error)
  return data as T
}

export const numerosService = {
  /** Cria o número (o servidor gera o nome) e já devolve o QR Code. */
  create: () => numeros<{ session: WhatsAppSession; qr: string | null }>({ action: 'create' }),
  qr: (sessionId: string) => numeros<{ qr: string | null; connected: boolean }>({ action: 'qr', session_id: sessionId }),
  /** Estado real do número; o servidor também grava no banco. */
  status: (sessionId: string) => numeros<{ status: SessionStatus }>({ action: 'status', session_id: sessionId }),
  reconnect: (sessionId: string) => numeros<{ ok: true }>({ action: 'reconnect', session_id: sessionId }),
  disconnect: (sessionId: string) => numeros<{ ok: true }>({ action: 'disconnect', session_id: sessionId }),
  remove: (sessionId: string) => numeros<{ ok: true }>({ action: 'remove', session_id: sessionId }),
}
