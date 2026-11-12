/**
 * schedulerService — CRUD de agendamentos (lado do painel).
 * A execução acontece no servidor: o worker verifica agendamentos
 * vencidos a cada minuto e os move para a fila automaticamente.
 */

import { supabase } from '@/lib/supabase'
import type { Schedule, QueuePriority } from '@/types'

/** Um agendamento lógico = uma linha por grupo, todas com o mesmo message_id. */
interface BatchInput {
  organizationId: string
  messageId: string
  groupIds: string[]
  scheduledAt: Date
  priority?: QueuePriority
  /** null/undefined = automático: o worker escolhe entre os números conectados */
  sessionId?: string | null
  timezone?: string
  createdBy?: string | null
}

export const schedulerService = {
  /** Agenda o mesmo conteúdo para um ou mais grupos (uma linha por grupo) */
  async create(opts: BatchInput) {
    const timezone = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const rows = opts.groupIds.map((groupId) => ({
      organization_id: opts.organizationId,
      message_id: opts.messageId,
      group_id: groupId,
      session_id: opts.sessionId ?? null,
      scheduled_at: opts.scheduledAt.toISOString(),
      priority: opts.priority ?? 'normal',
      timezone,
      created_by: opts.createdBy ?? null,
    }))

    const { data, error } = await supabase.from('schedules').insert(rows).select().returns<Schedule[]>()
    if (error) throw error
    return data
  },

  /**
   * Lê o lote inteiro de um message_id — todas as linhas, de qualquer status —
   * e só devolve se ele ainda puder ser editado com segurança.
   *
   * O worker roda a cada minuto e pode ter executado o lote enquanto o
   * formulário estava aberto. Ler só as linhas `scheduled` seria uma armadilha:
   * um grupo já executado sumiria da leitura, pareceria "grupo novo" e seria
   * reagendado — o grupo receberia a mesma mensagem duas vezes. Por isso a
   * leitura é sem filtro de status e qualquer linha fora de `scheduled` aborta.
   */
  async loadEditableBatch(messageId: string) {
    const { data, error } = await supabase.from('schedules')
      .select('id, group_id, status')
      .eq('message_id', messageId)
    if (error) throw error

    const rows = data ?? []
    if (rows.length === 0) {
      throw new Error('Este agendamento não existe mais. Recarregue a página.')
    }
    if (rows.some((r) => r.status !== 'scheduled')) {
      throw new Error(
        'Este agendamento começou a ser executado enquanto você editava. ' +
        'Recarregue a página para ver o estado atual.',
      )
    }
    return rows
  },

  /**
   * Edita um agendamento inteiro (todas as linhas do lote de um message_id).
   * Grupos desmarcados saem do lote (nunca foram enviados, então some em vez
   * de virar "cancelado"); grupos novos entram como linhas adicionais.
   */
  async updateBatch(opts: BatchInput) {
    const rows = await this.loadEditableBatch(opts.messageId)

    const wanted = new Set(opts.groupIds)
    const present = new Set(rows.map((r) => r.group_id))
    const removedIds = rows.filter((r) => !wanted.has(r.group_id)).map((r) => r.id)
    const addedGroupIds = opts.groupIds.filter((id) => !present.has(id))

    // Sem transação, a ordem importa: primeiro o que um retry refaz sem perda
    // (update e insert são idempotentes aqui), e a remoção por último. Se o
    // delete viesse antes, um erro seguinte deixaria os grupos já apagados e
    // o retry não teria mais como recuperá-los.
    const { error: updateError } = await supabase.from('schedules')
      .update({
        scheduled_at: opts.scheduledAt.toISOString(),
        priority: opts.priority ?? 'normal',
        session_id: opts.sessionId ?? null,
      })
      .eq('message_id', opts.messageId)
      .eq('status', 'scheduled')
    if (updateError) throw updateError

    if (addedGroupIds.length > 0) {
      await this.create({ ...opts, groupIds: addedGroupIds })
    }

    if (removedIds.length > 0) {
      // status='scheduled' de novo: se o worker executou a linha entre a
      // checagem e agora, ela virou registro de envio e não pode ser apagada.
      const { error } = await supabase.from('schedules')
        .delete()
        .in('id', removedIds)
        .eq('status', 'scheduled')
      if (error) throw error
    }
  },

  async cancel(scheduleId: string) {
    const { error } = await supabase.from('schedules')
      .update({ status: 'cancelled' })
      .eq('id', scheduleId)
      .eq('status', 'scheduled')
    if (error) throw error
  },

  /** Cancela vários agendamentos (as linhas ainda pendentes de um lote) */
  async cancelMany(scheduleIds: string[]) {
    if (scheduleIds.length === 0) return
    const { error } = await supabase.from('schedules')
      .update({ status: 'cancelled' })
      .in('id', scheduleIds)
      .eq('status', 'scheduled')
    if (error) throw error
  },

  async list() {
    const { data, error } = await supabase.from('schedules')
      .select('*')
      .order('scheduled_at', { ascending: true })
      .returns<Schedule[]>()
    if (error) throw error
    return data
  },
}
