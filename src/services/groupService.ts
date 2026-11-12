/**
 * groupService — CRUD de grupos + sincronização com Evolution API.
 */

import { supabase } from '@/lib/supabase'
import { whatsappService } from './whatsappService'
import { queueService } from './queueService'
import type { Group, GroupParticipant, ParticipantJob, WhatsAppSession } from '@/types'

/**
 * Adição/remoção em massa roda no servidor (worker), em lotes pequenos:
 * muitos números de uma vez é sinal de spam para o WhatsApp.
 * Aqui só entra o primeiro lote da criação de grupo (necessário na hora).
 */
const PARTICIPANT_BATCH_SIZE = 10

function normalizePhones(phones: string[]): string[] {
  return phones.map((p) => p.replace(/\D/g, '')).filter((p) => p.length >= 10)
}

/** Grupo do WhatsApp ainda não importado, como aparece na tela de importação. */
export interface RemoteGroup {
  id: string
  subject: string
  desc?: string
  size?: number
}

/** Estado do pedido de listagem de grupos de um número (tabela group_discovery). */
export interface DiscoveryStatus {
  status: 'pending' | 'running' | 'done' | 'failed'
  found: number
  error: string | null
  finished_at: string | null
}

/** 5511999999999@s.whatsapp.net → +55 (11) 99999-9999 */
function formatPhone(jid: string): string {
  const digits = jid.split('@')[0].replace(/\D/g, '')
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4)
    const rest = digits.slice(4)
    const split = rest.length - 4
    return `+55 (${ddd}) ${rest.slice(0, split)}-${rest.slice(split)}`
  }
  return `+${digits}`
}

export const groupService = {
  /**
   * Lista grupos. Por padrão só retorna grupos com ao menos um número
   * conectado — se o número desconectar ou sair do painel, o grupo some.
   * Use { includeDisconnected: true } para listar todos.
   */
  async list(opts: { includeDisconnected?: boolean } = {}) {
    const { data, error } = await supabase
      .from('groups')
      .select('*, group_sessions(whatsapp_sessions(status))')
      .order('created_at', { ascending: false })
    if (error) throw error

    type Row = Group & {
      group_sessions: Array<{ whatsapp_sessions: { status: string } | null }>
    }

    const rows = (data ?? []) as Row[]
    const filtered = opts.includeDisconnected
      ? rows
      : rows.filter((g) =>
          g.group_sessions.some((link) => link.whatsapp_sessions?.status === 'connected'),
        )

    // Remove o campo aninhado antes de devolver
    return filtered.map(({ group_sessions: _gs, ...group }) => group as Group)
  },

  /**
   * Jids de TODOS os grupos cadastrados, sem o filtro de número conectado
   * que `list()` aplica. É a trava anti-duplicata da importação: `list()`
   * esconde grupo cujo número desconectou, e um jid escondido volta a ser
   * oferecido para importar — `groups.group_jid` não tem unique, então o
   * banco aceita a segunda linha calado.
   */
  async listJids(): Promise<Set<string>> {
    const { data, error } = await supabase
      .from('groups')
      .select('group_jid')
      .not('group_jid', 'is', null)
    if (error) throw error
    return new Set((data ?? []).map((r) => r.group_jid as string))
  },

  async create(opts: {
    organizationId: string
    name: string
    description?: string
    groupJid?: string
    sessionIds?: string[]
  }) {
    const { data, error } = await supabase.from('groups').insert({
      organization_id: opts.organizationId,
      name: opts.name,
      description: opts.description ?? null,
      group_jid: opts.groupJid ?? null,
    }).select().single<Group>()
    if (error) throw error

    if (opts.sessionIds && opts.sessionIds.length > 0) {
      await this.setSessions(data.id, opts.sessionIds)
    }
    return data
  },

  async update(groupId: string, patch: Partial<Pick<Group, 'name' | 'description' | 'group_jid' | 'is_active'>>) {
    const { error } = await supabase.from('groups').update(patch).eq('id', groupId)
    if (error) throw error
  },

  async remove(groupId: string) {
    const { error } = await supabase.from('groups').delete().eq('id', groupId)
    if (error) throw error
  },

  /** Substitui o conjunto de sessões associadas ao grupo */
  async setSessions(groupId: string, sessionIds: string[]) {
    await supabase.from('group_sessions').delete().eq('group_id', groupId)
    if (sessionIds.length > 0) {
      const { error } = await supabase.from('group_sessions').insert(
        sessionIds.map((session_id) => ({ group_id: groupId, session_id })),
      )
      if (error) throw error
    }
  },

  async getSessions(groupId: string) {
    const { data, error } = await supabase
      .from('group_sessions')
      .select('session_id')
      .eq('group_id', groupId)
    if (error) throw error
    return (data ?? []).map((r) => r.session_id as string)
  },

  /**
   * Status de sincronização por grupo (contagem de participantes + data da
   * última sincronização). Agregação no banco via RPC — devolve um mapa por id.
   */
  async getSyncStatus(): Promise<Record<string, { count: number; lastSyncedAt: string | null }>> {
    const { data, error } = await supabase.rpc('groups_sync_status')
    if (error) {
      console.error('groups_sync_status:', error.message)
      return {}
    }
    const map: Record<string, { count: number; lastSyncedAt: string | null }> = {}
    for (const r of (data ?? []) as Array<{ group_id: string; participant_count: number; last_synced_at: string | null }>) {
      map[r.group_id] = { count: Number(r.participant_count), lastSyncedAt: r.last_synced_at }
    }
    return map
  },

  async getParticipants(groupId: string) {
    const { data, error } = await supabase
      .from('group_participants')
      .select('*')
      .eq('group_id', groupId)
      .order('name')
      .returns<GroupParticipant[]>()
    if (error) throw error
    return data
  },

  /**
   * Cria o grupo de verdade no WhatsApp com o primeiro lote de participantes.
   * Retorna o JID e os números restantes (que viram job no servidor).
   */
  async createRemoteGroup(
    session: WhatsAppSession,
    name: string,
    phones: string[],
    description?: string,
  ): Promise<{ jid: string; remaining: string[] }> {
    const normalized = normalizePhones(phones)
    if (normalized.length === 0) {
      throw new Error('Informe ao menos um participante — formato com DDI, ex: 5511999999999')
    }

    const firstBatch = normalized.slice(0, PARTICIPANT_BATCH_SIZE)
    const remaining = normalized.slice(PARTICIPANT_BATCH_SIZE)

    const res = await whatsappService.createGroup(session.instance_name, name, firstBatch, description)
    if (!res.ok || !res.data?.id) {
      throw new Error('Não foi possível criar o grupo no WhatsApp. Verifique se o número está conectado.')
    }
    return { jid: res.data.id, remaining }
  },

  /**
   * Registra um job de adição/remoção — o servidor processa em lotes
   * com pausa, mesmo com o painel fechado.
   */
  async createParticipantJob(
    organizationId: string,
    groupId: string,
    sessionId: string,
    action: 'add' | 'remove',
    phones: string[],
  ): Promise<ParticipantJob> {
    const normalized = normalizePhones(phones)
    if (normalized.length === 0) {
      throw new Error('Nenhum número válido — use o formato com DDI, ex: 5511999999999')
    }

    const { data, error } = await supabase.from('participant_jobs').insert({
      organization_id: organizationId,
      group_id: groupId,
      session_id: sessionId,
      action,
      phones: normalized,
      total: normalized.length,
    }).select().single<ParticipantJob>()

    if (error) throw error
    queueService.kickWorker()
    return data
  },

  async getParticipantJob(jobId: string): Promise<ParticipantJob | null> {
    const { data } = await supabase
      .from('participant_jobs')
      .select('*')
      .eq('id', jobId)
      .maybeSingle<ParticipantJob>()
    return data
  },

  /**
   * Grupos de um número, lidos do cache (session_groups). Instantâneo — não
   * fala com o WhatsApp. Quem preenche esse cache é o worker, a partir de um
   * pedido criado por `requestDiscovery`.
   *
   * POR QUE ASSIM E NÃO DIRETO
   *
   * Listar grupos é `/group/fetchAllGroups`, que pede ao WhatsApp a metadata
   * de todos os grupos do número de uma vez. Com muitos grupos essa chamada
   * passa do tempo da Edge Function e a tela nunca abre. Tirá-la do caminho
   * do usuário resolve as duas coisas de uma vez: ninguém espera, e a chamada
   * cara acontece uma vez por atualização em vez de uma por abertura de tela.
   *
   * `syncedAt` é quando a lista foi montada — a tela mostra para a pessoa
   * decidir se vale atualizar.
   */
  async listDiscovered(sessionId: string): Promise<{ groups: RemoteGroup[]; syncedAt: string | null }> {
    const { data, error } = await supabase
      .from('session_groups')
      .select('group_jid, subject, description, size, synced_at')
      .eq('session_id', sessionId)
      .order('subject')
    if (error) throw error

    const rows = (data ?? []) as Array<{
      group_jid: string
      subject: string
      description: string | null
      size: number | null
      synced_at: string
    }>

    return {
      groups: rows.map((r) => ({
        id: r.group_jid,
        subject: r.subject,
        desc: r.description ?? undefined,
        size: r.size ?? undefined,
      })),
      syncedAt: rows[0]?.synced_at ?? null,
    }
  },

  /**
   * Registra o pedido de refazer a lista de grupos do número. Quem executa é
   * um job de pg_cron no banco (ver migration 067), que roda a cada minuto —
   * não há worker para cutucar aqui, e por isso a espera começa com até um
   * minuto de fila antes da chamada em si.
   *
   * A RPC ignora o pedido se já houver um em andamento; é ela que segura o
   * custo, porque clique repetido não pode virar chamada repetida ao WhatsApp.
   */
  async requestDiscovery(sessionId: string): Promise<void> {
    const { error } = await supabase.rpc('request_group_discovery', { p_session_id: sessionId })
    if (error) throw new Error(error.message)
  },

  /** Em que pé está o pedido de listagem — a tela usa para o polling. */
  async getDiscoveryStatus(sessionId: string): Promise<DiscoveryStatus | null> {
    const { data } = await supabase
      .from('group_discovery')
      .select('status, found, error, finished_at')
      .eq('session_id', sessionId)
      .maybeSingle<DiscoveryStatus>()
    return data
  },

  /**
   * Busca o mapa jid→nome dos contatos da instância. É uma chamada pesada
   * (traz todos os contatos), então na sincronização em massa é feita UMA vez
   * por número e reaproveitada entre os grupos.
   */
  async fetchContactsMap(instanceName: string): Promise<Map<string, string>> {
    const namesByJid = new Map<string, string>()
    try {
      const contacts = await whatsappService.findContacts(instanceName)
      if (contacts.ok && Array.isArray(contacts.data)) {
        for (const c of contacts.data) {
          const jid = c.remoteJid ?? c.id
          const name = c.pushName ?? c.name
          if (jid && name) namesByJid.set(jid, name)
        }
      }
    } catch {
      // sem contatos, seguimos só com o telefone
    }
    return namesByJid
  },

  /**
   * Sincroniza participantes de um grupo via Evolution API (nome + telefone).
   * `contactsByJid` opcional evita refazer o findContacts (usado no lote).
   */
  async syncParticipants(group: Group, session: WhatsAppSession, contactsByJid?: Map<string, string>) {
    if (!group.group_jid) throw new Error('Grupo não vinculado a um grupo real do WhatsApp')
    const res = await whatsappService.fetchParticipants(session.instance_name, group.group_jid)
    if (!res.ok) throw new Error('Não foi possível buscar os participantes. Verifique se o número está conectado.')

    const participants = res.data?.participants ?? []
    const namesByJid = contactsByJid ?? await this.fetchContactsMap(session.instance_name)

    await supabase.from('group_participants').delete().eq('group_id', group.id)

    if (participants.length > 0) {
      const { error } = await supabase.from('group_participants').insert(
        participants.map((p) => {
          const phoneJid = [p.phoneNumber, p.jid, p.id].find((j) => j?.includes('@s.whatsapp.net')) ?? null
          return {
            group_id: group.id,
            jid: p.id,
            name: p.name ?? p.notify ?? p.pushName
              ?? namesByJid.get(p.id) ?? (p.jid ? namesByJid.get(p.jid) : undefined) ?? null,
            phone: phoneJid ? formatPhone(phoneJid) : null,
            is_admin: p.admin === 'admin' || p.admin === 'superadmin',
          }
        }),
      )
      if (error) throw error
    }
    return participants.length
  },

  /**
   * Agenda a sincronização de vários grupos NO SERVIDOR (um job 'sync' por
   * grupo em participant_jobs). O worker processa poucos por rodada, com cache
   * de contatos e pacing — continua mesmo com o painel fechado.
   */
  async createSyncJobs(
    organizationId: string,
    items: Array<{ groupId: string; sessionId: string }>,
  ): Promise<ParticipantJob[]> {
    if (items.length === 0) return []
    const { data, error } = await supabase.from('participant_jobs').insert(
      items.map((it) => ({
        organization_id: organizationId,
        group_id: it.groupId,
        session_id: it.sessionId,
        action: 'sync' as const,
        phones: [],
        total: 1,
      })),
    ).select().returns<ParticipantJob[]>()
    if (error) throw error
    queueService.kickWorker()
    return data ?? []
  },

  /** Progresso de um conjunto de jobs de sincronização (para o painel acompanhar). */
  async getSyncJobsProgress(ids: string[]): Promise<{
    done: number
    total: number
    failed: Array<{ groupId: string; error: string | null }>
  }> {
    if (ids.length === 0) return { done: 0, total: 0, failed: [] }
    const { data } = await supabase
      .from('participant_jobs')
      .select('status, group_id, error')
      .in('id', ids)
    const jobs = (data ?? []) as Array<{ status: string; group_id: string; error: string | null }>
    const finished = jobs.filter((j) => j.status === 'done' || j.status === 'failed')
    return {
      done: finished.length,
      total: ids.length,
      failed: jobs
        .filter((j) => j.status === 'failed')
        .map((j) => ({ groupId: j.group_id, error: j.error })),
    }
  },
}
