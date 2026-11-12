/**
 * whatsappService — camada isolada de integração com a Evolution API 2.3.
 * Nenhum outro módulo deve chamar a Evolution API diretamente.
 *
 * Todas as chamadas passam pela Edge Function `evolution` (proxy seguro):
 * a chave da Evolution fica só no servidor, e o proxy valida que a
 * instância pertence à organização do usuário autenticado.
 */

import { supabase } from '@/lib/supabase'

interface EvolutionResponse<T = unknown> {
  ok: boolean
  status: number
  data: T
}

async function request<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<EvolutionResponse<T>> {
  const { data, error } = await supabase.functions.invoke('evolution', {
    body: {
      path,
      method: options.method ?? 'GET',
      body: options.body ?? null,
    },
  })

  if (error) {
    // O corpo de erro da função (com a mensagem em português) vem no context.
    let msg = 'Falha de comunicação com o servidor. Tente de novo.'
    try {
      const ctx = (error as { context?: Response }).context
      const j = ctx ? await ctx.json() : null
      const m = j?.data?.error ?? j?.error
      if (typeof m === 'string' && m) msg = m
    } catch { /* corpo não era JSON */ }
    return { ok: false, status: 0, data: { error: msg } as T }
  }

  return {
    ok: Boolean(data?.ok),
    status: Number(data?.status ?? 0),
    data: (data?.data ?? null) as T,
  }
}

export interface QRCodeData {
  base64?: string
  code?: string
  pairingCode?: string
}

export interface ConnectionState {
  instance: { instanceName: string; state: 'open' | 'connecting' | 'close' }
}

export interface EvolutionParticipant {
  id: string
  admin?: string | null
  /** Campos variam por versão/canal da Evolution — todos opcionais */
  jid?: string
  lid?: string
  phoneNumber?: string
  name?: string
  notify?: string
  pushName?: string
}

export interface EvolutionContact {
  id?: string
  remoteJid?: string
  pushName?: string
  name?: string
}

export const whatsappService = {
  /**
   * Cria um número. O nome da instância é gerado pela Edge Function (117):
   * a Evolution é compartilhada e o painel não escolhe nome nenhum. Volta o
   * número já registrado, com dono, e o primeiro QR quando a Evolution manda.
   */
  async createSession() {
    return request<{ session?: import('@/types').WhatsAppSession; qrcode?: QRCodeData | null; error?: string }>(
      '/instance/create',
      { method: 'POST', body: {} },
    )
  },

  /** Retorna QR Code para conexão */
  async getQRCode(instanceName: string) {
    return request<QRCodeData>(`/instance/connect/${instanceName}`)
  },

  /** Estado da conexão: open | connecting | close */
  async checkConnection(instanceName: string) {
    return request<ConnectionState>(`/instance/connectionState/${instanceName}`)
  },

  async restartSession(instanceName: string) {
    return request(`/instance/restart/${instanceName}`, { method: 'POST' })
  },

  async logoutSession(instanceName: string) {
    return request(`/instance/logout/${instanceName}`, { method: 'DELETE' })
  },

  async deleteSession(instanceName: string) {
    return request(`/instance/delete/${instanceName}`, { method: 'DELETE' })
  },

  async fetchInstances() {
    return request('/instance/fetchInstances')
  },

  /** Envia texto para um número/grupo (jid) */
  async sendText(instanceName: string, number: string, text: string) {
    return request(`/message/sendText/${instanceName}`, {
      method: 'POST',
      body: { number, text },
    })
  },

  /** Envia mídia por URL (image | video | document) */
  async sendMedia(
    instanceName: string,
    number: string,
    opts: { mediatype: 'image' | 'video' | 'document'; media: string; caption?: string; fileName?: string },
  ) {
    return request(`/message/sendMedia/${instanceName}`, {
      method: 'POST',
      body: {
        number,
        mediatype: opts.mediatype,
        media: opts.media,
        caption: opts.caption,
        fileName: opts.fileName,
        mimetype: undefined,
      },
    })
  },

  async sendImage(instanceName: string, number: string, url: string, caption?: string) {
    return this.sendMedia(instanceName, number, { mediatype: 'image', media: url, caption })
  },

  async sendVideo(instanceName: string, number: string, url: string, caption?: string) {
    return this.sendMedia(instanceName, number, { mediatype: 'video', media: url, caption })
  },

  async sendDocument(instanceName: string, number: string, url: string, fileName?: string, caption?: string) {
    return this.sendMedia(instanceName, number, { mediatype: 'document', media: url, fileName, caption })
  },

  /** Áudio narrado (PTT) */
  async sendAudio(instanceName: string, number: string, audioUrl: string) {
    return request(`/message/sendWhatsAppAudio/${instanceName}`, {
      method: 'POST',
      body: { number, audio: audioUrl },
    })
  },

  // fetchAllGroups não mora mais aqui. Listar os grupos de um número é a
  // chamada mais cara da Evolution e o navegador não aguenta esperar: quem a
  // faz é o worker, e o painel lê o resultado da tabela session_groups. Ver
  // groupService.listDiscovered e a migration 067.

  /** Participantes de um grupo */
  async fetchParticipants(instanceName: string, groupJid: string) {
    return request<{ participants: EvolutionParticipant[] }>(
      `/group/participants/${instanceName}?groupJid=${encodeURIComponent(groupJid)}`,
    )
  },

  /** Contatos da instância (usado para resolver nomes dos participantes) */
  async findContacts(instanceName: string) {
    return request<EvolutionContact[]>(`/chat/findContacts/${instanceName}`, {
      method: 'POST',
      body: { where: {} },
    })
  },

  /** Cria um grupo real no WhatsApp e retorna seus dados (incl. JID) */
  async createGroup(instanceName: string, subject: string, participants: string[], description?: string) {
    return request<{ id?: string; subject?: string }>(`/group/create/${instanceName}`, {
      method: 'POST',
      body: { subject, description, participants },
    })
  },

  /** Adiciona/remove participantes de um grupo (números com DDI, só dígitos) */
  async updateParticipants(
    instanceName: string,
    groupJid: string,
    action: 'add' | 'remove' | 'promote' | 'demote',
    participants: string[],
  ) {
    return request<{ updateParticipants?: Array<{ jid?: string; status?: string }> }>(
      `/group/updateParticipant/${instanceName}?groupJid=${encodeURIComponent(groupJid)}`,
      { method: 'POST', body: { action, participants } },
    )
  },

  /** Configura webhook da instância para o receiver */
  async setWebhook(instanceName: string, webhookUrl: string, events: string[]) {
    return request(`/webhook/set/${instanceName}`, {
      method: 'POST',
      body: {
        webhook: {
          enabled: true,
          url: webhookUrl,
          events,
        },
      },
    })
  },
}
