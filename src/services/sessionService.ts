/**
 * sessionService — gerencia whatsapp_sessions (DB) + Evolution API.
 * Mantém o status da sessão espelhado no Supabase (fonte para UI/realtime).
 */

import { supabase } from '@/lib/supabase'
import { whatsappService } from './whatsappService'
import type { WhatsAppSession, SessionStatus } from '@/types'

function mapState(state: string | undefined): SessionStatus {
  if (state === 'open') return 'connected'
  if (state === 'connecting') return 'connecting'
  return 'disconnected'
}

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
   * Cria o número: a Edge Function gera o nome, cria na Evolution e registra
   * com dono (117). O painel não insere nada em whatsapp_sessions — antes
   * inseria, e um 403 ("já existe") era tratado como sucesso: o painel
   * adotava a instância de quem quer que fosse no servidor compartilhado.
   */
  async create(): Promise<{ session: WhatsAppSession; qrBase64: string | null }> {
    const res = await whatsappService.createSession()
    if (!res.ok || !res.data?.session) {
      const detail = res.data?.error
      throw new Error(`Não foi possível criar o número${detail ? `: ${detail}` : ` (erro ${res.status})`}. Tente novamente.`)
    }
    return { session: res.data.session, qrBase64: res.data.qrcode?.base64 ?? null }
  },

  async getQRCode(session: WhatsAppSession) {
    const res = await whatsappService.getQRCode(session.instance_name)
    if (!res.ok) throw new Error('Não foi possível gerar o QR Code. Tente novamente.')
    return res.data
  },

  /** Consulta o estado real na Evolution e atualiza o banco */
  async refreshStatus(session: WhatsAppSession): Promise<SessionStatus> {
    const res = await whatsappService.checkConnection(session.instance_name)
    const status: SessionStatus = res.ok ? mapState(res.data?.instance?.state) : 'error'

    await supabase.from('whatsapp_sessions').update({
      status,
      last_seen_at: new Date().toISOString(),
    }).eq('id', session.id)

    return status
  },

  /** Reconecta: restart na Evolution + status connecting */
  async reconnect(session: WhatsAppSession) {
    await whatsappService.restartSession(session.instance_name)
    await supabase.from('whatsapp_sessions')
      .update({ status: 'connecting' })
      .eq('id', session.id)
  },

  /**
   * Desconecta de verdade: logout na Evolution, que invalida a credencial
   * guardada e tira o aparelho de "Aparelhos conectados" no celular. É o que
   * o restart NÃO faz — por isso é este o caminho quando a sessão está `open`
   * mas o app-state travou. Depois disso o /instance/connect volta a emitir
   * QR (com a sessão aberta ele só devolve o estado).
   *
   * A instância continua existindo na Evolution e a linha em whatsapp_sessions
   * é preservada: as associações grupo<->número (group_sessions) sobrevivem,
   * ao contrário do que acontece em `remove`.
   */
  async disconnect(session: WhatsAppSession) {
    const res = await whatsappService.logoutSession(session.instance_name)
    // 404/400 = instância já estava deslogada; o objetivo já está cumprido.
    if (!res.ok && res.status !== 404 && res.status !== 400) {
      // O motivo do proxy importa: um 403 tanto pode ser falta de permissão
      // quanto "Rota não permitida" numa edge function desatualizada, e as
      // duas coisas se resolvem de formas bem diferentes.
      const detail = (res.data as { error?: string } | null)?.error
      throw new Error(
        `Não foi possível desconectar o número (erro ${res.status}${detail ? `: ${detail}` : ''}).`,
      )
    }

    await supabase.from('whatsapp_sessions').update({
      status: 'disconnected',
      last_seen_at: new Date().toISOString(),
    }).eq('id', session.id)
  },

  /**
   * Remove o número de vez: apaga a instância na Evolution (o que também
   * desconecta o aparelho) e a linha do painel. Com a Evolution
   * compartilhada, "tirar só do painel" deixaria uma instância órfã no
   * servidor, conectada ao celular do cliente, sem ninguém que a enxergue.
   */
  async remove(session: WhatsAppSession) {
    const res = await whatsappService.deleteSession(session.instance_name)
    if (!res.ok && res.status !== 404) {
      const detail = (res.data as { error?: string } | null)?.error
      throw new Error(`Não foi possível remover o número (erro ${res.status}${detail ? `: ${detail}` : ''}).`)
    }
    // A Edge Function já apaga a linha; isto cobre a instância que não
    // existia mais na Evolution.
    const { error } = await supabase.from('whatsapp_sessions').delete().eq('id', session.id)
    if (error) throw error
  },

  /** Monitor: revalida status de todas as sessões (auto-reconnect) */
  startMonitor(intervalMs = 45_000) {
    const tick = async () => {
      try {
        const sessions = await this.list()
        for (const s of sessions) {
          const status = await this.refreshStatus(s)
          if (status === 'disconnected' && s.status === 'connected') {
            // caiu agora — tenta reconexão automática
            await this.reconnect(s)
          }
        }
      } catch (err) {
        console.error('[sessionService] monitor error:', err)
      }
    }
    tick()
    return setInterval(tick, intervalMs)
  },
}
