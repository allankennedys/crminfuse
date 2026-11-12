/**
 * atendimentoService — chat de WhatsApp do CRM (migration 116).
 *
 * Leitura direto das tabelas: a RLS já devolve só o que o usuário pode ver
 * (o atendente, só as conversas atribuídas a ele). Tudo que escreve passa
 * por RPC ou pela Edge Function wa-chat, que conferem a permissão no banco.
 */

import { supabase } from '@/lib/supabase'
import type { WaAttendant, WaConversation, WaConversationStatus, WaMessage, WaSession } from '@/types'

export type WaScope = 'minhas' | 'fila' | 'todas'

export interface WaListFilters {
  scope: WaScope
  status: WaConversationStatus
  userId: string
  /** Só com scope 'todas': recorta por atendente. */
  assignee?: string
  search?: string
}

const BUCKET = 'wa-media'
const PAGE = 60

/** Erro legível da Edge Function — o supabase-js esconde o corpo da resposta. */
async function invokeChat<T = unknown>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('wa-chat', { body })
  if (error) {
    let msg = error.message
    try {
      const ctx = (error as { context?: Response }).context
      const j = ctx ? await ctx.json() : null
      if (j?.error) msg = j.error
    } catch { /* corpo não era JSON */ }
    throw new Error(msg)
  }
  if (data?.error) throw new Error(data.error)
  return data as T
}

/** Nome de arquivo seguro para o storage (sem acento, espaço nem barra). */
function safeName(name: string): string {
  const clean = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_')
  return clean.slice(-80) || 'arquivo'
}

export const atendimentoService = {
  async listConversations(f: WaListFilters): Promise<WaConversation[]> {
    let q = supabase
      .from('wa_conversations')
      .select('*, crm_contacts(name)')
      .eq('status', f.status)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(300)

    if (f.scope === 'minhas') q = q.eq('assigned_to', f.userId)
    else if (f.scope === 'fila') q = q.is('assigned_to', null)
    else if (f.assignee) q = q.eq('assigned_to', f.assignee)

    const term = (f.search ?? '').replace(/[%,()*]/g, ' ').trim()
    if (term) {
      const digits = term.replace(/\D/g, '')
      const parts = [`push_name.ilike.%${term}%`]
      if (digits.length >= 3) parts.push(`phone.like.%${digits}%`)
      q = q.or(parts.join(','))
    }

    const { data, error } = await q.returns<WaConversation[]>()
    if (error) throw error
    return data ?? []
  },

  /** Conversas abertas sem atendente — o número do selo "Fila". */
  async queueCount(): Promise<number> {
    const { count, error } = await supabase
      .from('wa_conversations')
      .select('id', { count: 'exact', head: true })
      .is('assigned_to', null)
      .eq('status', 'aberta')
    if (error) return 0
    return count ?? 0
  },

  /** null = não existe ou o usuário perdeu o acesso (foi transferida). */
  async getConversation(id: string): Promise<WaConversation | null> {
    const { data } = await supabase
      .from('wa_conversations')
      .select('*, crm_contacts(name)')
      .eq('id', id)
      .maybeSingle<WaConversation>()
    return data ?? null
  },

  /** As últimas mensagens, em ordem cronológica. `before` pagina para trás. */
  async listMessages(conversationId: string, before?: string): Promise<{ items: WaMessage[]; hasMore: boolean }> {
    let q = supabase
      .from('wa_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('wa_timestamp', { ascending: false })
      .limit(PAGE)
    if (before) q = q.lt('wa_timestamp', before)
    const { data, error } = await q.returns<WaMessage[]>()
    if (error) throw error
    const rows = data ?? []
    return { items: rows.reverse(), hasMore: rows.length === PAGE }
  },

  async sendText(conversationId: string, text: string): Promise<WaMessage> {
    const r = await invokeChat<{ message: WaMessage }>({ action: 'send_text', conversation_id: conversationId, text })
    return r.message
  },

  async sendFile(conv: WaConversation, file: File, caption?: string): Promise<WaMessage> {
    const path = `${conv.organization_id}/${conv.id}/out-${crypto.randomUUID()}-${safeName(file.name)}`
    const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
      contentType: file.type || 'application/octet-stream',
    })
    if (error) throw new Error(`Falha ao subir o arquivo: ${error.message}`)

    const r = await invokeChat<{ message: WaMessage }>({
      action: 'send_media',
      conversation_id: conv.id,
      path,
      mime: file.type || 'application/octet-stream',
      name: file.name,
      caption: caption || undefined,
    })
    return r.message
  },

  async markRead(conversationId: string): Promise<void> {
    await invokeChat({ action: 'mark_read', conversation_id: conversationId })
  },

  async assign(conversationId: string, userId: string | null): Promise<void> {
    const { error } = await supabase.rpc('wa_assign', { p_conversation: conversationId, p_user: userId })
    if (error) throw error
  },

  async setStatus(conversationId: string, status: WaConversationStatus): Promise<void> {
    const { error } = await supabase.rpc('wa_set_status', { p_conversation: conversationId, p_status: status })
    if (error) throw error
  },

  async attendants(): Promise<WaAttendant[]> {
    const { data, error } = await supabase.rpc('wa_attendants')
    if (error) throw error
    return (data as WaAttendant[] | null) ?? []
  },

  async sessions(): Promise<WaSession[]> {
    const { data, error } = await supabase.rpc('wa_sessions_list')
    if (error) throw error
    return (data as WaSession[] | null) ?? []
  },

  /** Nome de quem aparece como atendente/remetente. A RLS de users já é por organização. */
  async userNames(): Promise<Map<string, string>> {
    const { data } = await supabase.from('users').select('id, full_name, username, email')
    return new Map((data ?? []).map((u) => [u.id as string, (u.full_name || u.username || u.email) as string]))
  },

  async signedUrls(paths: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    if (!paths.length) return out
    const { data } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600)
    for (const r of data ?? []) if (r.path && r.signedUrl) out.set(r.path, r.signedUrl)
    return out
  },

  // ---------- Números ----------

  async sessionInfo(sessionId: string) {
    return invokeChat<{
      chat_enabled: boolean
      webhook: { host: string | null; enabled: boolean; ours: boolean } | null
    }>({ action: 'session_info', session_id: sessionId })
  },

  async enableSession(sessionId: string): Promise<void> {
    await invokeChat({ action: 'enable', session_id: sessionId })
  },

  async disableSession(sessionId: string): Promise<{ restored: boolean }> {
    return invokeChat<{ restored: boolean }>({ action: 'disable', session_id: sessionId })
  },
}

// ---------- Formatação ----------

/** +55 (11) 98765-4321 a partir dos dígitos com DDI. */
export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return ''
  const d = phone.replace(/\D/g, '')
  const br = d.match(/^55(\d{2})(\d{4,5})(\d{4})$/)
  if (br) return `+55 (${br[1]}) ${br[2]}-${br[3]}`
  return `+${d}`
}

export function conversationName(c: WaConversation): string {
  return c.crm_contacts?.name?.trim() || c.push_name?.trim() || formatPhone(c.phone) || 'Contato sem número'
}

export function sessionLabel(s: WaSession | undefined): string {
  if (!s) return 'Número removido'
  return s.phone_number ? formatPhone(s.phone_number) : s.instance_name
}
