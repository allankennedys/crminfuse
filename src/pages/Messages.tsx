import { useCallback, useEffect, useState } from 'react'
import { Send, MessageSquare, RotateCcw, XCircle } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { queueService } from '@/services/queueService'
import { groupService } from '@/services/groupService'
import { sessionService } from '@/services/sessionService'
import { storageService } from '@/services/storageService'
import { compressImage } from '@/lib/compressImage'
import { useAuthStore } from '@/store/authStore'
import { confirmDialog } from '@/store/confirmStore'
import { useRealtime } from '@/hooks/useRealtime'
import { Loader, EmptyState, StatusBadge, GroupPicker, SessionPicker } from '@/components/ui'
import { WhatsAppPreview } from '@/components/WhatsAppPreview'
import type { Group, MediaType, QueueItem, QueuePriority, Message, WhatsAppSession } from '@/types'
import { formatDistanceToNow } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { MEDIA_LABEL, MEDIA_ACCEPT, MAX_FILE_SIZE, MAX_FILE_SIZE_MB } from '@/lib/media'

interface QueueRow extends QueueItem {
  messages: Pick<Message, 'media_type' | 'content' | 'caption'> | null
  groups: Pick<Group, 'name'> | null
}

export function MessagesPage() {
  const profile = useAuthStore((s) => s.profile)
  const [groups, setGroups] = useState<Group[]>([])
  const [sessions, setSessions] = useState<WhatsAppSession[]>([])
  const [queue, setQueue] = useState<QueueRow[] | null>(null)

  const [mediaType, setMediaType] = useState<MediaType>('text')
  const [content, setContent] = useState('')
  const [mediaFile, setMediaFile] = useState<File | null>(null)
  const [caption, setCaption] = useState('')
  const [selectedGroups, setSelectedGroups] = useState<string[]>([])
  const [priority, setPriority] = useState<QueuePriority>('normal')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [feedback, setFeedback] = useState('')
  /**
   * O que já saiu daqui: o conteúdo e para quais grupos.
   *
   * O formulário fica preenchido depois de enviar — mandar o mesmo conteúdo
   * para outra leva de grupos é o caso comum, e refazer tudo era desperdício.
   * O preço disso é que a seleção de grupos também fica, então ACRESCENTAR um
   * grupo à lista reenviaria para todos os anteriores junto, sem nada na tela
   * avisando. Guardar quem já recebeu é o que permite avisar.
   *
   * A comparação é por conteúdo, não por envio inteiro: o que incomoda o
   * cliente é receber a mesma mensagem duas vezes, independentemente de ter
   * ido sozinha ou acompanhada.
   */
  const [enviado, setEnviado] = useState<{ conteudo: string; grupos: string[] } | null>(null)

  const refreshQueue = useCallback(() => {
    supabase
      .from('message_queue')
      .select('*, messages(media_type, content, caption), groups(name)')
      .order('created_at', { ascending: false })
      .limit(50)
      .returns<QueueRow[]>()
      .then(({ data }) => setQueue(data ?? []))
  }, [])

  const refreshSessions = useCallback(() => {
    sessionService.list().then(setSessions).catch(() => setSessions([]))
  }, [])

  useEffect(() => {
    groupService.list().then((gs) => setGroups(gs.filter((g) => g.is_active)))
    refreshSessions()
    refreshQueue()
  }, [refreshQueue, refreshSessions])

  useRealtime('message_queue', refreshQueue)
  // Estado real dos números para o aviso de "desconectado" do SessionPicker.
  useRealtime('whatsapp_sessions', refreshSessions)

  const isValid = selectedGroups.length > 0 &&
    (mediaType === 'text' ? content.trim().length > 0 : mediaFile !== null)

  async function handleSend() {
    if (!profile || !isValid) return

    // Mídia entra pelo nome e tamanho: dois arquivos diferentes com o mesmo
    // nome e o mesmo byte-count são o mesmo arquivo para o que interessa aqui.
    const conteudo = JSON.stringify({
      mediaType,
      content: content.trim(),
      caption,
      arquivo: mediaFile ? `${mediaFile.name}:${mediaFile.size}` : null,
    })

    // Grupos que receberiam este mesmo conteúdo pela segunda vez.
    const repetidos = enviado?.conteudo === conteudo
      ? selectedGroups.filter((id) => enviado.grupos.includes(id))
      : []

    if (repetidos.length > 0) {
      const nomes = repetidos.map((id) => groups.find((g) => g.id === id)?.name ?? 'grupo removido')
      const lista = nomes.slice(0, 3).join(', ')
        + (nomes.length > 3 ? ` e mais ${nomes.length - 3}` : '')
      const novos = selectedGroups.length - repetidos.length
      const ok = await confirmDialog({
        title: repetidos.length === 1 ? 'Este grupo já recebeu' : 'Estes grupos já receberam',
        message: `${lista} já ${repetidos.length === 1 ? 'recebeu' : 'receberam'} esta mensagem agora há pouco `
          + `e ${repetidos.length === 1 ? 'receberia' : 'receberiam'} de novo.`
          + (novos > 0
            ? ` Os outros ${novos} grupo(s) da seleção ainda não receberam — desmarque os repetidos para mandar só para eles.`
            : ''),
        confirmLabel: 'Enviar assim mesmo',
      })
      if (!ok) return
    }

    setSending(true)
    setFeedback('')
    try {
      let mediaUrl: string | null = null
      let storagePath: string | null = null
      if (mediaType !== 'text' && mediaFile) {
        const uploaded = await storageService.upload(mediaFile, profile.organization_id)
        mediaUrl = uploaded.url
        storagePath = uploaded.path
      }

      const { data: message, error } = await supabase.from('messages').insert({
        organization_id: profile.organization_id,
        created_by: profile.id,
        media_type: mediaType,
        content: mediaType === 'text' ? content.trim() : null,
        media_url: mediaUrl,
        storage_path: storagePath,
        caption: caption || null,
        file_name: mediaFile?.name ?? null,
      }).select().single<Message>()
      if (error) throw error

      await queueService.enqueue({
        organizationId: profile.organization_id,
        messageId: message.id,
        groupIds: selectedGroups,
        priority,
        sessionId,
      })

      // Nada é limpo: conteúdo, arquivo, legenda, grupos, número e prioridade
      // seguem como estão, para o próximo envio parecido custar só o que
      // mudar. Quem quiser começar do zero troca os campos — e o grupo que
      // receberia duas vezes passa pela confirmação lá em cima.
      // Acumula: quem recebeu neste conteúdo continua marcado como recebido
      // mesmo depois de sair da seleção, senão desmarcar e remarcar o grupo
      // apagaria o aviso justamente para quem ele existe.
      setEnviado({
        conteudo,
        grupos: enviado?.conteudo === conteudo
          ? [...new Set([...enviado.grupos, ...selectedGroups])]
          : [...selectedGroups],
      })
      setFeedback(`✓ Envio iniciado para ${selectedGroups.length} grupo(s) · os campos seguem preenchidos`)
      refreshQueue()
    } catch (err) {
      setFeedback(err instanceof Error ? `Erro: ${err.message}` : 'Erro ao enfileirar')
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Envio de mensagens</h1>
          <p>Envie texto e mídia para vários grupos de uma vez</p>
        </div>
      </div>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="card glow">
          <div className="card-title" style={{ marginBottom: 16 }}>Nova mensagem</div>

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
              <textarea className="input" value={content} onChange={(e) => setContent(e.target.value)} placeholder="Digite a mensagem…" />
            </div>
          ) : (
            <>
              <div className="field">
                <label>Arquivo ({MEDIA_LABEL[mediaType].toLowerCase()})</label>
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
                      setFeedback(`Erro: arquivo com ${(file.size / 1024 / 1024).toFixed(1)} MB — o limite é ${MAX_FILE_SIZE_MB} MB`)
                      e.target.value = ''
                      setMediaFile(null)
                      return
                    }
                    setFeedback('')
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

          <SessionPicker sessions={sessions} value={sessionId} onChange={setSessionId} />

          <div className="field">
            <label>Prioridade</label>
            <select className="input" value={priority} onChange={(e) => setPriority(e.target.value as QueuePriority)}>
              <option value="urgent">Urgente</option>
              <option value="normal">Normal</option>
              <option value="low">Baixa</option>
            </select>
          </div>

          {feedback && (
            <p style={{ fontSize: 13, color: feedback.startsWith('✓') ? 'var(--primary)' : 'var(--danger)', marginBottom: 12 }}>
              {feedback}
            </p>
          )}

          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={handleSend} disabled={sending || !isValid}>
            {sending ? <span className="spinner" /> : <><Send /> Enviar</>}
          </button>
        </div>

        {/* Prévia colada no formulário: quem escreve vê o resultado sem tirar
            os olhos do campo. O envio pode ir para vários grupos — o nome no
            topo é o do primeiro escolhido, e o resto da bolha é igual. */}
        <div className="card" style={{ position: 'sticky', top: 16 }}>
          <div className="card-title" style={{ marginBottom: 6 }}>Prévia no WhatsApp</div>
          <p className="text-muted" style={{ fontSize: 11.5, marginBottom: 14 }}>
            Como a mensagem chega no grupo
            {selectedGroups.length > 1 && ` · mesma bolha nos ${selectedGroups.length} grupos`}
          </p>
          <WhatsAppPreview
            mediaType={mediaType}
            text={content}
            caption={caption}
            file={mediaFile}
            groupName={groups.find((g) => g.id === selectedGroups[0])?.name}
          />
        </div>
      </div>

      <div className="card mt-16">
          <div className="card-title" style={{ marginBottom: 16 }}>Envios recentes</div>
          {!queue ? (
            <Loader />
          ) : queue.length === 0 ? (
            <EmptyState icon={<MessageSquare />} text="Nenhum envio ainda." />
          ) : (
            <div style={{ maxHeight: 560, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {queue.map((item) => (
                <div key={item.id} style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10 }}>
                  <div className="flex-between">
                    <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.groups?.name ?? 'Grupo removido'}
                    </span>
                    <div className="flex" style={{ gap: 6, flexShrink: 0 }}>
                      <StatusBadge status={item.priority} />
                      <StatusBadge status={item.status} pulse={item.status === 'processing'} />
                    </div>
                  </div>
                  <div className="text-secondary" style={{ fontSize: 12, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    [{MEDIA_LABEL[item.messages?.media_type ?? 'text']}] {item.messages?.content ?? item.messages?.caption ?? ''}
                  </div>
                  <div className="flex-between" style={{ marginTop: 6 }}>
                    <span className="text-muted" style={{ fontSize: 11 }}>
                      {formatDistanceToNow(new Date(item.created_at), { addSuffix: true, locale: ptBR })}
                    </span>
                    <div className="flex" style={{ gap: 6 }}>
                      {item.status === 'failed' && (
                        <button className="btn btn-ghost btn-sm" onClick={() => queueService.retryFailed(item.id).then(refreshQueue)}>
                          <RotateCcw /> Retry
                        </button>
                      )}
                      {item.status === 'pending' && (
                        <button className="btn btn-ghost btn-sm" onClick={() => queueService.cancel(item.id).then(refreshQueue)}>
                          <XCircle /> Cancelar
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
      </div>
    </>
  )
}
