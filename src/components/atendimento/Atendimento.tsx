import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MessageCircle, MessageCirclePlus, Search, Smartphone, X as XIcon } from 'lucide-react'
import { useConversaStore } from '@/store/conversaStore'
import { supabase } from '@/lib/supabase'
import { useAuthStore, useCan } from '@/store/authStore'
import { EmptyState, Loader } from '@/components/ui'
import { toast } from '@/store/toastStore'
import {
  atendimentoService, conversationName, sessionLabel, type WaScope,
} from '@/services/atendimentoService'
import { ChatThread } from './ChatThread'
import { ClientAvatar } from './ClientAvatar'
import { NumerosAtendimento } from './NumerosAtendimento'
import { formatListTime } from './format'
import type { WaAttendant, WaConversation, WaConversationStatus, WaSession } from '@/types'

/**
 * Aba Atendimento do CRM: lista de conversas à esquerda, conversa à direita.
 *
 * O que cada um vê é decidido pela RLS (116). Aqui só escolhemos os filtros
 * que fazem sentido mostrar: quem não tem "ver todas" não ganha as abas
 * Minhas/Fila/Todas — para ele só existem as dele.
 */
export function Atendimento({ onOpenContact }: { onOpenContact?: (contactId: string) => void }) {
  const profile = useAuthStore((s) => s.profile)
  const permissions = useAuthStore((s) => s.permissions)
  const can = useCan()
  const verTodas = can('atendimento.ver_todas')
  const podeAtribuir = can('atendimento.atribuir')
  const podeTransferir = can('atendimento.transferir')
  const podeConfigurar = can('atendimento.configurar')
  const userId = profile?.id ?? ''

  // Configuração da organização (119): com a restrição desligada, todo
  // atendente enxerga todas as conversas — e a tela ganha as abas e a Fila.
  const [restricted, setRestricted] = useState(true)
  const [conclusionReasons, setConclusionReasons] = useState<string[]>([])
  useEffect(() => {
    if (!profile) return
    atendimentoService.getSettings(profile.organization_id)
      .then((s) => { setRestricted(s.restrict_to_assigned); setConclusionReasons(s.conclusion_reasons) })
      .catch(() => { /* fica restrito: o banco decide de qualquer jeito */ })
  }, [profile])
  const veTudo = verTodas || !restricted

  const [scope, setScope] = useState<WaScope>('minhas')
  const [status, setStatus] = useState<WaConversationStatus>('aberta')
  const [assignee, setAssignee] = useState('')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')

  const [conversations, setConversations] = useState<WaConversation[] | null>(null)
  const [queueCount, setQueueCount] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // A conversa aberta pode sair da lista (filtro trocado, resolvida); a
  // cópia mantém o painel da direita aberto até alguém fechar.
  const [selectedSnapshot, setSelectedSnapshot] = useState<WaConversation | null>(null)

  const [sessions, setSessions] = useState<Map<string, WaSession>>(new Map())
  const [attendants, setAttendants] = useState<WaAttendant[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [showNumeros, setShowNumeros] = useState(false)

  // Restrito e sem "ver todas": a única visão possível é a das próprias.
  useEffect(() => {
    if (!veTudo && scope !== 'minhas') setScope('minhas')
  }, [veTudo, scope])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(t)
  }, [search])

  const loadSessions = useCallback(() => {
    atendimentoService.sessions()
      .then((list) => setSessions(new Map(list.map((s) => [s.id, s]))))
      .catch(() => { /* a lista funciona sem os rótulos dos números */ })
  }, [])

  useEffect(() => {
    loadSessions()
    atendimentoService.userNames().then(setNames).catch(() => {})
    if (podeAtribuir || verTodas || podeTransferir) atendimentoService.attendants().then(setAttendants).catch(() => setAttendants([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissions])

  const selectedIdRef = useRef<string | null>(null)
  selectedIdRef.current = selectedId

  // Cache por filtro: trocar de aba mostra na hora o que já foi visto e
  // atualiza por baixo, em vez de esperar a rede com a lista antiga na tela.
  const cacheRef = useRef<Map<string, WaConversation[]>>(new Map())
  const keyRef = useRef('')
  const filtroKey = `${scope}|${status}|${scope === 'todas' ? assignee : ''}|${debouncedSearch}`
  keyRef.current = filtroKey
  useLayoutEffect(() => {
    const cached = cacheRef.current.get(filtroKey)
    if (cached) setConversations(cached)
    else setConversations(null)
  }, [filtroKey])

  const load = useCallback(async () => {
    if (!userId) return
    const key = filtroKey
    try {
      if (veTudo) atendimentoService.queueCount().then(setQueueCount)
      else setQueueCount(0)
      const list = await atendimentoService.listConversations({
        scope, status, userId, assignee: scope === 'todas' ? assignee || undefined : undefined, search: debouncedSearch,
      })
      cacheRef.current.set(key, list)
      if (keyRef.current !== key) return // trocou de aba enquanto buscava
      setConversations(list)

      // A conversa aberta sumiu da lista: filtro, ou o usuário perdeu o
      // acesso (foi transferida para outro atendente). No segundo caso fecha.
      const open = selectedIdRef.current
      if (open) {
        const inList = list.find((c) => c.id === open)
        if (inList) {
          setSelectedSnapshot(inList)
        } else {
          const fresh = await atendimentoService.getConversation(open)
          if (!fresh) {
            setSelectedId(null)
            setSelectedSnapshot(null)
            toast.info('A conversa foi transferida para outro atendente.')
          } else {
            setSelectedSnapshot(fresh)
          }
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao carregar as conversas')
      setConversations((cur) => cur ?? [])
    }
  }, [scope, status, assignee, debouncedSearch, userId, veTudo, filtroKey])

  useEffect(() => { load() }, [load])

  // Aquece as outras abas: a primeira troca também já é instantânea.
  useEffect(() => {
    if (!userId || debouncedSearch) return
    const outras = (['minhas', 'fila', 'todas'] as WaScope[]).filter((sc) => sc !== scope && (veTudo || sc === 'minhas'))
    outras.forEach((sc) => {
      const k = `${sc}|${status}||`
      atendimentoService.listConversations({ scope: sc, status, userId, search: '' })
        .then((l) => { cacheRef.current.set(k, l) })
        .catch(() => {})
    })
  }, [userId, status, veTudo, debouncedSearch, scope])

  // Ao vivo: qualquer mudança visível (mensagem nova, atribuição) recarrega a
  // lista — 300 linhas leves, e assim filtro e ordem nunca saem do lugar.
  // A RLS vale para o Realtime: o atendente só recebe evento das dele.
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const bump = () => {
      clearTimeout(timer)
      timer = setTimeout(() => loadRef.current(), 400)
    }
    const channel = supabase
      .channel(`at-conversations:${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wa_conversations' }, bump)
      .subscribe()
    // Conversa tirada de alguém não gera evento para ele (a RLS esconde a
    // linha nova). O relógio e a volta à aba cobrem esse caso.
    const interval = setInterval(bump, 60_000)
    window.addEventListener('focus', bump)
    return () => {
      clearTimeout(timer)
      clearInterval(interval)
      window.removeEventListener('focus', bump)
      supabase.removeChannel(channel)
    }
  }, [])

  // Conversa pedida por outra tela (iniciada agora): abre assim que montar.
  const abrirPedida = useConversaStore((s) => s.abrir)
  const consumirPedida = useConversaStore((s) => s.consumir)
  const pedirConversa = useConversaStore((s) => s.pedir)
  useEffect(() => {
    if (!abrirPedida) return
    const id = abrirPedida
    consumirPedida()
    atendimentoService.getConversation(id).then((c) => {
      if (!c) return
      if (c.status !== status) setStatus(c.status)
      setSelectedId(c.id)
      setSelectedSnapshot(c)
      load()
    })
  }, [abrirPedida, consumirPedida, load, status])

  const selected = useMemo(
    () => conversations?.find((c) => c.id === selectedId) ?? (selectedSnapshot?.id === selectedId ? selectedSnapshot : null),
    [conversations, selectedId, selectedSnapshot],
  )

  const open = (c: WaConversation) => {
    setSelectedId(c.id)
    setSelectedSnapshot(c)
  }

  const scopes: { id: WaScope; label: string; count?: number }[] = [
    { id: 'minhas', label: 'Minhas' },
    { id: 'fila', label: 'Fila', count: queueCount },
    { id: 'todas', label: 'Todas' },
  ]

  return (
    <div className={`at-shell${selected ? ' at-has-selection' : ''}`}>
      <aside className="at-list">
        <div className="at-list-head">
          <div className="at-list-title">
            <span>Conversas</span>
            <div className="flex" style={{ gap: 6 }}>
              {podeConfigurar && (
                <button className="btn btn-ghost btn-sm" onClick={() => setShowNumeros(true)} title="Números do atendimento">
                  <Smartphone size={14} /> Números
                </button>
              )}
              <button className="btn btn-primary btn-sm" onClick={() => pedirConversa()} title="Iniciar conversa com um cliente">
                <MessageCirclePlus size={14} /> Nova
              </button>
            </div>
          </div>

          {veTudo && (
            <div className="at-seg" role="tablist" aria-label="Quais conversas">
              {scopes.map((s) => (
                <button
                  key={s.id}
                  role="tab"
                  aria-selected={scope === s.id}
                  className={`at-seg-btn${scope === s.id ? ' active' : ''}`}
                  onClick={() => setScope(s.id)}
                >
                  {s.label}
                  {s.count ? <span className="at-seg-count">{s.count}</span> : null}
                </button>
              ))}
            </div>
          )}

          <label className="crm-search crm-search-block">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nome ou número…"
              aria-label="Buscar conversa"
            />
            {search && (
              <button className="crm-search-clear" onClick={() => setSearch('')} aria-label="Limpar busca">
                <XIcon size={13} />
              </button>
            )}
            <Search size={14} />
          </label>

          <div className="at-filters">
            <label className="channel-filter">
              <select value={status} onChange={(e) => setStatus(e.target.value as WaConversationStatus)} aria-label="Situação">
                <option value="aberta">Em aberto</option>
                <option value="resolvida">Concluídas</option>
              </select>
            </label>
            {veTudo && scope === 'todas' && attendants.length > 0 && (
              <label className="channel-filter">
                <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Atendente">
                  <option value="">Todos os atendentes</option>
                  {attendants.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            )}
          </div>
        </div>

        <div className="at-list-items">
          {conversations === null ? (
            <Loader />
          ) : conversations.length === 0 ? (
            <EmptyState
              icon={<MessageCircle />}
              text={
                debouncedSearch ? 'Nenhuma conversa encontrada.'
                  : scope === 'minhas' ? (status === 'aberta' ? 'Nenhuma conversa atribuída a você.' : 'Nenhum atendimento concluído.')
                  : scope === 'fila' ? 'Fila vazia. Toda conversa tem atendente.'
                  : 'Nenhuma conversa ainda.'
              }
            />
          ) : (
            conversations.map((c) => {
              const name = conversationName(c)
              const s = c.session_id ? sessions.get(c.session_id) : undefined
              return (
                <button
                  key={c.id}
                  className={`at-item${c.id === selectedId ? ' active' : ''}`}
                  onClick={() => open(c)}
                >
                  <ClientAvatar conv={c} name={name} />
                  <span className="at-item-main">
                    <span className="at-item-top">
                      <span className="at-item-name">{name}</span>
                      <span className={`at-item-time${c.unread_count > 0 ? ' unread' : ''}`}>
                        {formatListTime(c.last_message_at)}
                      </span>
                    </span>
                    <span className="at-item-bottom">
                      <span className="at-item-preview">
                        {c.last_message_from_me ? 'Você: ' : ''}{c.last_message_preview ?? ''}
                      </span>
                      {c.unread_count > 0 && <span className="at-unread">{c.unread_count > 99 ? '99+' : c.unread_count}</span>}
                    </span>
                    {veTudo && (
                      <span className="at-item-meta">
                        <span className={c.assigned_to ? '' : 'at-no-agent'}>
                          {c.assigned_to ? names.get(c.assigned_to) ?? 'Atendente' : 'Sem atendente'}
                        </span>
                        {sessions.size > 1 && <span> · {sessionLabel(s)}</span>}
                      </span>
                    )}
                  </span>
                </button>
              )
            })
          )}
        </div>
      </aside>

      <section className="at-thread-area">
        {selected ? (
          <ChatThread
            key={selected.id}
            conversation={selected}
            session={selected.session_id ? sessions.get(selected.session_id) : undefined}
            names={names}
            attendants={attendants}
            canAssign={podeAtribuir}
            canTransfer={podeTransferir}
            canTake={veTudo}
            conclusionReasons={conclusionReasons}
            onBack={() => { setSelectedId(null); setSelectedSnapshot(null) }}
            onChanged={load}
            onOpenContact={onOpenContact}
          />
        ) : (
          <div className="at-thread-empty">
            <EmptyState icon={<MessageCircle />} text="Escolha uma conversa para responder." />
          </div>
        )}
      </section>

      {showNumeros && (
        <NumerosAtendimento
          onClose={() => setShowNumeros(false)}
          onChanged={loadSessions}
        />
      )}
    </div>
  )
}
