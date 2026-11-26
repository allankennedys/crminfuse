/**
 * broadcastService — envio em massa (migration 167).
 * Leitura direto das tabelas (RLS: quem edita contatos); escrita pela Edge Function `broadcast`.
 */
import { supabase, FunctionRegion } from '@/lib/supabase'

const BUCKET = 'wa-media'

export type BroadcastKind = 'text' | 'image' | 'video' | 'audio' | 'document'
export type BroadcastStatus = 'agendada' | 'enviando' | 'concluida' | 'cancelada' | 'falhou'

export interface Broadcast {
  id: string
  name: string
  session_id: string | null
  kind: BroadcastKind
  body: string | null
  media_name: string | null
  delay_seconds: number
  scheduled_at: string
  status: BroadcastStatus
  error: string | null
  total: number
  sent: number
  failed: number
  created_at: string
  finished_at: string | null
}

export interface BroadcastRecipient {
  id: string
  name: string | null
  phone: string
  status: 'pendente' | 'enviado' | 'falha'
  error: string | null
  sent_at: string | null
}

export type Audience =
  | { mode: 'ids'; ids: string[] }
  | { mode: 'all'; stage_id?: string; tags?: string[] }

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('broadcast', { body, region: FunctionRegion.EuWest3 })
  if (error) {
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

export const broadcastService = {
  async list(): Promise<Broadcast[]> {
    const { data, error } = await supabase
      .from('broadcasts')
      .select('id, name, session_id, kind, body, media_name, delay_seconds, scheduled_at, status, error, total, sent, failed, created_at, finished_at')
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) throw error
    return (data as Broadcast[] | null) ?? []
  },

  async recipients(id: string, status?: 'falha'): Promise<BroadcastRecipient[]> {
    let q = supabase.from('broadcast_recipients').select('id, name, phone, status, error, sent_at').eq('broadcast_id', id)
    if (status) q = q.eq('status', status)
    const { data, error } = await q.order('status', { ascending: false }).order('id').limit(1000)
    if (error) throw error
    return (data as BroadcastRecipient[] | null) ?? []
  },

  /** Sobe o anexo (R2 ou Storage, conforme o servidor manda) e devolve onde ficou. */
  async uploadMedia(file: File): Promise<{ path: string; mime: string; name: string }> {
    const mime = file.type || 'application/octet-stream'
    const alvo = await invoke<{ store: 'r2' | 'supabase'; path: string; url?: string }>({ action: 'upload_url', name: file.name })
    if (alvo.store === 'r2' && alvo.url) {
      const res = await fetch(alvo.url, { method: 'PUT', body: file, headers: { 'Content-Type': mime } }).catch(() => null)
      if (!res?.ok) throw new Error('Falha ao subir o arquivo. Tente de novo.')
    } else {
      const { error } = await supabase.storage.from(BUCKET).upload(alvo.path, file, { contentType: mime })
      if (error) throw new Error(`Falha ao subir o arquivo: ${error.message}`)
    }
    return { path: alvo.path, mime, name: file.name }
  },

  async create(p: {
    name: string; session_id: string; kind: BroadcastKind; body: string
    media?: { path: string; mime: string; name: string }
    scheduled_at?: string; delay_seconds: number; audience: Audience
  }): Promise<{ id: string; total: number; sem_telefone: number }> {
    return invoke({ action: 'create', ...p })
  },

  async cancel(id: string): Promise<void> {
    await invoke({ action: 'cancel', id })
  },

  /** Quantos contatos com telefone entram na escolha "todos" (com os filtros). */
  async countAudience(stageId?: string, tags?: string[]): Promise<number> {
    let q = supabase.from('crm_contacts').select('id', { count: 'exact', head: true }).not('phone', 'is', null)
    if (stageId) q = q.eq('stage_id', stageId)
    if (tags?.length) q = q.contains('tags', tags)
    const { count, error } = await q
    if (error) throw error
    return count ?? 0
  },
}

export function kindOfFile(file: File): BroadcastKind {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return 'document'
}
