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

  /** Cria a instância na Evolution API e registra no banco */
  async create(organizationId: string, instanceName: string, phoneNumber?: string) {
    const res = await whatsappService.createSession(instanceName)
    if (!res.ok && res.status !== 403) {
      // 403 = instância já existe na Evolution; seguimos e registramos
      throw new Error(`Não foi possível conectar o número (erro ${res.status}). Tente novamente.`)
    }

    const { data, error } = await supabase.from('whatsapp_sessions').insert({
      organization_id: organizationId,
      instance_name: instanceName,
      phone_number: phoneNumber ?? null,
      status: 'connecting',
    }).select().single<WhatsAppSession>()
    if (error) throw error
    return data
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
   * Remove o número apenas do painel (banco). A instância continua
   * conectada na Evolution — pode ser re-adicionada depois pelo mesmo nome.
   */
  async remove(session: WhatsAppSession) {
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
