import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Users, Trash2, Pencil, RefreshCw, Download, Search } from 'lucide-react'
import { groupService } from '@/services/groupService'
import type { RemoteGroup } from '@/services/groupService'
import { sessionService } from '@/services/sessionService'
import { useAuthStore } from '@/store/authStore'
import { toast } from '@/store/toastStore'
import { confirmDialog } from '@/store/confirmStore'
import { useRealtime } from '@/hooks/useRealtime'
import { Modal, Loader, EmptyState, StatusBadge, sessionLabel } from '@/components/ui'
import type { Group, GroupParticipant, WhatsAppSession } from '@/types'
import { format } from 'date-fns'

type SyncStatus = Record<string, { count: number; lastSyncedAt: string | null }>

interface GroupForm {
  name: string
  description: string
  groupJid: string
  sessionIds: string[]
}

const EMPTY_FORM: GroupForm = { name: '', description: '', groupJid: '', sessionIds: [] }

export function GroupsPage() {
  const profile = useAuthStore((s) => s.profile)
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({})
  const [search, setSearch] = useState('')
  const [sessions, setSessions] = useState<WhatsAppSession[]>([])
  const [editing, setEditing] = useState<Group | 'new' | null>(null)
  const [form, setForm] = useState<GroupForm>(EMPTY_FORM)
  const [initialMembers, setInitialMembers] = useState('')
  const [viewingParticipants, setViewingParticipants] = useState<Group | null>(null)
  const [participants, setParticipants] = useState<GroupParticipant[] | null>(null)
  const [numbersInput, setNumbersInput] = useState('')
  const [manageBusy, setManageBusy] = useState(false)
  const [manageFeedback, setManageFeedback] = useState('')
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  // Seleção na importação: lista os grupos do WhatsApp e o usuário escolhe quais gerenciar
  const [importList, setImportList] = useState<{
    session: WhatsAppSession
    groups: RemoteGroup[]
    /** Quando o worker montou esta lista; null = nunca */
    syncedAt: string | null
    /** true enquanto o worker está montando a lista (polling ligado) */
    discovering: boolean
    /**
     * Jids já cadastrados — TODOS, inclusive os de número desconectado.
     * Não pode sair do estado `groups`: aquele é a listagem da tela, que
     * esconde grupo sem número conectado. Usá-lo aqui reofereceria esse grupo
     * na importação e criaria uma segunda linha com o mesmo group_jid.
     */
    jaImportados: Set<string>
  } | null>(null)
  /**
   * Números conectados esperando a escolha de qual usar na importação.
   *
   * A busca de grupos é feita em UM número: a Evolution só devolve os grupos
   * de que aquela instância participa. Antes daqui, o código pegava o
   * primeiro conectado e não dizia qual era — grupo criado pelo outro número
   * simplesmente não aparecia, sem nada na tela explicando a ausência.
   *
   * Com um número só conectado não há o que perguntar, e a pergunta não
   * aparece.
   */
  const [escolhaNumero, setEscolhaNumero] = useState<WhatsAppSession[] | null>(null)
  const [importSelected, setImportSelected] = useState<Set<string>>(new Set())
  const [importSearch, setImportSearch] = useState('')
  const [importProgress, setImportProgress] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saveProgress, setSaveProgress] = useState('')

  // Sincronização em massa (selecionar vários grupos) — processada no servidor
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkProgress, setBulkProgress] = useState('')
  const [syncJobIds, setSyncJobIds] = useState<string[]>([])
  const [bulkSkipped, setBulkSkipped] = useState<string[]>([])

  const refresh = useCallback(() => {
    groupService.list().then(setGroups).catch(console.error)
    sessionService.list().then(setSessions).catch(console.error)
    groupService.getSyncStatus().then(setSyncStatus).catch(console.error)
  }, [])

  useEffect(refresh, [refresh])

  // Número desconectou/reconectou ou saiu do painel → refaz o filtro de grupos
  useRealtime('whatsapp_sessions', refresh)

  async function openEdit(group: Group | 'new') {
    setError('')
    setEditing(group)
    setInitialMembers('')
    if (group === 'new') {
      setForm(EMPTY_FORM)
    } else {
      const sessionIds = await groupService.getSessions(group.id)
      setForm({
        name: group.name,
        description: group.description ?? '',
        groupJid: group.group_jid ?? '',
        sessionIds,
      })
    }
  }

  async function handleSave() {
    if (!profile || !form.name.trim()) return
    setBusy(true)
    setError('')
    try {
      if (editing === 'new') {
        let groupJid = form.groupJid.trim() || undefined

        // Sem ID vinculado → cria o grupo de verdade no WhatsApp
        if (!groupJid) {
          const session =
            sessions.find((s) => form.sessionIds.includes(s.id) && s.status === 'connected')
            ?? sessions.find((s) => s.status === 'connected')
          if (!session) {
            throw new Error('Conecte um número para criar o grupo no WhatsApp.')
          }
          setSaveProgress('Criando grupo no WhatsApp…')
          const created = await groupService.createRemoteGroup(
            session,
            form.name.trim(),
            initialMembers.split('\n'),
            form.description || undefined,
          )
          groupJid = created.jid
          setSaveProgress('')
          if (!form.sessionIds.includes(session.id)) {
            form.sessionIds.push(session.id)
          }

          const group = await groupService.create({
            organizationId: profile.organization_id,
            name: form.name.trim(),
            description: form.description || undefined,
            groupJid,
            sessionIds: form.sessionIds,
          })

          // Participantes além do primeiro lote entram aos poucos, pelo servidor
          if (created.remaining.length > 0) {
            await groupService.createParticipantJob(
              profile.organization_id, group.id, session.id, 'add', created.remaining,
            )
            toast.success(`Grupo criado! Os ${created.remaining.length} participantes restantes serão adicionados automaticamente nos próximos minutos.`)
          }

          setEditing(null)
          refresh()
          return
        }

        await groupService.create({
          organizationId: profile.organization_id,
          name: form.name.trim(),
          description: form.description || undefined,
          groupJid,
          sessionIds: form.sessionIds,
        })
      } else if (editing) {
        await groupService.update(editing.id, {
          name: form.name.trim(),
          description: form.description || null,
          group_jid: form.groupJid || null,
        })
        await groupService.setSessions(editing.id, form.sessionIds)
      }
      setEditing(null)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao salvar')
    } finally {
      setBusy(false)
      setSaveProgress('')
    }
  }

  /** Remove do painel os grupos selecionados (não apaga do WhatsApp). */
  async function handleBulkDelete() {
    const chosen = (groups ?? []).filter((g) => selected.has(g.id))
    if (chosen.length === 0) return
    const many = chosen.length > 1
    const ok = await confirmDialog({
      title: many ? `Remover ${chosen.length} grupos do painel` : 'Remover do painel',
      message: many
        ? `Remover ${chosen.length} grupos do painel? Eles continuarão existindo no WhatsApp, só deixam de ser gerenciados aqui, e você pode importá-los de novo depois.`
        : `Remover o grupo "${chosen[0].name}" do painel? Ele continuará existindo no WhatsApp, só deixa de ser gerenciado aqui, e você pode importá-lo de novo depois.`,
      confirmLabel: 'Remover',
      danger: true,
    })
    if (!ok) return
    await Promise.all(chosen.map((g) => groupService.remove(g.id)))
    setSelected(new Set())
    toast.success(many ? `${chosen.length} grupos removidos do painel.` : 'Grupo removido do painel.')
    refresh()
  }

  async function openParticipants(group: Group) {
    setViewingParticipants(group)
    setParticipants(null)
    setNumbersInput('')
    setManageFeedback('')
    setParticipants(await groupService.getParticipants(group.id))
  }

  async function findConnectedSession(group: Group) {
    const linked = await groupService.getSessions(group.id)
    return sessions.find((s) => linked.includes(s.id) && s.status === 'connected')
      ?? sessions.find((s) => s.status === 'connected')
      ?? null
  }

  async function handleSyncParticipants(group: Group) {
    const session = await findConnectedSession(group)
    if (!session) {
      toast.error('Nenhum número conectado para sincronizar participantes.')
      return
    }
    setParticipants(null)
    try {
      await groupService.syncParticipants(group, session)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha na sincronização')
    }
    setParticipants(await groupService.getParticipants(group.id))
    groupService.getSyncStatus().then(setSyncStatus).catch(console.error)
  }

  /**
   * Agenda a sincronização dos grupos selecionados NO SERVIDOR. O worker
   * processa com pacing (cache de contatos + poucos por rodada) e continua
   * mesmo com o painel fechado; aqui só acompanhamos o progresso.
   */
  async function handleBulkSync() {
    if (!profile) return
    const chosen = (groups ?? []).filter((g) => selected.has(g.id) && g.group_jid)
    if (chosen.length === 0) return

    setBulkBusy(true)
    setBulkProgress('Agendando sincronização…')

    const items: Array<{ groupId: string; sessionId: string }> = []
    const skipped: string[] = []
    for (const g of chosen) {
      const session = await findConnectedSession(g)
      if (session) items.push({ groupId: g.id, sessionId: session.id })
      else skipped.push(g.name)
    }

    if (items.length === 0) {
      setBulkBusy(false)
      setBulkProgress('')
      toast.error('Nenhum número conectado para sincronizar os grupos selecionados.')
      return
    }

    try {
      const jobs = await groupService.createSyncJobs(profile.organization_id, items)
      setSelected(new Set())
      setBulkSkipped(skipped)
      setBulkProgress(`Sincronizando 0/${jobs.length}…`)
      setSyncJobIds(jobs.map((j) => j.id))
    } catch (err) {
      setBulkBusy(false)
      setBulkProgress('')
      toast.error(err instanceof Error ? err.message : 'Falha ao agendar a sincronização')
    }
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // Acompanha os jobs de sincronização no servidor e avisa ao concluir.
  useEffect(() => {
    if (syncJobIds.length === 0) return
    const timer = setInterval(async () => {
      const { done, total, failed } = await groupService.getSyncJobsProgress(syncJobIds)
      if (done < total) {
        setBulkProgress(`Sincronizando ${done}/${total}…`)
        return
      }
      // Concluído
      clearInterval(timer)
      setSyncJobIds([])
      setBulkBusy(false)
      setBulkProgress('')
      groupService.getSyncStatus().then(setSyncStatus).catch(console.error)

      const nameById = new Map((groups ?? []).map((g) => [g.id, g.name]))
      const okCount = total - failed.length
      const parts = [`Sincronização concluída: ${okCount}/${total} grupo(s).`]
      if (bulkSkipped.length > 0) parts.push(`${bulkSkipped.length} sem número conectado (ignorado).`)
      if (failed.length > 0) {
        parts.push(`\nFalhas:\n${failed.map((f) => `• ${nameById.get(f.groupId) ?? f.groupId}: ${f.error ?? 'falha'}`).join('\n')}`)
      }
      setBulkSkipped([])
      if (failed.length > 0) toast.error(parts.join(' '))
      else toast.success(parts.join(' '))
    }, 4000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncJobIds])

  async function handleManageParticipants(group: Group, action: 'add' | 'remove') {
    if (!profile) return
    const session = await findConnectedSession(group)
    if (!session) {
      setManageFeedback('Erro: nenhum número conectado.')
      return
    }
    setManageBusy(true)
    setManageFeedback('')
    try {
      const job = await groupService.createParticipantJob(
        profile.organization_id, group.id, session.id, action, numbersInput.split('\n'),
      )
      setNumbersInput('')
      setActiveJobId(job.id)
      setManageFeedback(`${action === 'add' ? 'Adicionando' : 'Removendo'}… 0/${job.total}`)
    } catch (err) {
      setManageFeedback(`Erro: ${err instanceof Error ? err.message : 'falha na operação'}`)
    } finally {
      setManageBusy(false)
    }
  }

  // Acompanha o job em andamento (processado no servidor — pode fechar o painel)
  useEffect(() => {
    if (!activeJobId) return
    const timer = setInterval(async () => {
      const job = await groupService.getParticipantJob(activeJobId)
      if (!job) return
      const verb = job.action === 'add' ? 'Adicionando' : 'Removendo'
      if (job.status === 'done') {
        setManageFeedback(`✓ ${job.total} número(s) processado(s)`)
        setActiveJobId(null)
        if (viewingParticipants) {
          setParticipants(await groupService.getParticipants(viewingParticipants.id))
        }
      } else if (job.status === 'failed') {
        setManageFeedback(`Erro: ${job.error ?? 'falha no processamento'}`)
        setActiveJobId(null)
      } else {
        setManageFeedback(`${verb}… ${job.processed}/${job.total}`)
      }
    }, 4000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJobId])

  /**
   * Etapa 1 da importação: busca os grupos reais do WhatsApp da primeira
   * sessão conectada e abre a lista para o usuário escolher quais gerenciar.
   */
  function handleImport() {
    if (!profile) return
    const conectados = sessions.filter((s) => s.status === 'connected')
    if (conectados.length === 0) {
      toast.error('Conecte um número primeiro para importar grupos.')
      return
    }
    if (conectados.length === 1) {
      importarDe(conectados[0])
      return
    }
    setEscolhaNumero(conectados)
  }

  /**
   * Etapa 1 de fato: abre a lista de grupos do número escolhido.
   *
   * Lê do cache (session_groups), que é instantâneo. Sem cache, pede ao worker
   * que monte a lista e o modal abre em espera — a chamada cara ao WhatsApp
   * acontece lá, não aqui. Ver groupService.listDiscovered.
   */
  async function importarDe(session: WhatsAppSession) {
    if (!profile) return
    setEscolhaNumero(null)
    setImporting(true)
    try {
      const [{ groups: remote, syncedAt }, jaImportados] = await Promise.all([
        groupService.listDiscovered(session.id),
        groupService.listJids(),
      ])
      const semCache = remote.length === 0
      if (semCache) await groupService.requestDiscovery(session.id)

      // Pré-seleciona só os que ainda não estão no sistema
      setImportSelected(new Set(remote.filter((r) => !jaImportados.has(r.id)).map((r) => r.id)))
      setImportSearch('')
      setImportList({ session, groups: remote, syncedAt, discovering: semCache, jaImportados })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha na importação')
    } finally {
      setImporting(false)
    }
  }

  /** Botão "atualizar lista": refaz a busca no WhatsApp, pelo worker. */
  async function atualizarLista() {
    if (!importList) return
    try {
      await groupService.requestDiscovery(importList.session.id)
      setImportList((prev) => (prev ? { ...prev, discovering: true } : prev))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao pedir a lista de grupos')
    }
  }

  /**
   * Acompanha o pedido enquanto o worker monta a lista. O worker roda a cada
   * minuto e a descoberta é a última etapa dele, então a espera passa de um
   * minuto com facilidade — por isso não há limite de tentativas aqui; quem
   * desiste é o usuário, fechando o modal.
   */
  useEffect(() => {
    if (!importList?.discovering) return
    const sessionId = importList.session.id
    const jaImportados = importList.jaImportados
    let vivo = true

    const timer = setInterval(async () => {
      const st = await groupService.getDiscoveryStatus(sessionId)
      if (!vivo || !st || st.status === 'pending' || st.status === 'running') return

      if (st.status === 'failed') {
        toast.error(st.error ?? 'Não foi possível listar os grupos deste número.')
        setImportList((prev) => (prev ? { ...prev, discovering: false } : prev))
        return
      }

      const { groups: remote, syncedAt } = await groupService.listDiscovered(sessionId)
      if (!vivo) return
      setImportSelected(new Set(remote.filter((r) => !jaImportados.has(r.id)).map((r) => r.id)))
      setImportList((prev) => (prev ? { ...prev, groups: remote, syncedAt, discovering: false } : prev))
    }, 4000)

    return () => { vivo = false; clearInterval(timer) }
  }, [importList?.discovering, importList?.session.id])

  function toggleImport(jid: string) {
    setImportSelected((prev) => {
      const next = new Set(prev)
      next.has(jid) ? next.delete(jid) : next.add(jid)
      return next
    })
  }

  /**
   * Etapa 2 da importação: cria no sistema apenas os grupos marcados.
   * Só estes passam a aparecer na listagem, agendamentos, etc.
   */
  async function confirmImport() {
    if (!profile || !importList) return
    const { session, groups: remote, jaImportados } = importList
    const chosen = remote.filter((r) => importSelected.has(r.id) && !jaImportados.has(r.id))
    if (chosen.length === 0) {
      setImportList(null)
      return
    }
    setImporting(true)
    setImportProgress(`Importando 0/${chosen.length}…`)
    try {
      let done = 0
      // Guarda os grupos criados para sincronizar os participantes em seguida
      const syncItems: Array<{ groupId: string; sessionId: string }> = []
      for (const rg of chosen) {
        const created = await groupService.create({
          organizationId: profile.organization_id,
          name: rg.subject,
          description: rg.desc,
          groupJid: rg.id,
          sessionIds: [session.id],
        })
        syncItems.push({ groupId: created.id, sessionId: session.id })
        done++
        setImportProgress(`Importando ${done}/${chosen.length}…`)
      }
      toast.success(`${chosen.length} grupo(s) importado(s) de ${sessionLabel(session)}. Sincronizando participantes…`)
      setImportList(null)
      refresh()

      // Sincroniza automaticamente os participantes dos grupos recém-importados,
      // reaproveitando o fluxo de sincronização em massa (processado no servidor).
      if (syncItems.length > 0) {
        setBulkBusy(true)
        setBulkProgress(`Sincronizando 0/${syncItems.length}…`)
        try {
          const jobs = await groupService.createSyncJobs(profile.organization_id, syncItems)
          setBulkSkipped([])
          setSyncJobIds(jobs.map((j) => j.id))
        } catch (err) {
          setBulkBusy(false)
          setBulkProgress('')
          toast.error(err instanceof Error ? err.message : 'Falha ao sincronizar os participantes')
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha na importação')
    } finally {
      setImporting(false)
      setImportProgress('')
    }
  }

  function toggleSession(id: string) {
    setForm((f) => ({
      ...f,
      sessionIds: f.sessionIds.includes(id)
        ? f.sessionIds.filter((s) => s !== id)
        : [...f.sessionIds, id],
    }))
  }

  const visibleGroups = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = groups ?? []
    return q
      ? list.filter((g) =>
          g.name.toLowerCase().includes(q) || (g.description ?? '').toLowerCase().includes(q),
        )
      : list
  }, [groups, search])

  // Seleção vale para qualquer grupo (usada para remover do painel em massa).
  // A sincronização, porém, só faz sentido nos vinculados ao WhatsApp (com JID).
  const allSelected = visibleGroups.length > 0 && visibleGroups.every((g) => selected.has(g.id))
  const syncableSelectedCount = useMemo(
    () => (groups ?? []).filter((g) => selected.has(g.id) && g.group_jid).length,
    [groups, selected],
  )

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(visibleGroups.map((g) => g.id)))
  }

  if (!groups) return <Loader />

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Grupos</h1>
          <p>Grupos de WhatsApp vinculados aos seus números</p>
        </div>
        <div className="flex">
          {selected.size > 0 && (
            <button className="btn btn-danger" onClick={handleBulkDelete} disabled={bulkBusy}>
              <Trash2 /> Remover do painel ({selected.size})
            </button>
          )}
          <button
            className="btn btn-ghost"
            onClick={handleBulkSync}
            disabled={bulkBusy || syncableSelectedCount === 0}
            title={syncableSelectedCount === 0 ? 'Selecione grupos vinculados ao WhatsApp para sincronizar' : undefined}
          >
            {bulkBusy ? <span className="spinner" /> : <RefreshCw />}
            Sincronizar participantes{syncableSelectedCount > 0 ? ` (${syncableSelectedCount})` : ''}
          </button>
          <button className="btn btn-ghost" onClick={handleImport} disabled={importing}>
            {importing ? <span className="spinner" /> : <Download />} Importar do WhatsApp
          </button>
          <button className="btn btn-primary" onClick={() => openEdit('new')}>
            <Plus /> Novo grupo
          </button>
        </div>
      </div>

      {bulkBusy && bulkProgress && (
        <div className="card mb-16" style={{ borderColor: 'rgba(77, 163, 255,0.25)', background: 'rgba(77, 163, 255,0.05)' }}>
          <div className="flex" style={{ gap: 10 }}>
            <span className="spinner" />
            <span style={{ fontSize: 13, color: 'var(--text)' }}>{bulkProgress}</span>
          </div>
          <p className="text-muted" style={{ fontSize: 12, marginTop: 6 }}>
            Avisaremos aqui assim que a sincronização for concluída.
          </p>
        </div>
      )}

      {groups.length === 0 ? (
        <div className="card">
          <EmptyState icon={<Users />} text="Nenhum grupo cadastrado. Crie manualmente ou importe do WhatsApp." />
        </div>
      ) : (
        <>
          <div className="search-field" style={{ maxWidth: 360, marginBottom: 14 }}>
            <input
              className="input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Pesquisar entre ${groups.length} grupo(s)…`}
            />
            <Search />
          </div>
          {visibleGroups.length === 0 ? (
            <div className="card">
              <EmptyState icon={<Search />} text={`Nenhum grupo encontrado para “${search}”.`} />
            </div>
          ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 44, textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    disabled={visibleGroups.length === 0}
                    style={{ width: 15, height: 15, cursor: 'pointer' }}
                    title="Selecionar todos os grupos"
                  />
                </th>
                <th style={{ width: 260, maxWidth: 260 }}>Nome</th>
                <th>WhatsApp</th>
                <th>Status</th>
                <th style={{ textAlign: 'center' }}>Sincronização</th>
                <th style={{ textAlign: 'right' }}>Ações</th>
              </tr>
            </thead>
            <tbody>
              {visibleGroups.map((g) => (
                <tr key={g.id}>
                  <td style={{ textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={selected.has(g.id)}
                      onChange={() => toggleSelected(g.id)}
                      style={{ width: 15, height: 15, cursor: 'pointer' }}
                    />
                  </td>
                  <td style={{ color: 'var(--text)', fontWeight: 500 }}>
                    <div style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={g.name}>
                      {g.name}
                    </div>
                    {g.description && (
                      <div
                        className="text-muted"
                        style={{ fontSize: 12, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={g.description}
                      >
                        {g.description}
                      </div>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${g.group_jid ? 'badge-green' : 'badge-gray'}`}>
                      {g.group_jid ? 'Vinculado' : 'Não vinculado'}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${g.is_active ? 'badge-green' : 'badge-gray'}`}>
                      {g.is_active ? 'Ativo' : 'Inativo'}
                    </span>
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    {(() => {
                      const st = syncStatus[g.id]
                      if (!st || st.count === 0) {
                        return <span className="badge badge-gray">Não sincronizado</span>
                      }
                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                          <span className="badge badge-green">
                            {st.count} {st.count === 1 ? 'participante' : 'participantes'}
                          </span>
                          {st.lastSyncedAt && (
                            <span className="text-muted" style={{ fontSize: 11 }}>
                              {format(new Date(st.lastSyncedAt), "dd/MM/yy 'às' HH:mm")}
                            </span>
                          )}
                        </div>
                      )
                    })()}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="flex" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => openParticipants(g)}><Users /> Participantes</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => openEdit(g)} title="Editar"><Pencil /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
          )}
        </>
      )}

      {editing && (
        <Modal title={editing === 'new' ? 'Novo grupo' : 'Editar grupo'} onClose={() => setEditing(null)}>
          <div className="field">
            <label>Nome</label>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
          </div>
          <div className="field">
            <label>Descrição</label>
            <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          {editing === 'new' && !form.groupJid.trim() && (
            <div className="field">
              <label>Participantes iniciais</label>
              <textarea
                className="input mono"
                style={{ minHeight: 72, fontSize: 12.5 }}
                value={initialMembers}
                onChange={(e) => setInitialMembers(e.target.value)}
                placeholder={'Um número por linha, com código do país e DDD:\n5511999999999\n5521988887777'}
              />
              <span className="text-muted" style={{ fontSize: 12 }}>
                O grupo será criado no WhatsApp pelo número conectado selecionado abaixo.
              </span>
            </div>
          )}
          <div className="field">
            <label>Vincular a um grupo já existente no WhatsApp (opcional)</label>
            <input className="input mono" value={form.groupJid} onChange={(e) => setForm({ ...form, groupJid: e.target.value })} placeholder="deixe vazio para criar um grupo novo" />
          </div>
          <div className="field">
            <label>Números associados</label>
            {sessions.length === 0 && <p className="text-muted" style={{ fontSize: 12 }}>Nenhum número cadastrado.</p>}
            <div className="flex" style={{ flexWrap: 'wrap', gap: 8 }}>
              {sessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`btn btn-sm ${form.sessionIds.includes(s.id) ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => toggleSession(s.id)}
                >
                  {sessionLabel(s)}
                  <StatusBadge status={s.status} />
                </button>
              ))}
            </div>
          </div>
          {saveProgress && <p style={{ fontSize: 12.5, color: 'var(--primary)' }}>{saveProgress}</p>}
          {error && <p className="error-text">{error}</p>}
          <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
            <button className="btn btn-ghost" onClick={() => setEditing(null)}>Cancelar</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={busy || !form.name.trim()}>
              {busy ? <span className="spinner" /> : 'Salvar'}
            </button>
          </div>
        </Modal>
      )}

      {viewingParticipants && (
        <Modal title={`Participantes — ${viewingParticipants.name}`} onClose={() => setViewingParticipants(null)}>
          <div className="flex-between mb-16">
            <span className="text-secondary" style={{ fontSize: 13 }}>
              {participants ? `${participants.length} participante(s)` : 'Carregando…'}
            </span>
            <button className="btn btn-ghost btn-sm" onClick={() => handleSyncParticipants(viewingParticipants)}>
              <RefreshCw /> Sincronizar
            </button>
          </div>
          {!participants ? (
            <Loader />
          ) : participants.length === 0 ? (
            <EmptyState icon={<Users />} text="Nenhum participante sincronizado ainda." />
          ) : (
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              {participants.map((p) => (
                <div key={p.id} className="flex-between" style={{ padding: '8px 4px', borderBottom: '1px solid var(--border)' }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>
                      {p.name ?? 'Sem nome'}
                    </div>
                    <div className="mono text-muted" style={{ fontSize: 11.5 }}>
                      {p.phone ?? p.jid}
                    </div>
                  </div>
                  {p.is_admin && <span className="badge badge-green">admin</span>}
                </div>
              ))}
            </div>
          )}

          <div className="field" style={{ marginTop: 18, marginBottom: 0 }}>
            <label>Adicionar ou remover pessoas</label>
            <textarea
              className="input mono"
              style={{ minHeight: 72, fontSize: 12.5 }}
              value={numbersInput}
              onChange={(e) => setNumbersInput(e.target.value)}
              placeholder={'Um número por linha, com código do país e DDD:\n5511999999999\n5521988887777'}
            />
            {manageFeedback && (
              <p style={{ fontSize: 12.5, color: manageFeedback.startsWith('✓') ? 'var(--primary)' : 'var(--danger)' }}>
                {manageFeedback}
              </p>
            )}
            <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
              <button
                className="btn btn-danger btn-sm"
                disabled={manageBusy || !numbersInput.trim()}
                onClick={() => handleManageParticipants(viewingParticipants, 'remove')}
              >
                Remover
              </button>
              <button
                className="btn btn-primary btn-sm"
                disabled={manageBusy || !numbersInput.trim()}
                onClick={() => handleManageParticipants(viewingParticipants, 'add')}
              >
                {manageBusy ? <span className="spinner" /> : 'Adicionar'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Página, como todo o resto: a caixa flutuante era pouco conteúdo numa
          tela inteira, mas quebrava em parte dos dispositivos — e a régua do
          projeto passou a ser página sempre, sem exceção por tamanho. */}
      {escolhaNumero && (
        <Modal
          title="Importar grupos de qual número?"
          onClose={() => setEscolhaNumero(null)}
        >
          <p className="text-muted" style={{ fontSize: 13, marginBottom: 16 }}>
            Cada número enxerga só os grupos de que ele participa. Escolha o
            número que está no grupo que você quer importar.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {escolhaNumero.map((s) => (
              <button
                key={s.id}
                className="btn btn-ghost"
                style={{ justifyContent: 'flex-start', width: '100%' }}
                onClick={() => importarDe(s)}
              >
                {sessionLabel(s)}
              </button>
            ))}
          </div>
          <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
            <button className="btn btn-ghost" onClick={() => setEscolhaNumero(null)}>Cancelar</button>
          </div>
        </Modal>
      )}

      {importList && (() => {
        const existingJids = importList.jaImportados
        const q = importSearch.trim().toLowerCase()
        const list = q
          ? importList.groups.filter((rg) => rg.subject.toLowerCase().includes(q))
          : importList.groups
        const selectable = list.filter((rg) => !existingJids.has(rg.id))
        const allSel = selectable.length > 0 && selectable.every((rg) => importSelected.has(rg.id))
        const toggleAll = () =>
          setImportSelected((prev) => {
            if (allSel) {
              const next = new Set(prev)
              selectable.forEach((rg) => next.delete(rg.id))
              return next
            }
            return new Set([...prev, ...selectable.map((rg) => rg.id)])
          })
        return (
          <Modal
            title={`Importar grupos — ${sessionLabel(importList.session)}`}
            onClose={() => !importing && setImportList(null)}
          >
            <p className="text-muted" style={{ fontSize: 13, marginTop: -4, marginBottom: 12 }}>
              Grupos de que <b>{sessionLabel(importList.session)}</b> participa.
              Selecione os que deseja gerenciar: apenas os escolhidos aparecerão
              na listagem, nos agendamentos e nos envios.
              {sessions.filter((s) => s.status === 'connected').length > 1
                && ' Não achou um grupo? Ele pode estar em outro número — feche e importe pelo outro.'}
            </p>
            {/*
              A lista vem do cache. Quem a monta é o worker, então aqui só se
              mostra de quando ela é e se dá para pedir outra.
            */}
            <p className="text-muted" style={{ fontSize: 12.5, marginTop: -6, marginBottom: 12 }}>
              {importList.discovering ? (
                <>Buscando os grupos no WhatsApp… pode levar alguns minutos, e você pode fechar esta janela — a lista fica salva.</>
              ) : (
                <>
                  {importList.syncedAt
                    && `Lista de ${format(new Date(importList.syncedAt), "dd/MM 'às' HH:mm")}. `}
                  Faltou algum grupo?{' '}
                  <button type="button" className="link-button" onClick={atualizarLista}>
                    Atualizar lista
                  </button>
                  .
                </>
              )}
            </p>
            <div className="search-field" style={{ marginBottom: 12 }}>
              <input
                className="input"
                value={importSearch}
                onChange={(e) => setImportSearch(e.target.value)}
                placeholder={`Pesquisar entre ${importList.groups.length} grupo(s)…`}
              />
              <Search />
            </div>
            <div className="flex-between" style={{ marginBottom: 8 }}>
              <label className="flex" style={{ gap: 8, fontSize: 13, cursor: selectable.length ? 'pointer' : 'default' }}>
                <input
                  type="checkbox"
                  checked={allSel}
                  onChange={toggleAll}
                  disabled={selectable.length === 0}
                  style={{ width: 15, height: 15 }}
                />
                Selecionar todos
              </label>
              <span className="text-muted" style={{ fontSize: 12 }}>{importSelected.size} selecionado(s)</span>
            </div>
            <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
              {list.length === 0 ? (
                <EmptyState
                  icon={importList.discovering ? <RefreshCw /> : <Search />}
                  text={importList.discovering
                    ? 'Montando a lista de grupos deste número…'
                    : 'Nenhum grupo encontrado.'}
                />
              ) : (
                list.map((rg) => {
                  const already = existingJids.has(rg.id)
                  return (
                    <label
                      key={rg.id}
                      className="flex-between"
                      style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', cursor: already ? 'default' : 'pointer', opacity: already ? 0.6 : 1 }}
                    >
                      <div className="flex" style={{ gap: 10, minWidth: 0 }}>
                        <input
                          type="checkbox"
                          checked={already || importSelected.has(rg.id)}
                          disabled={already}
                          onChange={() => toggleImport(rg.id)}
                          style={{ width: 15, height: 15, flexShrink: 0 }}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {rg.subject}
                          </div>
                          {typeof rg.size === 'number' && (
                            <div className="text-muted" style={{ fontSize: 11.5 }}>{rg.size} participante(s)</div>
                          )}
                        </div>
                      </div>
                      {already && <span className="badge badge-gray" style={{ flexShrink: 0 }}>Já importado</span>}
                    </label>
                  )
                })
              )}
            </div>
            <div className="flex-between" style={{ marginTop: 20, gap: 12 }}>
              <span style={{ fontSize: 12.5, color: 'var(--primary)' }}>{importProgress}</span>
              <div className="flex">
                <button className="btn btn-ghost" onClick={() => setImportList(null)} disabled={importing}>Cancelar</button>
                <button className="btn btn-primary" onClick={confirmImport} disabled={importing || importSelected.size === 0}>
                  {importing ? <span className="spinner" /> : `Importar${importSelected.size > 0 ? ` (${importSelected.size})` : ''}`}
                </button>
              </div>
            </div>
          </Modal>
        )
      })()}
    </>
  )
}
