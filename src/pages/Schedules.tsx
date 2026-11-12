import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, CalendarClock, XCircle, Users, Pencil, Smartphone } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { schedulerService } from '@/services/schedulerService'
import { groupService } from '@/services/groupService'
import { sessionService } from '@/services/sessionService'
import { storageService } from '@/services/storageService'
import { compressImage } from '@/lib/compressImage'
import { MEDIA_LABEL, MEDIA_ACCEPT, MAX_FILE_SIZE, MAX_FILE_SIZE_MB } from '@/lib/media'
import { useAuthStore } from '@/store/authStore'
import { confirmDialog } from '@/store/confirmStore'
import { toast } from '@/store/toastStore'
import { useRealtime } from '@/hooks/useRealtime'
import { Modal, Loader, EmptyState, StatusBadge, GroupPicker, SessionPicker, sessionLabel } from '@/components/ui'
import { WhatsAppPreview } from '@/components/WhatsAppPreview'
import type { Group, MediaType, Schedule, QueuePriority, Message, WhatsAppSession } from '@/types'
import { formatSP, spWallTimeToUtcISO, spDatetimeLocal, nowSPDatetimeLocal, SP_TZ } from '@/lib/datetime'

type ScheduleMessage = Pick<Message, 'content' | 'media_type' | 'caption' | 'media_url' | 'file_name' | 'storage_path'>

interface ScheduleRow extends Schedule {
  messages: ScheduleMessage | null
  groups: Pick<Group, 'name'> | null
}

type BatchStatus = 'scheduled' | 'executed' | 'cancelled' | 'failed' | 'mixed'

/** Um agendamento lógico = todas as linhas (uma por grupo) que compartilham a mensagem. */
interface GroupedSchedule {
  key: string
  scheduledAt: string
  priority: QueuePriority
  sessionId: string | null
  message: ScheduleMessage | null
  rows: ScheduleRow[]
  status: BatchStatus
  scheduledCount: number
}

/** Texto curto da mensagem para a lista (texto ou "[Tipo] legenda"). */
function messagePreview(m: ScheduleMessage | null): string {
  if (!m) return '—'
  if (m.media_type === 'text') return m.content ?? '—'
  return `[${MEDIA_LABEL[m.media_type]}]${m.caption ? ` ${m.caption}` : ''}`
}

/** Badge de status do lote — 'mixed' vira "Parcial". */
function batchStatusBadge(status: BatchStatus) {
  if (status === 'mixed') return <span className="badge badge-yellow">Parcial</span>
  return <StatusBadge status={status} />
}

export function SchedulesPage() {
  const profile = useAuthStore((s) => s.profile)
  const [schedules, setSchedules] = useState<ScheduleRow[] | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  // null = ainda não carregou (ou falhou) — diferente de [] "nenhum número
  // cadastrado". Sem essa distinção, uma falha de rede faria todo agendamento
  // com número fixado exibir "Número removido", que parece perda de dado.
  const [sessions, setSessions] = useState<WhatsAppSession[] | null>(null)

  // Formulário compartilhado entre criar e editar.
  const [formMode, setFormMode] = useState<'create' | 'edit' | null>(null)
  const [editKey, setEditKey] = useState<string | null>(null)
  const [originalMessage, setOriginalMessage] = useState<ScheduleMessage | null>(null)

  const [mediaType, setMediaType] = useState<MediaType>('text')
  const [text, setText] = useState('')
  const [mediaFile, setMediaFile] = useState<File | null>(null)
  const [caption, setCaption] = useState('')
  const [selectedGroups, setSelectedGroups] = useState<string[]>([])
  const [when, setWhen] = useState('')
  const [priority, setPriority] = useState<QueuePriority>('normal')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Quantos agendamentos saíram sem fechar o formulário. Só serve de recibo na
  // tela: sem ele, o form continuar aberto depois de "Agendar" é ambíguo —
  // não dá pra saber se salvou ou se falhou em silêncio.
  const [createdCount, setCreatedCount] = useState(0)
  const [detailKey, setDetailKey] = useState<string | null>(null)

  const refresh = useCallback(() => {
    supabase
      .from('schedules')
      .select('*, messages(content, media_type, caption, media_url, file_name, storage_path), groups(name)')
      .order('scheduled_at', { ascending: true })
      .returns<ScheduleRow[]>()
      .then(({ data }) => setSchedules(data ?? []))
  }, [])

  const refreshSessions = useCallback(() => {
    sessionService.list().then(setSessions).catch(() => setSessions(null))
  }, [])

  useEffect(() => {
    refresh()
    refreshSessions()
    groupService.list().then((gs) => setGroups(gs.filter((g) => g.is_active)))
  }, [refresh, refreshSessions])

  useRealtime('schedules', refresh)
  // Mantém o aviso de "desconectado" do SessionPicker fiel ao estado real:
  // sem isto, um número que cai depois de a página abrir continua aparecendo
  // como conectado e o usuário agenda sem nenhum sinal de que vai falhar.
  useRealtime('whatsapp_sessions', refreshSessions)

  // Agrupa as linhas (uma por grupo) em um agendamento lógico por message_id.
  const grouped = useMemo<GroupedSchedule[]>(() => {
    const map = new Map<string, GroupedSchedule>()
    for (const s of schedules ?? []) {
      let g = map.get(s.message_id)
      if (!g) {
        g = {
          key: s.message_id,
          scheduledAt: s.scheduled_at,
          priority: s.priority,
          sessionId: s.session_id,
          message: s.messages,
          rows: [],
          status: 'scheduled',
          scheduledCount: 0,
        }
        map.set(s.message_id, g)
      }
      g.rows.push(s)
    }
    for (const g of map.values()) {
      const total = g.rows.length
      const count = (st: string) => g.rows.filter((r) => r.status === st).length
      g.scheduledCount = count('scheduled')
      g.status =
        g.scheduledCount === total ? 'scheduled'
        : count('executed') === total ? 'executed'
        : count('cancelled') === total ? 'cancelled'
        : count('failed') === total ? 'failed'
        : 'mixed'
    }
    return Array.from(map.values())
  }, [schedules])

  const detail = detailKey ? grouped.find((g) => g.key === detailKey) ?? null : null

  /** Nome do número de origem, ou "Automático" quando não foi fixado. */
  const sessionName = useCallback((id: string | null) => {
    if (!id) return 'Automático'
    if (!sessions) return '—'
    const s = sessions.find((x) => x.id === id)
    return s ? sessionLabel(s) : 'Número removido'
  }, [sessions])

  // Ao editar, a mídia já enviada continua valendo se o tipo não mudou.
  const keepsExistingMedia =
    formMode === 'edit' &&
    originalMessage?.media_type === mediaType &&
    !!originalMessage?.media_url

  const contentOk = mediaType === 'text'
    ? text.trim().length > 0
    : mediaFile !== null || keepsExistingMedia
  const isValid = selectedGroups.length > 0 && when !== '' && contentOk

  function openCreate() {
    setFormMode('create')
    setEditKey(null)
    setOriginalMessage(null)
    setMediaType('text')
    setText('')
    setMediaFile(null)
    setCaption('')
    setSelectedGroups([])
    setWhen('')
    setPriority('normal')
    setSessionId(null)
    setError('')
    setCreatedCount(0)
  }

  function openEdit(g: GroupedSchedule) {
    setFormMode('edit')
    setEditKey(g.key)
    setOriginalMessage(g.message)
    setMediaType(g.message?.media_type ?? 'text')
    setText(g.message?.content ?? '')
    setMediaFile(null)
    setCaption(g.message?.caption ?? '')
    setSelectedGroups(g.rows.filter((r) => r.status === 'scheduled').map((r) => r.group_id))
    setWhen(spDatetimeLocal(g.scheduledAt))
    setPriority(g.priority)
    setSessionId(g.sessionId)
    setError('')
    setDetailKey(null)
  }

  function closeForm() {
    setFormMode(null)
    setEditKey(null)
  }

  async function handleSubmit() {
    if (!profile || !isValid) return
    setBusy(true)
    setError('')
    try {
      // O `min` do input é só dica visual do browser — nada impedia gravar um
      // horário passado, que o worker dispararia na rodada seguinte como se
      // fosse imediato. Vale para os dois modos: ao editar um agendamento
      // atrasado, é preciso dizer o novo horário.
      if (new Date(spWallTimeToUtcISO(when)).getTime() <= Date.now()) {
        throw new Error('Esse horário já passou. Escolha um horário futuro.')
      }
      if (formMode === 'edit') {
        await updateBatch()
        closeForm()
        refresh()
        return
      }

      const grupos = selectedGroups.length
      const horario = when
      await createBatch()
      refresh()

      // Criar NÃO fecha o formulário: quem agenda costuma lançar vários
      // parecidos em sequência, e fechar obrigava a refazer mensagem, mídia e
      // grupos toda vez. Mensagem, arquivo, grupos, sessão e prioridade ficam
      // como estão — muda-se só o que for diferente no próximo.
      //
      // O horário é a exceção, e é de propósito: zerado, ele desabilita o
      // botão (isValid exige `when`) até alguém escolher uma data nova. Sem
      // isso, um segundo clique no mesmo botão criaria um agendamento idêntico
      // ao que acabou de sair — mesma mensagem, mesmos grupos, mesma hora —
      // que é engano em praticamente todo caso.
      setWhen('')
      setCreatedCount((n) => n + 1)
      toast.success(
        `Agendado para ${grupos} grupo(s) em ${formatSP(new Date(spWallTimeToUtcISO(horario)))}.`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao salvar o agendamento')
    } finally {
      setBusy(false)
    }
  }

  async function createBatch() {
    if (!profile) return
    let mediaUrl: string | null = null
    let storagePath: string | null = null
    if (mediaType !== 'text' && mediaFile) {
      const uploaded = await storageService.upload(mediaFile, profile.organization_id)
      mediaUrl = uploaded.url
      storagePath = uploaded.path
    }

    const { data: message, error: msgError } = await supabase.from('messages').insert({
      organization_id: profile.organization_id,
      created_by: profile.id,
      media_type: mediaType,
      content: mediaType === 'text' ? text.trim() : null,
      media_url: mediaUrl,
      storage_path: storagePath,
      caption: caption || null,
      file_name: mediaFile?.name ?? null,
    }).select().single<Message>()
    if (msgError) throw msgError

    await schedulerService.create({
      organizationId: profile.organization_id,
      messageId: message.id,
      groupIds: selectedGroups,
      // "when" é relógio de parede em SP → converte para o instante UTC correto.
      scheduledAt: new Date(spWallTimeToUtcISO(when)),
      priority,
      sessionId,
      timezone: SP_TZ,
      createdBy: profile.id,
    })
  }

  /**
   * Salva a edição: atualiza o conteúdo da mensagem do lote e depois as linhas.
   * A mídia antiga só é apagada do storage depois que o banco confirma a troca.
   */
  async function updateBatch() {
    if (!profile || !editKey) return

    // Antes de tocar na mensagem: o worker pode ter executado o lote enquanto
    // o formulário estava aberto. `messages` é o que os logs e os comprovantes
    // exibem, então reescrevê-la depois do envio faria o histórico mostrar um
    // texto que nunca foi enviado. schedulerService revalida antes de gravar.
    await schedulerService.loadEditableBatch(editKey)

    let patch: Partial<Message>
    let orphanPath: string | null = null

    if (mediaType === 'text') {
      patch = {
        media_type: 'text',
        content: text.trim(),
        caption: null,
        media_url: null,
        storage_path: null,
        file_name: null,
      }
      orphanPath = originalMessage?.storage_path ?? null
    } else if (mediaFile) {
      const uploaded = await storageService.upload(mediaFile, profile.organization_id)
      patch = {
        media_type: mediaType,
        content: null,
        caption: caption || null,
        media_url: uploaded.url,
        storage_path: uploaded.path,
        file_name: mediaFile.name,
      }
      orphanPath = originalMessage?.storage_path ?? null
    } else {
      // Mantém o arquivo já enviado — muda só a legenda.
      patch = { media_type: mediaType, content: null, caption: caption || null }
    }

    const { error: msgError } = await supabase.from('messages').update(patch).eq('id', editKey)
    if (msgError) throw msgError

    await schedulerService.updateBatch({
      organizationId: profile.organization_id,
      messageId: editKey,
      groupIds: selectedGroups,
      scheduledAt: new Date(spWallTimeToUtcISO(when)),
      priority,
      sessionId,
      timezone: SP_TZ,
      createdBy: profile.id,
    })

    // Best-effort: um arquivo órfão no storage não deve derrubar a edição.
    if (orphanPath) await storageService.remove(orphanPath).catch(() => {})
  }

  async function handleCancelBatch(g: GroupedSchedule) {
    const pendingIds = g.rows.filter((r) => r.status === 'scheduled').map((r) => r.id)
    if (pendingIds.length === 0) return
    const many = pendingIds.length > 1
    const ok = await confirmDialog({
      title: 'Cancelar agendamento',
      message: many
        ? `Cancelar este agendamento para ${pendingIds.length} grupo(s)? Não será enviado.`
        : 'Cancelar este agendamento? Ele não será enviado.',
      confirmLabel: 'Cancelar agendamento',
      cancelLabel: 'Voltar',
      danger: true,
    })
    if (!ok) return
    await schedulerService.cancelMany(pendingIds)
    setDetailKey(null)
    refresh()
  }

  if (!schedules) return <Loader />

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Agendamentos</h1>
          <p>Programe envios para um ou mais grupos</p>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>
          <Plus /> Novo agendamento
        </button>
      </div>

      {grouped.length === 0 ? (
        <div className="card">
          <EmptyState icon={<CalendarClock />} text="Nenhum agendamento criado." />
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Quando</th>
                <th>Grupos</th>
                <th>Mensagem</th>
                <th>Número</th>
                <th>Prioridade</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map((g) => (
                <tr key={g.key} style={{ cursor: 'pointer' }} onClick={() => setDetailKey(g.key)}>
                  <td style={{ color: 'var(--text)', whiteSpace: 'nowrap' }}>
                    {formatSP(g.scheduledAt, { withAt: true })}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {g.rows.length === 1
                      ? (g.rows[0].groups?.name ?? '—')
                      : <span className="flex" style={{ gap: 6, alignItems: 'center' }}><Users style={{ width: 14, height: 14, opacity: 0.6 }} /> {g.rows.length} grupos</span>}
                  </td>
                  <td style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {messagePreview(g.message)}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{sessionName(g.sessionId)}</td>
                  <td><StatusBadge status={g.priority} /></td>
                  <td>{batchStatusBadge(g.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {formMode && (
        <Modal
          title={formMode === 'edit' ? 'Editar agendamento' : 'Novo agendamento'}
          onClose={closeForm}
          wide
        >
          {/* Duas colunas: formulário e prévia. No modal de página há largura
              para isso, e é aqui que a prévia mais importa — o agendamento
              dispara sozinho, sem ninguém olhando. */}
          <div className="schedule-form-grid">
          <div>
          <div className="field">
            <label>Tipo de mídia</label>
            <div className="flex" style={{ flexWrap: 'wrap', gap: 6 }}>
              {(Object.keys(MEDIA_LABEL) as MediaType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`btn btn-sm ${mediaType === t ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setMediaType(t)}
                >
                  {MEDIA_LABEL[t]}
                </button>
              ))}
            </div>
          </div>

          {mediaType === 'text' ? (
            <div className="field">
              <label>Mensagem</label>
              <textarea className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Digite a mensagem…" autoFocus />
            </div>
          ) : (
            <>
              <div className="field">
                <label>Arquivo ({MEDIA_LABEL[mediaType].toLowerCase()})</label>
                {keepsExistingMedia && !mediaFile && (
                  <span className="text-muted" style={{ fontSize: 12 }}>
                    Atual: {originalMessage?.file_name ?? MEDIA_LABEL[mediaType]} — escolha um arquivo só se quiser trocar.
                  </span>
                )}
                <input
                  className="input"
                  type="file"
                  accept={MEDIA_ACCEPT[mediaType]}
                  onChange={async (e) => {
                    let file = e.target.files?.[0] ?? null
                    if (file && mediaType === 'image') {
                      file = await compressImage(file)
                    }
                    if (file && file.size > MAX_FILE_SIZE) {
                      setError(`Arquivo com ${(file.size / 1024 / 1024).toFixed(1)} MB — o limite é ${MAX_FILE_SIZE_MB} MB`)
                      e.target.value = ''
                      setMediaFile(null)
                      return
                    }
                    setError('')
                    setMediaFile(file)
                  }}
                />
                {mediaFile && (
                  <span className="text-muted" style={{ fontSize: 12 }}>
                    {mediaFile.name} · {(mediaFile.size / 1024 / 1024).toFixed(1)} MB
                  </span>
                )}
              </div>
              {mediaType !== 'audio' && (
                <div className="field">
                  <label>Legenda</label>
                  <input className="input" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="opcional" />
                </div>
              )}
            </>
          )}
          <GroupPicker groups={groups} selected={selectedGroups} onChange={setSelectedGroups} />
          <SessionPicker sessions={sessions ?? []} value={sessionId} onChange={setSessionId} />
          <div className="field">
            <label>Data e hora <span className="text-muted" style={{ fontWeight: 400 }}>(horário de Brasília)</span></label>
            <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} min={nowSPDatetimeLocal()} />
          </div>
          <div className="field">
            <label>Prioridade</label>
            <select className="input" value={priority} onChange={(e) => setPriority(e.target.value as QueuePriority)}>
              <option value="urgent">Urgente</option>
              <option value="normal">Normal</option>
              <option value="low">Baixa</option>
            </select>
          </div>
          {error && <p className="error-text">{error}</p>}

          {/* Só no create: confirma o que já saiu e explica por que o campo de
              data ficou vazio, que de outro modo pareceria um campo perdido. */}
          {createdCount > 0 && (
            <p className="text-muted" style={{ fontSize: 12.5, marginTop: 14 }}>
              {createdCount} agendamento(s) criado(s). Os campos seguem preenchidos
              para o próximo — escolha uma nova data e hora, ou feche.
            </p>
          )}

          </div>

          <div className="schedule-preview">
            <div className="card-title" style={{ marginBottom: 6 }}>Prévia no WhatsApp</div>
            <p className="text-muted" style={{ fontSize: 11.5, marginBottom: 14 }}>
              Como a mensagem chega no grupo na hora marcada
            </p>
            <WhatsAppPreview
              mediaType={mediaType}
              text={text}
              caption={caption}
              file={mediaFile}
              existingUrl={keepsExistingMedia ? originalMessage?.media_url : null}
              existingName={keepsExistingMedia ? originalMessage?.file_name : null}
              groupName={groups.find((g) => g.id === selectedGroups[0])?.name}
            />
          </div>
          </div>

          <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
            {/* Depois de já ter criado algo, "Cancelar" sugeriria desfazer. */}
            <button className="btn btn-ghost" onClick={closeForm}>
              {createdCount > 0 ? 'Fechar' : 'Cancelar'}
            </button>
            <button className="btn btn-primary" onClick={handleSubmit} disabled={busy || !isValid}>
              {busy ? <span className="spinner" />
                : formMode === 'edit' ? 'Salvar alterações'
                : selectedGroups.length > 1 ? `Agendar${createdCount > 0 ? ' outro' : ''} para ${selectedGroups.length} grupos`
                : createdCount > 0 ? 'Agendar outro'
                : 'Agendar'}
            </button>
          </div>
        </Modal>
      )}

      {detail && (
        <Modal title="Detalhes do agendamento" onClose={() => setDetailKey(null)}>
          <div className="flex" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            {batchStatusBadge(detail.status)}
            <StatusBadge status={detail.priority} />
            <span className="badge badge-gray">{detail.rows.length} grupo(s)</span>
          </div>

          <div className="field" style={{ marginBottom: 14 }}>
            <label>Quando (horário de Brasília)</label>
            <div style={{ color: 'var(--text)', fontSize: 14 }}>{formatSP(detail.scheduledAt, { withAt: true })}</div>
          </div>

          <div className="field" style={{ marginBottom: 14 }}>
            <label>Enviar pelo número</label>
            <div className="flex" style={{ gap: 6, alignItems: 'center', color: 'var(--text)', fontSize: 14 }}>
              <Smartphone style={{ width: 14, height: 14, opacity: 0.6 }} />
              {sessionName(detail.sessionId)}
            </div>
            {!detail.sessionId && (
              <span className="text-muted" style={{ fontSize: 12 }}>
                Distribuído entre os números conectados vinculados ao grupo.
              </span>
            )}
          </div>

          <div className="field" style={{ marginBottom: 14 }}>
            <label>Conteúdo · {MEDIA_LABEL[detail.message?.media_type ?? 'text']}</label>
            {detail.message?.media_type === 'text' ? (
              <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text)', fontSize: 13.5, lineHeight: 1.5 }}>
                {detail.message?.content ?? '—'}
              </div>
            ) : (
              <div>
                {detail.message?.media_url && detail.message.media_type === 'image' && (
                  <img src={detail.message.media_url} alt="" style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 8, marginBottom: 8, display: 'block' }} />
                )}
                {detail.message?.media_url && detail.message.media_type === 'video' && (
                  <video src={detail.message.media_url} controls style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 8, marginBottom: 8 }} />
                )}
                {detail.message?.media_url && detail.message.media_type === 'audio' && (
                  <audio src={detail.message.media_url} controls style={{ width: '100%', marginBottom: 8 }} />
                )}
                <div className="text-muted" style={{ fontSize: 12.5 }}>
                  {detail.message?.file_name ?? MEDIA_LABEL[detail.message?.media_type ?? 'text']}
                  {detail.message?.media_url && (
                    <> · <a href={detail.message.media_url} target="_blank" rel="noreferrer" style={{ color: 'var(--info)' }}>abrir</a></>
                  )}
                </div>
                {detail.message?.caption && (
                  <div style={{ marginTop: 8, color: 'var(--text)', fontSize: 13.5 }}>{detail.message.caption}</div>
                )}
              </div>
            )}
          </div>

          <div className="field" style={{ marginBottom: 0 }}>
            <label>Grupos ({detail.rows.length})</label>
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
              {detail.rows.map((r) => (
                <div key={r.id} className="flex-between" style={{ padding: '8px 4px', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 13, color: 'var(--text)' }}>{r.groups?.name ?? '—'}</span>
                  <StatusBadge status={r.status} />
                </div>
              ))}
            </div>
          </div>

          {detail.status === 'mixed' && detail.scheduledCount > 0 && (
            <p className="text-muted" style={{ fontSize: 12, marginTop: 12 }}>
              Parte deste lote já foi enviada, então o conteúdo não pode mais ser editado —
              só cancelar os {detail.scheduledCount} envio(s) que ainda não saíram.
            </p>
          )}

          <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
            <button className="btn btn-ghost" onClick={() => setDetailKey(null)}>Fechar</button>
            {detail.status === 'scheduled' && (
              <button className="btn btn-ghost" onClick={() => openEdit(detail)}>
                <Pencil /> Editar
              </button>
            )}
            {detail.scheduledCount > 0 && (
              <button className="btn btn-danger" onClick={() => handleCancelBatch(detail)}>
                <XCircle /> Cancelar agendamento
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  )
}
