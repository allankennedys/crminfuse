/**
 * queueService — operações da fila de envio (lado do painel).
 *
 * O processamento acontece no servidor (Edge Function `worker`, acionada
 * pelo pg_cron a cada minuto). Após enfileirar, o painel "cutuca" o worker
 * para o envio sair na hora em vez de esperar o próximo minuto.
 */

import { supabase } from '@/lib/supabase'
import type { QueueItem, QueuePriority } from '@/types'

/** Aciona o worker imediatamente (fire-and-forget) */
function kickWorker() {
  supabase.functions.invoke('worker', { body: {} }).catch(() => {
    /* o cron pega no próximo minuto */
  })
}

export const queueService = {
  /** Enfileira uma mensagem para um ou mais grupos (único ponto de entrada de envio) */
  async enqueue(opts: {
    organizationId: string
    messageId: string
    groupIds: string[]
    priority?: QueuePriority
    /** null/undefined = automático: o worker escolhe entre os números conectados */
    sessionId?: string | null
  }) {
    const rows = opts.groupIds.map((groupId) => ({
      organization_id: opts.organizationId,
      message_id: opts.messageId,
      group_id: groupId,
      session_id: opts.sessionId ?? null,
      priority: opts.priority ?? 'normal',
    }))

    const { data, error } = await supabase.from('message_queue').insert(rows).select()
    if (error) throw error

    // Log obrigatório de entrada na fila
    await supabase.from('message_logs').insert(
      (data as QueueItem[]).map((q) => ({
        organization_id: q.organization_id,
        queue_id: q.id,
        message_id: q.message_id,
        group_id: q.group_id,
        status: 'queued' as const,
      })),
    )

    kickWorker()
    return data as QueueItem[]
  },

  async cancel(queueId: string) {
    const { error } = await supabase.from('message_queue')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', queueId)
      .in('status', ['pending'])
    if (error) throw error
  },

  async retryFailed(queueId: string) {
    const { error } = await supabase.from('message_queue')
      .update({
        status: 'pending',
        attempts: 0,
        error: null,
        next_attempt_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', queueId)
    if (error) throw error
    kickWorker()
  },

  kickWorker,
}
