/**
 * sessionService — a lista de números (whatsapp_sessions) e as ações sobre
 * eles, que passam pela função `numeros` do servidor (numerosService).
 */

import { supabase } from '@/lib/supabase'
import { numerosService } from './numerosService'
import type { WhatsAppSession, SessionStatus } from '@/types'

export const sessionService = {
  async list() {
    const { data, error } = await supabase
      .from('whatsapp_sessions')
      .select('*')
      .order('created_at', { ascending: false })
      .returns<WhatsAppSession[]>()
    if (error) throw error
    return data
  },

  /**
   * Cria o número: o servidor gera o nome, cria e registra com dono (117).
   * O painel não insere nada em whatsapp_sessions.
   */
  async create(): Promise<{ session: WhatsAppSession; qrBase64: string | null }> {
    try {
      const r = await numerosService.create()
      return { session: r.session, qrBase64: r.qr }
    } catch (err) {
      throw new Error(`Não foi possível criar o número: ${err instanceof Error ? err.message : 'tente novamente'}`)
    }
  },

  async getQRCode(session: WhatsAppSession): Promise<{ base64?: string }> {
    const r = await numerosService.qr(session.id)
    return { base64: r.qr ?? undefined }
  },

  /** Consulta o estado real do número (o servidor grava no banco). */
  async refreshStatus(session: WhatsAppSession): Promise<SessionStatus> {
    try {
      return (await numerosService.status(session.id)).status
    } catch {
      return 'error'
    }
  },

  /** Reconecta (reinicia a conexão); o número fica "conectando". */
  async reconnect(session: WhatsAppSession) {
    await numerosService.reconnect(session.id)
  },

  /**
   * Desconecta de verdade: o aparelho sai de "Aparelhos conectados" no
   * celular e o QR Code volta a ser emitido. O número continua cadastrado.
   */
  async disconnect(session: WhatsAppSession) {
    await numerosService.disconnect(session.id)
  },

  /** Remove o número de vez (desconecta o aparelho e apaga a conexão). */
  async remove(session: WhatsAppSession) {
    await numerosService.remove(session.id)
  },
}
