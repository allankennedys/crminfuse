import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  AlertTriangle, ArrowLeft, Check, CheckCheck, CheckCircle2, Clock, Contact, FileText,
  Paperclip, RotateCcw, Send, X as XIcon,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore, useCan } from '@/store/authStore'
import { Loader } from '@/components/ui'
import { LinkifiedText } from '@/components/LinkifiedText'
import { toast } from '@/store/toastStore'
import {
  atendimentoService, conversationName, formatPhone, sessionLabel,
} from '@/services/atendimentoService'
import { formatBytes, formatDayLabel, formatTime, initials, sameDay } from './format'
import type { WaAttendant, WaConversation, WaMessage, WaSession } from '@/types'

const MAX_FILE = 100 * 1024 * 1024 // o limite do bucket at-media

interface Props {
  conversation: WaConversation
  session: WaSession | undefined
  names: Map<string, string>
  attendants: WaAttendant[]
  canAssign: boolean
  onBack: () => void
  onChanged: () => void
  onOpenContact?: (contactId: string) => void
}

const byTime = (a: WaMessage, b: WaMessage) =>
  new Date(a.wa_timestamp).getTime() - new Date(b.wa_timestamp).getTime()

export function ChatThread({
  conversation: conv, session, names, attendants, canAssign, onBack, onChanged, onOpenContact,
}: Props) {
  const userId = useAuthStore((s) => s.profile?.id)
  const can = useCan()

  const [messages, setMessages] = useState<WaMessage[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [urls, setUrls] = useState<Map<string, string>>(new Map())

  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [sending, setSending] = useState(false)
  const [busy, setBusy] = useState(false)

  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // Perto do fim = acompanha as mensagens novas. Rolou para cima lendo o
  // histórico = não arrasta a pessoa de volta.
  const stickRef = useRef(true)
  const prependRef = useRef<{ height: number; top: number } | null>(null)

  const merge = useCallback((row: WaMessage) => {
    setMessages((cur) => {
      if (!cur) return [row]
      const i = cur.findIndex((m) => m.id === row.id)
      if (i >= 0) {
        const next = [...cur]
        next[i] = row
        return next
      }
      return [...cur, row].sort(byTime)
    })
  }, [])

  // Carga inicial
  useEffect(() => {
    let alive = true
    atendimentoService.listMessages(conv.id)
      .then(({ items, hasMore }) => {
        if (!alive) return
        stickRef.current = true
        setMessages(items)
        setHasMore(hasMore)
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : 'Falha ao carregar a conversa')
        if (alive) setMessages([])
      })
    return () => { alive = false }
  }, [conv.id])

  // Ao vivo, só desta conversa. A RLS também vale aqui.
  useEffect(() => {
    const channel = supabase
      .channel(`at-messages:${conv.id}:${crypto.randomUUID()}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'wa_messages', filter: `conversation_id=eq.${conv.id}` },
        (payload) => {
          const row = payload.new as WaMessage
          if (row?.id) merge(row)
        },
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [conv.id, merge])

  // Links assinados das mídias (bucket privado, 1 h).
  useEffect(() => {
    if (!messages) return
    const missing = messages.map((m) => m.media_path).filter((p): p is string => Boolean(p) && !urls.has(p!))
    if (!missing.length) return
    let alive = true
    atendimentoService.signedUrls([...new Set(missing)]).then((got) => {
      if (!alive || !got.size) return
      setUrls((cur) => new Map([...cur, ...got]))
    })
    return () => { alive = false }
  }, [messages, urls])

  // "Lida" só quando a conversa é de quem está olhando (ou está na fila e ele
  // pode pegá-la). O supervisor espiando não apaga o contador do atendente.
  const souResponsavel = conv.assigned_to === userId || (!conv.assigned_to && canAssign)
  useEffect(() => {
    if (!souResponsavel || conv.unread_count === 0) return
    const mark = () => {
      if (document.visibilityState !== 'visible') return
      atendimentoService.markRead(conv.id).catch(() => { /* o contador fica; nada quebra */ })
    }
    const t = setTimeout(mark, 600)
    document.addEventListener('visibilitychange', mark)
    return () => { clearTimeout(t); document.removeEventListener('visibilitychange', mark) }
  }, [conv.id, conv.unread_count, souResponsavel])

  // Rolagem: mantém o lugar ao carregar o histórico; senão segue o fim.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el || !messages) return
    if (prependRef.current) {
      el.scrollTop = el.scrollHeight - prependRef.current.height + prependRef.current.top
      prependRef.current = null
      return
    }
    if (stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }

  const followIfStuck = () => {
    const el = listRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }

  const loadOlder = async () => {
    if (!messages?.length || loadingMore) return
    setLoadingMore(true)
    try {
      const { items, hasMore } = await atendimentoService.listMessages(conv.id, messages[0].wa_timestamp)
      const el = listRef.current
      if (el) prependRef.current = { height: el.scrollHeight, top: el.scrollTop }
      setMessages((cur) => {
        const seen = new Set((cur ?? []).map((m) => m.id))
        return [...items.filter((m) => !seen.has(m.id)), ...(cur ?? [])]
      })
      setHasMore(hasMore)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao carregar mensagens anteriores')
    } finally {
      setLoadingMore(false)
    }
  }

  // ---------- Envio ----------

  const autosize = () => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  useEffect(autosize, [text])

  const pickFile = (f: File | null | undefined) => {
    if (!f) return
    if (f.size > MAX_FILE) {
      toast.error(`Arquivo grande demais (${formatBytes(f.size)}). O limite é 100 MB.`)
      return
    }
    setFile(f)
    inputRef.current?.focus()
  }

  const send = async () => {
    const t = text.trim()
    if (sending || (!t && !file)) return
    setSending(true)
    try {
      const msg = file
        ? await atendimentoService.sendFile(conv, file, t)
        : await atendimentoService.sendText(conv.id, t)
      stickRef.current = true
      if (msg) merge(msg)
      setText('')
      setFile(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível enviar')
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  const onSubmit = (e: FormEvent) => { e.preventDefault(); send() }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter envia, Shift+Enter quebra a linha — e nada durante a composição
    // de acentos/IME, senão o "Enter" do teclado do celular manda pela metade.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  // ---------- Ações da conversa ----------

  const assign = async (value: string) => {
    setBusy(true)
    try {
      await atendimentoService.assign(conv.id, value || null)
      toast.success(value ? `Conversa atribuída a ${names.get(value) ?? 'atendente'}.` : 'Conversa devolvida à fila.')
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível atribuir')
    } finally {
      setBusy(false)
    }
  }

  const toggleStatus = async () => {
    setBusy(true)
    try {
      const next = conv.status === 'aberta' ? 'resolvida' : 'aberta'
      await atendimentoService.setStatus(conv.id, next)
      toast.success(next === 'resolvida' ? 'Conversa resolvida.' : 'Conversa reaberta.')
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível mudar a situação')
    } finally {
      setBusy(false)
    }
  }

  const name = conversationName(conv)
  const assignedName = conv.assigned_to ? names.get(conv.assigned_to) ?? 'Atendente' : null
  // O responsável atual pode ter perdido a permissão; continua na lista para
  // o seletor não mostrar uma opção errada.
  const options = conv.assigned_to && !attendants.some((a) => a.id === conv.assigned_to)
    ? [...attendants, { id: conv.assigned_to, name: `${assignedName} (sem acesso)`, role: 'atendente' as const }]
    : attendants

  const semNumero = !conv.session_id
  const aviso = semNumero
    ? 'O número desta conversa foi removido do painel. O histórico continua aqui, mas não dá para responder.'
    : session && !session.chat_enabled
      ? 'Este número foi desligado do atendimento: mensagens novas do cliente não chegam aqui.'
      : session && session.status !== 'connected'
        ? 'O número está desconectado do WhatsApp — o envio vai falhar até ele ser reconectado.'
        : null

  return (
    <div className="at-thread">
      <header className="at-thread-head">
        <button className="icon-btn at-back" onClick={onBack} aria-label="Voltar para a lista">
          <ArrowLeft size={17} />
        </button>
        <span className="at-avatar" aria-hidden="true">{initials(name)}</span>
        <div className="at-head-info">
          <div className="at-head-name">{name}</div>
          <div className="at-head-sub">
            {formatPhone(conv.phone) || 'Número oculto pelo WhatsApp'}
            {' · '}via {sessionLabel(session)}
          </div>
        </div>
        <div className="at-head-actions">
          {canAssign ? (
            <label className="channel-filter at-assign" title="Atendente responsável">
              <select value={conv.assigned_to ?? ''} disabled={busy} onChange={(e) => assign(e.target.value)} aria-label="Atendente">
                <option value="">Sem atendente</option>
                {options.map((a) => (
                  <option key={a.id} value={a.id}>{a.id === userId ? `${a.name} (eu)` : a.name}</option>
                ))}
              </select>
            </label>
          ) : (
            assignedName && <span className="badge badge-gray">{assignedName}</span>
          )}
          {conv.contact_id && onOpenContact && can('crm.contatos.ver') && (
            <button className="btn btn-ghost btn-sm" onClick={() => onOpenContact(conv.contact_id!)} title="Abrir o contato no CRM">
              <Contact size={14} /> CRM
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={toggleStatus} disabled={busy}>
            {conv.status === 'aberta'
              ? <><CheckCircle2 size={14} /> Resolver</>
              : <><RotateCcw size={14} /> Reabrir</>}
          </button>
        </div>
      </header>

      {aviso && (
        <div className="at-banner">
          <AlertTriangle size={14} /> {aviso}
        </div>
      )}

      <div className="at-messages" ref={listRef} onScroll={onScroll}>
        {messages === null ? (
          <Loader />
        ) : (
          <>
            {hasMore && (
              <div className="at-older">
                <button className="btn btn-ghost btn-sm" onClick={loadOlder} disabled={loadingMore}>
                  {loadingMore ? 'Carregando…' : 'Carregar mensagens anteriores'}
                </button>
              </div>
            )}
            {messages.length === 0 && <div className="at-day"><span>Nenhuma mensagem ainda</span></div>}
            {messages.map((m, i) => (
              <div key={m.id}>
                {(i === 0 || !sameDay(messages[i - 1].wa_timestamp, m.wa_timestamp)) && (
                  <div className="at-day"><span>{formatDayLabel(m.wa_timestamp)}</span></div>
                )}
                <Bubble
                  m={m}
                  url={m.media_path ? urls.get(m.media_path) : undefined}
                  author={m.from_me ? (m.sent_by ? names.get(m.sent_by) ?? 'Painel' : 'Celular') : null}
                  onMediaLoad={followIfStuck}
                />
              </div>
            ))}
          </>
        )}
      </div>

      <form className="at-composer" onSubmit={onSubmit}>
        {file && (
          <div className="at-attach-chip">
            <Paperclip size={13} />
            <span className="at-attach-name">{file.name}</span>
            <span className="text-muted">{formatBytes(file.size)}</span>
            <button type="button" className="icon-btn" onClick={() => setFile(null)} aria-label="Remover anexo">
              <XIcon size={13} />
            </button>
          </div>
        )}
        <div className="at-composer-row">
          <button
            type="button"
            className="icon-btn"
            onClick={() => fileRef.current?.click()}
            disabled={semNumero || sending}
            title="Anexar arquivo"
            aria-label="Anexar arquivo"
          >
            <Paperclip size={17} />
          </button>
          <input
            ref={fileRef}
            type="file"
            hidden
            onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = '' }}
          />
          <textarea
            ref={inputRef}
            className="at-input"
            rows={1}
            value={text}
            disabled={semNumero}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const f = e.clipboardData.files?.[0]
              if (f) { e.preventDefault(); pickFile(f) }
            }}
            placeholder={semNumero ? 'Conversa só para leitura' : file ? 'Legenda (opcional)' : 'Escreva uma mensagem'}
            aria-label="Mensagem"
          />
          <button
            type="submit"
            className="btn btn-primary at-send"
            disabled={semNumero || sending || (!text.trim() && !file)}
            aria-label="Enviar"
          >
            {sending ? <span className="spinner" /> : <Send size={16} />}
          </button>
        </div>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------

function Ticks({ status }: { status: WaMessage['status'] }) {
  if (status === 'pending') return <Clock size={12} aria-label="Enviando" />
  if (status === 'failed') return <AlertTriangle size={12} className="at-tick-failed" aria-label="Falhou" />
  if (status === 'read') return <CheckCheck size={14} className="at-tick-read" aria-label="Lida" />
  if (status === 'delivered') return <CheckCheck size={14} aria-label="Entregue" />
  return <Check size={14} aria-label="Enviada" />
}

function Bubble({ m, url, author, onMediaLoad }: {
  m: WaMessage
  url: string | undefined
  author: string | null
  onMediaLoad: () => void
}) {
  if (m.type === 'reaction') {
    return (
      <div className={`at-row ${m.from_me ? 'out' : 'in'}`}>
        <div className="at-reaction">{m.body}</div>
      </div>
    )
  }

  const hasMedia = ['image', 'video', 'audio', 'document', 'sticker'].includes(m.type)

  let media: React.ReactNode = null
  if (hasMedia) {
    if (m.media_status === 'falhou') {
      media = <div className="at-media-missing">Não foi possível baixar este arquivo — veja no celular.</div>
    } else if (!url) {
      media = <div className="at-media-missing">Carregando arquivo…</div>
    } else if (m.type === 'image' || m.type === 'sticker') {
      media = (
        <a href={url} target="_blank" rel="noreferrer">
          <img
            src={url}
            alt={m.type === 'sticker' ? 'Figurinha' : 'Imagem'}
            className={m.type === 'sticker' ? 'at-sticker' : 'at-img'}
            loading="lazy"
            onLoad={onMediaLoad}
          />
        </a>
      )
    } else if (m.type === 'video') {
      media = <video className="at-video" src={url} controls preload="metadata" onLoadedMetadata={onMediaLoad} />
    } else if (m.type === 'audio') {
      media = <audio className="at-audio" src={url} controls preload="metadata" />
    } else {
      media = (
        <a className="at-doc" href={url} target="_blank" rel="noreferrer" download={m.media_name ?? undefined}>
          <FileText size={18} /> <span>{m.media_name ?? 'Documento'}</span>
        </a>
      )
    }
  }

  return (
    <div className={`at-row ${m.from_me ? 'out' : 'in'}`}>
      <div className={`at-bubble${m.type === 'sticker' ? ' at-bubble-bare' : ''}`}>
        {media}
        {m.body && <div className="at-text"><LinkifiedText text={m.body} /></div>}
        <div className="at-meta">
          {author && <span className="at-author">{author}</span>}
          <span>{formatTime(m.wa_timestamp)}</span>
          {m.from_me && <Ticks status={m.status} />}
        </div>
      </div>
    </div>
  )
}
