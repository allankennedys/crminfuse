import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  AlertTriangle, ArrowLeft, ArrowRightLeft, Check, CheckCheck, CheckCircle2, Clock, Contact, FileText,
  Hand, Mic, Paperclip, Play, RotateCcw, Send, X as XIcon,
} from 'lucide-react'
import { useVoiceRecorder } from './useVoiceRecorder'
import { VoiceComposer } from './VoiceComposer'
import { MediaViewer, mediaKind, type MediaItem } from './MediaViewer'
import { AudioMessage } from './AudioMessage'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/store/authStore'
import { Loader, Modal } from '@/components/ui'
import { LinkifiedText } from '@/components/LinkifiedText'
import { toast } from '@/store/toastStore'
import {
  atendimentoService, conversationName, formatPhone, sessionLabel, type MediaLinks,
} from '@/services/atendimentoService'
import { formatBytes, formatDayLabel, formatTime, sameDay } from './format'
import { ClientPanel } from './ClientPanel'
import { ClientAvatar } from './ClientAvatar'
import type { WaAttendant, WaConversation, WaEvent, WaMessage, WaSession } from '@/types'

const MAX_FILE = 100 * 1024 * 1024 // o limite do bucket at-media

interface Props {
  conversation: WaConversation
  session: WaSession | undefined
  names: Map<string, string>
  attendants: WaAttendant[]
  canAssign: boolean
  /** Pode passar a conversa DELE para outra pessoa (119). */
  canTransfer: boolean
  /** Enxerga a Fila (restrição desligada ou "ver todas"): pode assumir. */
  canTake: boolean
  /** Motivos oferecidos ao concluir (120). Vazio = conclui sem perguntar. */
  conclusionReasons: string[]
  onBack: () => void
  onChanged: () => void
  onOpenContact?: (contactId: string) => void
}

/** Mensagens seguidas do mesmo lado, até 5 min uma da outra, viram um bloco. */
const GRUPO_MS = 5 * 60_000
type PosGrupo = 'solo' | 'first' | 'mid' | 'last'

/**
 * Posição de cada mensagem no seu bloco. Quebra o bloco: trocar de lado,
 * outro atendente, mais de 5 min de intervalo, outro dia, um aviso no meio
 * (evento) ou uma reação.
 */
function posicoesNoBloco(items: { m?: WaMessage }[]): Map<string, PosGrupo> {
  const out = new Map<string, PosGrupo>()
  let bloco: WaMessage[] = []
  const fecha = () => {
    bloco.forEach((m, i) => out.set(m.id, bloco.length === 1 ? 'solo' : i === 0 ? 'first' : i === bloco.length - 1 ? 'last' : 'mid'))
    bloco = []
  }
  for (const it of items) {
    const m = it.m
    if (!m || m.type === 'reaction') { fecha(); continue }
    const ult = bloco[bloco.length - 1]
    if (ult && (
      ult.from_me !== m.from_me
      || (m.from_me && ult.sent_by !== m.sent_by)
      || !sameDay(ult.wa_timestamp, m.wa_timestamp)
      || new Date(m.wa_timestamp).getTime() - new Date(ult.wa_timestamp).getTime() > GRUPO_MS
    )) fecha()
    bloco.push(m)
  }
  fecha()
  return out
}

const byTime = (a: WaMessage, b: WaMessage) =>
  new Date(a.wa_timestamp).getTime() - new Date(b.wa_timestamp).getTime()

export function ChatThread({
  conversation: conv, session, names, attendants, canAssign, canTransfer, canTake, conclusionReasons,
  onBack, onChanged, onOpenContact,
}: Props) {
  const userId = useAuthStore((s) => s.profile?.id)

  const [messages, setMessages] = useState<WaMessage[] | null>(null)
  const [events, setEvents] = useState<WaEvent[]>([])
  const [showTransfer, setShowTransfer] = useState(false)
  const [showConclude, setShowConclude] = useState(false)
  // Painel do cliente: aberto por padrão em tela larga, onde cabe ao lado.
  const [showClient, setShowClient] = useState(() => window.innerWidth >= 1280)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  // Links (abrir/baixar) das mídias, por id da mensagem.
  const [urls, setUrls] = useState<Map<string, MediaLinks>>(new Map())
  const pedidosRef = useRef<Set<string>>(new Set())
  // Mídia aberta no visualizador (id da mensagem).
  const [mediaAberta, setMediaAberta] = useState<string | null>(null)
  const fecharMidia = useCallback(() => setMediaAberta(null), [])

  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  // Mensagens a caminho: aparecem na hora (relógio) e saem quando a
  // confirmada chega — pela resposta do envio ou pelo tempo real.
  const [pendentes, setPendentes] = useState<WaMessage[]>([])
  const arquivosPendentes = useRef(new Map<string, File>())
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

  // Foto de perfil: conversa nunca conferida ou conferida há mais de 3 dias
  // pede ao servidor (que decide se precisa mesmo ir ao WhatsApp). A foto
  // nova chega pela atualização da conversa.
  useEffect(() => {
    const velha = !conv.avatar_checked_at
      || Date.now() - new Date(conv.avatar_checked_at).getTime() > 3 * 24 * 60 * 60 * 1000
    if (velha && conv.session_id) atendimentoService.refreshAvatar(conv.id).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.id])

  // Histórico de atribuição/transferência (119), intercalado com as mensagens.
  useEffect(() => {
    atendimentoService.listEvents(conv.id).then(setEvents).catch(() => setEvents([]))
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
          if (!row?.id) return
          merge(row)
          if (payload.eventType === 'INSERT' && row.from_me && row.sent_by === userId) {
            setPendentes((p) => {
              const i = p.findIndex((x) => x.status === 'pending'
                && (row.type === 'text' ? x.body === row.body : x.media_name === row.media_name))
              return i < 0 ? p : p.filter((_, j) => j !== i)
            })
          }
        },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'wa_conversation_events', filter: `conversation_id=eq.${conv.id}` },
        (payload) => {
          const row = payload.new as WaEvent
          if (row?.id) setEvents((cur) => (cur.some((e) => e.id === row.id) ? cur : [...cur, row]))
        },
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [conv.id, merge, userId])

  // Links temporários das mídias (1 h), gerados pelo servidor depois de
  // conferir a permissão — o arquivo pode estar no R2 ou no Storage. Cada
  // mensagem é pedida uma vez só (pedidosRef), mesmo se não vier link.
  useEffect(() => {
    if (!messages) return
    const missing = messages
      .filter((m) => m.media_path && !urls.has(m.id) && !pedidosRef.current.has(m.id))
      .map((m) => m.id)
    if (!missing.length) return
    missing.forEach((id) => pedidosRef.current.add(id))
    atendimentoService.mediaUrls(missing)
      .then((got) => { if (got.size) setUrls((cur) => new Map([...cur, ...got])) })
      .catch(() => { missing.forEach((id) => pedidosRef.current.delete(id)) })
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
  }, [messages, pendentes])

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

  const novoPendente = (p: Partial<WaMessage>): WaMessage => {
    const agora = new Date().toISOString()
    return {
      id: `tmp-${crypto.randomUUID()}`, conversation_id: conv.id, wa_message_id: '', from_me: true,
      sent_by: userId ?? null, type: 'text', body: null, media_path: null, media_mime: null, media_name: null,
      media_status: null, status: 'pending', wa_timestamp: agora, created_at: agora, ...p,
    }
  }

  const despachar = (temp: WaMessage) => {
    const arquivo = arquivosPendentes.current.get(temp.id)
    setPendentes((p) => [...p.filter((x) => x.id !== temp.id), { ...temp, status: 'pending' }])
    stickRef.current = true
    const envio = arquivo
      ? atendimentoService.sendFile(conv, arquivo, temp.body ?? undefined)
      : atendimentoService.sendText(conv.id, temp.body ?? '')
    envio
      .then((msg) => {
        setPendentes((p) => p.filter((x) => x.id !== temp.id))
        arquivosPendentes.current.delete(temp.id)
        if (msg) merge(msg)
      })
      .catch((err) => {
        const erro = err instanceof Error ? err.message : 'Não foi possível enviar'
        setPendentes((p) => p.map((x) => (x.id === temp.id ? { ...x, status: 'failed' } : x)))
        toast.error(erro)
      })
  }

  const descartarPendente = (id: string) => {
    arquivosPendentes.current.delete(id)
    setPendentes((p) => p.filter((x) => x.id !== id))
  }

  const tipoDoArquivo = (f: File): WaMessage['type'] =>
    f.type.startsWith('image/') ? 'image'
      : f.type.startsWith('video/') ? 'video'
      : f.type.startsWith('audio/') ? 'audio'
      : 'document'

  // Envio otimista: a tela não espera o WhatsApp. A caixa limpa na hora e dá
  // para mandar a próxima enquanto a anterior ainda está saindo.
  const send = () => {
    const t = text.trim()
    if (!t && !file) return
    if (file) {
      const temp = novoPendente({
        type: tipoDoArquivo(file), body: t || null, media_name: file.name, media_mime: file.type, media_status: 'pendente',
      })
      arquivosPendentes.current.set(temp.id, file)
      despachar(temp)
    } else {
      despachar(novoPendente({ type: 'text', body: t }))
    }
    setText('')
    setFile(null)
    inputRef.current?.focus()
  }

  const onSubmit = (e: FormEvent) => { e.preventDefault(); send() }

  // Mensagem de voz: grava no navegador e manda como arquivo de áudio — a
  // wa-chat envia áudio como mensagem de voz (PTT).
  const voice = useVoiceRecorder(
    (audio) => {
      const temp = novoPendente({ type: 'audio', media_name: audio.name, media_mime: audio.type, media_status: 'pendente' })
      arquivosPendentes.current.set(temp.id, audio)
      despachar(temp)
    },
    (e) => toast.error(
      e === 'sem-permissao' ? 'Permita o uso do microfone no navegador para gravar áudio.'
        : e === 'sem-suporte' ? 'Este navegador não grava áudio. Use Chrome, Edge ou Firefox atualizados.'
        : 'Áudio muito curto. Grave pelo menos 1 segundo.',
    ),
  )
  const podeGravar = !text.trim() && !file

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter envia, Shift+Enter quebra a linha — e nada durante a composição
    // de acentos/IME, senão o "Enter" do teclado do celular manda pela metade.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  // ---------- Ações da conversa ----------

  const take = async () => {
    if (!userId) return
    setBusy(true)
    try {
      await atendimentoService.transfer(conv.id, userId)
      toast.success('Conversa assumida.')
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível assumir')
    } finally {
      setBusy(false)
    }
  }

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

  const reopen = async () => {
    setBusy(true)
    try {
      await atendimentoService.reopen(conv.id)
      toast.success('Atendimento reaberto.')
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível reabrir')
    } finally {
      setBusy(false)
    }
  }

  // Situação do atendimento, derivada da conversa (o banco mantém as duas
  // em sincronia — 120).
  const situacao = conv.status === 'resolvida'
    ? { label: 'Concluído', cls: 'badge-gray' }
    : conv.assigned_to
      ? { label: 'Em atendimento', cls: 'badge-blue' }
      : { label: 'Na fila', cls: 'badge-yellow' }

  // Concluir: o responsável, quem atribui, ou quem pega da fila. O banco
  // confere de novo (wa_conclude).
  const podeConcluir = conv.assigned_to === userId || canAssign || (!conv.assigned_to && canTake)

  // Mensagens e histórico numa linha do tempo só. Com histórico antigo ainda
  // não carregado, eventos anteriores à primeira mensagem ficam de fora —
  // aparecem junto com as mensagens da época.
  const timeline = (() => {
    if (!messages) return []
    const desde = hasMore && messages.length ? new Date(messages[0].wa_timestamp).getTime() : -Infinity
    const items: { key: string; at: string; m?: WaMessage; e?: WaEvent }[] = [
      ...messages.map((m) => ({ key: m.id, at: m.wa_timestamp, m })),
      ...pendentes.map((m) => ({ key: m.id, at: m.wa_timestamp, m })),
      ...events.filter((e) => new Date(e.created_at).getTime() >= desde).map((e) => ({ key: e.id, at: e.created_at, e })),
    ]
    return items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
  })()

  const name = conversationName(conv)
  const blocos = posicoesNoBloco(timeline)

  // Fotos, vídeos e PDFs da conversa, na ordem: o que o visualizador passa.
  const galeria: MediaItem[] = timeline.flatMap((it) => {
    const m = it.m
    if (!m || m.id.startsWith('tmp-') || m.media_status === 'falhou' || !m.media_path) return []
    const kind = mediaKind(m)
    const links = urls.get(m.id)
    if (!kind || !links) return []
    const author = m.from_me
      ? (m.sent_by ? names.get(m.sent_by) ?? 'Equipe' : 'Enviada pelo celular')
      : name
    return [{ id: m.id, kind, url: links.url, download: links.download, name: m.media_name, caption: m.body, at: m.wa_timestamp, author }]
  })
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
        ? 'O número está desconectado do WhatsApp. O envio vai falhar até ele ser reconectado.'
        : null

  return (
    <div className="at-thread-wrap">
    <div className="at-thread">
      <header className="at-thread-head">
        <button className="icon-btn at-back" onClick={onBack} aria-label="Voltar para a lista">
          <ArrowLeft size={17} />
        </button>
        <ClientAvatar conv={conv} name={name} />
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
          ) : conv.assigned_to === userId && canTransfer ? (
            <button className="btn btn-ghost btn-sm" onClick={() => setShowTransfer(true)} disabled={busy}>
              <ArrowRightLeft size={14} /> Transferir
            </button>
          ) : !conv.assigned_to && canTake ? (
            <button className="btn btn-primary btn-sm" onClick={take} disabled={busy}>
              <Hand size={14} /> Assumir
            </button>
          ) : (
            assignedName && (
              <span className="badge badge-gray">{conv.assigned_to === userId ? 'Você' : assignedName}</span>
            )
          )}
          <button
            className={`btn btn-ghost btn-sm${showClient ? ' btn-active' : ''}`}
            onClick={() => setShowClient((v) => !v)}
            aria-pressed={showClient}
          >
            <Contact size={14} /> Cliente
          </button>
          <span className={`badge ${situacao.cls}`}>{situacao.label}</span>
          {conv.status === 'aberta' ? (
            podeConcluir && (
              <button className="btn btn-ghost btn-sm" onClick={() => setShowConclude(true)} disabled={busy}>
                <CheckCircle2 size={14} /> Concluir
              </button>
            )
          ) : (
            <button className="btn btn-ghost btn-sm" onClick={reopen} disabled={busy}>
              <RotateCcw size={14} /> Reabrir
            </button>
          )}
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
            {timeline.length === 0 && <div className="at-day"><span>Nenhuma mensagem ainda</span></div>}
            {timeline.map((item, i) => (
              <div key={item.key}>
                {(i === 0 || !sameDay(timeline[i - 1].at, item.at)) && (
                  <div className="at-day"><span>{formatDayLabel(item.at)}</span></div>
                )}
                {item.m ? (
                  <Bubble
                    m={item.m}
                    pos={blocos.get(item.m.id) ?? 'solo'}
                    url={item.m.media_path ? urls.get(item.m.id)?.url : undefined}
                    author={item.m.from_me ? (item.m.sent_by ? names.get(item.m.sent_by) ?? 'Equipe' : 'Enviada pelo celular') : null}
                    onMediaLoad={followIfStuck}
                    onOpen={mediaKind(item.m) ? () => setMediaAberta(item.m!.id) : undefined}
                    onRetry={item.m.status === 'failed' && item.m.id.startsWith('tmp-') ? () => despachar(item.m!) : undefined}
                    onDiscard={item.m.status === 'failed' && item.m.id.startsWith('tmp-') ? () => descartarPendente(item.m!.id) : undefined}
                  />
                ) : item.e ? (
                  <div className="at-event">
                    <span>{eventText(item.e, names, userId)} · {formatTime(item.e.created_at)}</span>
                    {item.e.note && <em>“{item.e.note}”</em>}
                  </div>
                ) : null}
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
        {voice.phase !== 'idle' ? (
          <VoiceComposer voice={voice} />
        ) : (
          <div className="at-composer-row">
            <button
              type="button"
              className="icon-btn"
              onClick={() => fileRef.current?.click()}
              disabled={semNumero}
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
            {podeGravar ? (
              <button
                type="button"
                className="btn btn-primary at-send"
                onClick={voice.start}
                disabled={semNumero}
                title="Gravar mensagem de voz"
                aria-label="Gravar mensagem de voz"
              >
                <Mic size={16} />
              </button>
            ) : (
              <button
                type="submit"
                className="btn btn-primary at-send"
                disabled={semNumero || (!text.trim() && !file)}
                aria-label="Enviar"
              >
                <Send size={16} />
              </button>
            )}
          </div>
        )}
      </form>
      {showConclude && (
        <ConcludeDialog
          reasons={conclusionReasons}
          onClose={() => setShowConclude(false)}
          onConfirm={async (reason, note) => {
            await atendimentoService.conclude(conv.id, reason, note)
            toast.success('Atendimento concluído.')
            setShowConclude(false)
            onChanged()
          }}
        />
      )}

      {mediaAberta && <MediaViewer items={galeria} startId={mediaAberta} onClose={fecharMidia} />}
      {showTransfer && (
        <TransferDialog
          conversationName={name}
          currentUser={conv.assigned_to}
          attendants={attendants}
          onClose={() => setShowTransfer(false)}
          onConfirm={async (to, note) => {
            await atendimentoService.transfer(conv.id, to, note)
            toast.success(to ? `Conversa transferida para ${names.get(to) ?? 'atendente'}.` : 'Conversa devolvida à fila.')
            setShowTransfer(false)
            onChanged()
          }}
        />
      )}
    </div>
    {showClient && (
      <ClientPanel conversation={conv} onClose={() => setShowClient(false)} onOpenContact={onOpenContact} />
    )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function eventText(e: WaEvent, names: Map<string, string>, me: string | undefined): string {
  const who = (id: string | null) => (!id ? 'alguém' : id === me ? 'você' : names.get(id) ?? 'alguém')
  const Who = (id: string | null) => {
    const w = who(id)
    return w.charAt(0).toUpperCase() + w.slice(1)
  }
  switch (e.kind) {
    case 'auto':
      return `Atribuída automaticamente a ${who(e.to_user)}${e.note ? ` (${e.note})` : ''}`
    case 'atribuida':
      return e.by_user && e.by_user === e.to_user
        ? `${Who(e.by_user)} assumiu a conversa`
        : `${Who(e.by_user)} atribuiu a ${who(e.to_user)}`
    case 'transferida':
      return e.from_user && e.from_user !== e.by_user
        ? `${Who(e.by_user)} transferiu de ${who(e.from_user)} para ${who(e.to_user)}`
        : `${Who(e.by_user)} transferiu para ${who(e.to_user)}`
    case 'fila':
      return `${Who(e.by_user)} devolveu à fila`
    case 'resolvida':
      return `${Who(e.by_user)} concluiu o atendimento`
    case 'reaberta':
      return `${Who(e.by_user)} reabriu o atendimento`
  }
}

function ConcludeDialog({ reasons, onClose, onConfirm }: {
  reasons: string[]
  onClose: () => void
  onConfirm: (reason: string | null, note: string) => Promise<void>
}) {
  const [reason, setReason] = useState(reasons[0] ?? '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await onConfirm(reason || null, note)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível concluir')
      setBusy(false)
    }
  }

  return (
    <Modal title="Concluir atendimento" onClose={onClose}>
      <form onSubmit={submit}>
        {reasons.length > 0 && (
          <div className="field">
            <label>Motivo</label>
            <div className="at-modes">
              {reasons.map((r) => (
                <label key={r} className={`at-mode${reason === r ? ' active' : ''}`}>
                  <input type="radio" name="conclusion" checked={reason === r} onChange={() => setReason(r)} />
                  <span><strong>{r}</strong></span>
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="field">
          <label htmlFor="conclude-note">Observação <span className="text-muted">(opcional)</span></label>
          <textarea
            id="conclude-note"
            className="input"
            rows={3}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <p className="text-muted" style={{ fontSize: 12 }}>
          Se o cliente escrever de novo, abre um atendimento novo. Para continuar este, use Reabrir.
        </p>
        <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <span className="spinner" /> : 'Concluir'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function TransferDialog({ conversationName, currentUser, attendants, onClose, onConfirm }: {
  conversationName: string
  currentUser: string | null
  attendants: WaAttendant[]
  onClose: () => void
  onConfirm: (to: string | null, note: string) => Promise<void>
}) {
  const [to, setTo] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const options = attendants.filter((a) => a.id !== currentUser)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!to) return
    setBusy(true)
    try {
      await onConfirm(to === '__fila__' ? null : to, note)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível transferir')
      setBusy(false)
    }
  }

  return (
    <Modal title={`Transferir conversa de ${conversationName}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="transfer-to">Para</label>
          <select id="transfer-to" className="input" value={to} onChange={(e) => setTo(e.target.value)} autoFocus>
            <option value="">Escolha…</option>
            {options.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            <option value="__fila__">Devolver à fila (sem atendente)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="transfer-note">Nota <span className="text-muted">(opcional, fica no histórico da conversa)</span></label>
          <textarea
            id="transfer-note"
            className="input"
            rows={3}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Ex.: cliente quer falar sobre o boleto"
          />
        </div>
        <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={!to || busy}>
            {busy ? <span className="spinner" /> : 'Transferir'}
          </button>
        </div>
      </form>
    </Modal>
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

function Bubble({ m, pos, url, author, onMediaLoad, onOpen, onRetry, onDiscard }: {
  m: WaMessage
  /** Posição no bloco de mensagens seguidas: decide cantos, hora e rótulo. */
  pos: PosGrupo
  url: string | undefined
  /** Quem da equipe enviou (só nas mensagens da equipe): vai acima do bloco. */
  author: string | null
  onMediaLoad: () => void
  /** Foto, vídeo ou PDF: abre no visualizador. */
  onOpen?: () => void
  /** Só em mensagem que não saiu: tentar de novo / tirar da tela. */
  onRetry?: () => void
  onDiscard?: () => void
}) {
  const aCaminho = m.id.startsWith('tmp-')
  if (m.type === 'reaction') {
    return (
      <div className={`at-row ${m.from_me ? 'out' : 'in'} g-solo`}>
        <div className="at-reaction">{m.body}</div>
      </div>
    )
  }

  const hasMedia = ['image', 'video', 'audio', 'document', 'sticker'].includes(m.type)

  let media: React.ReactNode = null
  if (hasMedia) {
    if (m.media_status === 'falhou') {
      media = <div className="at-media-missing">Não foi possível baixar este arquivo. Veja no celular.</div>
    } else if (aCaminho) {
      media = (
        <div className="at-media-missing">
          {m.type === 'audio' ? '🎤 Mensagem de voz' : `📎 ${m.media_name ?? 'Arquivo'}`}
          {m.status === 'pending' ? ' · enviando…' : ''}
        </div>
      )
    } else if (!url) {
      media = <div className="at-media-missing">Carregando arquivo…</div>
    } else if (m.type === 'sticker') {
      media = <img src={url} alt="Figurinha" className="at-sticker" loading="lazy" onLoad={onMediaLoad} />
    } else if (m.type === 'image') {
      media = (
        <button type="button" className="at-media-btn" onClick={onOpen} aria-label="Abrir imagem">
          <img src={url} alt="Imagem" className="at-img" loading="lazy" onLoad={onMediaLoad} />
        </button>
      )
    } else if (m.type === 'video') {
      // Prévia parada (o 1º quadro, via #t=) com botão de play: o vídeo
      // toca no visualizador, grande.
      media = (
        <button type="button" className="at-media-btn at-video-thumb" onClick={onOpen} aria-label="Abrir vídeo">
          <video className="at-video" src={`${url}#t=0.1`} preload="metadata" muted playsInline onLoadedMetadata={onMediaLoad} />
          <span className="at-play-badge" aria-hidden="true"><Play size={22} fill="currentColor" /></span>
        </button>
      )
    } else if (m.type === 'audio') {
      media = <AudioMessage id={m.id} url={url} />
    } else if (onOpen) {
      // PDF (ou foto/vídeo mandado como documento): abre no visualizador.
      const pdf = mediaKind(m) === 'pdf'
      media = (
        <button type="button" className="at-doc" onClick={onOpen}>
          <FileText size={18} />
          <span>{m.media_name ?? 'Documento'}</span>
          {pdf && <span className="at-doc-tag">PDF</span>}
        </button>
      )
    } else {
      media = (
        <a className="at-doc" href={url} target="_blank" rel="noreferrer" download={m.media_name ?? undefined}>
          <FileText size={18} /> <span>{m.media_name ?? 'Documento'}</span>
        </a>
      )
    }
  }

  // Hora (e os tiques) só no fim do bloco; nas outras, ao passar o mouse.
  // Enviando/falhou aparecem sempre.
  const hora = formatTime(m.wa_timestamp)
  const mostraMeta = pos === 'last' || pos === 'solo' || m.status === 'pending' || m.status === 'failed'
  const visual = (m.type === 'image' || m.type === 'video') && Boolean(url) && !aCaminho && m.media_status !== 'falhou'
  const classes = [
    'at-bubble',
    m.type === 'sticker' ? 'at-bubble-bare' : '',
    visual ? 'at-bubble-media' : '',
    visual && !m.body ? 'at-bubble-media-only' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={`at-row ${m.from_me ? 'out' : 'in'} g-${pos}`}>
      {author && (pos === 'first' || pos === 'solo') && <div className="at-label">{author}</div>}
      <div className={classes} title={mostraMeta ? undefined : hora}>
        {media}
        {m.body && <div className="at-text"><LinkifiedText text={m.body} /></div>}
        {mostraMeta && (
          <div className="at-meta">
            <span>{hora}</span>
            {m.from_me && <Ticks status={m.status} />}
          </div>
        )}
        {(onRetry || onDiscard) && (
          <div className="at-failed">
            <span>Não enviada</span>
            {onRetry && <button type="button" onClick={onRetry}>Tentar de novo</button>}
            {onDiscard && <button type="button" onClick={onDiscard}>Descartar</button>}
          </div>
        )}
      </div>
    </div>
  )
}
