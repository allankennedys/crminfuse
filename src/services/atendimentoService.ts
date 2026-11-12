/**
 * atendimentoService — chat de WhatsApp do CRM (migration 116).
 *
 * Leitura direto das tabelas: a RLS já devolve só o que o usuário pode ver
 * (o atendente, só as conversas atribuídas a ele). Tudo que escreve passa
 * por RPC ou pela Edge Function wa-chat, que conferem a permissão no banco.
 */

import { supabase, FunctionRegion } from '@/lib/supabase'
import type {
  WaAgentLimit, WaAttendant, WaClientCard, WaConversation, WaConversationStatus, WaEvent, WaMessage, WaReport,
  WaRoutingRule, WaSession, WaSettings, WaSourceRule,
} from '@/types'

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
  const { data, error } = await supabase.functions.invoke('wa-chat', { body, region: FunctionRegion.EuWest3 })
  if (error) {
    // A mensagem crua do cliente é técnica ("Edge Function returned…"); sem
    // corpo legível, fica a genérica.
    let msg = 'Falha de comunicação com o servidor. Tente de novo.'
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

  /** Foto do cliente. force = a imagem não carregou (link expirado). */
  async refreshAvatar(conversationId: string, force = false): Promise<string | null> {
    const r = await invokeChat<{ avatar_url: string | null }>({ action: 'avatar', conversation_id: conversationId, force })
    return r.avatar_url
  },

  async markRead(conversationId: string): Promise<void> {
    await invokeChat({ action: 'mark_read', conversation_id: conversationId })
  },

  /**
   * Atribuir, transferir, assumir ou devolver à fila (userId null). Quem pode
   * o quê é decidido por wa_transfer (119); a nota vai para o histórico.
   */
  async transfer(conversationId: string, userId: string | null, note?: string): Promise<void> {
    const { error } = await supabase.rpc('wa_transfer', {
      p_conversation: conversationId, p_to: userId, p_note: note?.trim() || null,
    })
    if (error) throw error
  },

  async assign(conversationId: string, userId: string | null): Promise<void> {
    return this.transfer(conversationId, userId)
  },

  async listEvents(conversationId: string): Promise<WaEvent[]> {
    const { data, error } = await supabase
      .from('wa_conversation_events')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at')
      .returns<WaEvent[]>()
    if (error) throw error
    return data ?? []
  },

  // ---------- Configuração (119) ----------

  /** Sem linha salva = padrão: restrito e manual. */
  async getSettings(organizationId: string): Promise<WaSettings> {
    const { data } = await supabase
      .from('wa_settings')
      .select('organization_id, restrict_to_assigned, assign_mode, fixed_user, pool, max_open_per_agent, conclusion_reasons')
      .eq('organization_id', organizationId)
      .maybeSingle<WaSettings>()
    return data ?? {
      organization_id: organizationId, restrict_to_assigned: true, assign_mode: 'manual', fixed_user: null, pool: [],
      max_open_per_agent: null,
      conclusion_reasons: ['Dúvida resolvida', 'Venda realizada', 'Sem retorno do cliente', 'Encaminhado para outro setor'],
    }
  },

  async saveSettings(s: WaSettings, userId: string): Promise<void> {
    const { error } = await supabase.from('wa_settings').upsert({
      ...s, updated_at: new Date().toISOString(), updated_by: userId,
    })
    if (error) throw error
  },

  async listAgentLimits(): Promise<WaAgentLimit[]> {
    const { data, error } = await supabase.from('wa_agent_limits').select('user_id, max_open').returns<WaAgentLimit[]>()
    if (error) throw error
    return data ?? []
  },

  /** 'padrao' apaga a exceção; null = livre; número = limite próprio. */
  async setAgentLimit(organizationId: string, userId: string, value: 'padrao' | number | null) {
    if (value === 'padrao') {
      const { error } = await supabase.from('wa_agent_limits').delete().eq('user_id', userId)
      if (error) throw error
      return
    }
    const { error } = await supabase.from('wa_agent_limits')
      .upsert({ organization_id: organizationId, user_id: userId, max_open: value })
    if (error) throw error
  },

  /** Distribui a fila com a configuração atual. Devolve quantas saíram. */
  async dispatchNow(): Promise<number> {
    const { data, error } = await supabase.rpc('wa_dispatch_now')
    if (error) throw error
    return Number(data ?? 0)
  },

  async conclude(conversationId: string, reason: string | null, note: string): Promise<void> {
    const { error } = await supabase.rpc('wa_conclude', {
      p_conversation: conversationId, p_reason: reason, p_note: note.trim() || null,
    })
    if (error) throw error
  },

  async reopen(conversationId: string): Promise<void> {
    const { error } = await supabase.rpc('wa_reopen', { p_conversation: conversationId })
    if (error) throw error
  },

  async report(from: string, to: string): Promise<WaReport> {
    const { data, error } = await supabase.rpc('wa_report', { p_from: from, p_to: to })
    if (error) throw error
    return data as WaReport
  },

  // ---------- Cartão do cliente (121) ----------

  async clientCard(conversationId: string): Promise<WaClientCard> {
    const { data, error } = await supabase.rpc('wa_client_card', { p_conversation: conversationId })
    if (error) throw error
    return data as WaClientCard
  },

  async clientUpdate(conversationId: string, f: { name: string; email: string; origem: string }): Promise<WaClientCard> {
    const { data, error } = await supabase.rpc('wa_client_update', {
      p_conversation: conversationId, p_name: f.name, p_email: f.email, p_origem: f.origem,
    })
    if (error) throw error
    return data as WaClientCard
  },

  /** Lança a venda no contato da conversa. from_ad = vai para a Meta. */
  async launchSale(
    conversationId: string,
    s: { valueCents: number; payment: string | null; soldAt: string | null; note: string },
  ): Promise<{ sale_id: string; from_ad: boolean }> {
    const { data, error } = await supabase.rpc('wa_launch_sale', {
      p_conversation: conversationId,
      p_value_cents: s.valueCents,
      p_payment: s.payment,
      p_sold_at: s.soldAt,
      p_note: s.note || null,
    })
    if (error) throw error
    return data as { sale_id: string; from_ad: boolean }
  },

  // ---------- Iniciar conversa (126) ----------

  async searchContacts(term: string): Promise<{ id: string; name: string; phone: string | null; origem: string | null }[]> {
    const { data, error } = await supabase.rpc('wa_search_contacts', { p_term: term })
    if (error) throw error
    return (data as { id: string; name: string; phone: string | null; origem: string | null }[] | null) ?? []
  },

  /** Números ligados ao atendimento — de onde dá para iniciar conversa. */
  async startSessions(): Promise<{ id: string; instance_name: string; phone_number: string | null; status: string }[]> {
    const { data, error } = await supabase.rpc('wa_start_sessions')
    if (error) throw error
    return (data as { id: string; instance_name: string; phone_number: string | null; status: string }[] | null) ?? []
  },

  /** Confere o número no WhatsApp e devolve a conversa (nova ou a que já existe). */
  async startConversation(p: { sessionId: string; contactId?: string; phone?: string }): Promise<string> {
    const r = await invokeChat<{ conversation_id: string }>({
      action: 'start', session_id: p.sessionId, contact_id: p.contactId, phone: p.phone,
    })
    return r.conversation_id
  },

  // ---------- Frases de origem (121) ----------

  async listSourceRules(): Promise<WaSourceRule[]> {
    const { data, error } = await supabase
      .from('wa_source_rules')
      .select('*')
      .order('position')
      .order('created_at')
      .returns<WaSourceRule[]>()
    if (error) throw error
    return data ?? []
  },

  async addSourceRule(r: Pick<WaSourceRule, 'organization_id' | 'position' | 'phrase' | 'origem'>) {
    const { error } = await supabase.from('wa_source_rules').insert(r)
    if (error) throw error
  },

  async updateSourceRule(id: string, patch: Partial<Pick<WaSourceRule, 'active' | 'position'>>) {
    const { error } = await supabase.from('wa_source_rules').update(patch).eq('id', id)
    if (error) throw error
  },

  async deleteSourceRule(id: string) {
    const { error } = await supabase.from('wa_source_rules').delete().eq('id', id)
    if (error) throw error
  },

  async listRules(): Promise<WaRoutingRule[]> {
    const { data, error } = await supabase
      .from('wa_routing_rules')
      .select('*')
      .order('position')
      .order('created_at')
      .returns<WaRoutingRule[]>()
    if (error) throw error
    return data ?? []
  },

  async addRule(rule: Pick<WaRoutingRule, 'organization_id' | 'position' | 'kind' | 'session_id' | 'keywords' | 'target_user'>) {
    const { error } = await supabase.from('wa_routing_rules').insert(rule)
    if (error) throw error
  },

  async updateRule(id: string, patch: Partial<Pick<WaRoutingRule, 'position' | 'active'>>) {
    const { error } = await supabase.from('wa_routing_rules').update(patch).eq('id', id)
    if (error) throw error
  },

  async deleteRule(id: string) {
    const { error } = await supabase.from('wa_routing_rules').delete().eq('id', id)
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
