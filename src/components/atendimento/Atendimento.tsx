import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { ListFilter, MessageCircle, MessageCirclePlus, Search, Smartphone, X as XIcon } from 'lucide-react'
import { useConversaStore } from '@/store/conversaStore'
import { supabase } from '@/lib/supabase'
import { useAuthStore, useCan } from '@/store/authStore'
import { DateInput, EmptyState, Loader } from '@/components/ui'
import { toast } from '@/store/toastStore'
import {
  atendimentoService, conversationName, sessionLabel, LIST_PAGE, type WaListFilters, type WaScope,
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
  const [tagFiltro, setTagFiltro] = useState('')
  const [compra, setCompra] = useState<'' | 'com' | 'sem'>('')
  const [anuncio, setAnuncio] = useState<'' | 'sim' | 'nao'>('')
  const [dataTipo, setDataTipo] = useState<'abertura' | 'conclusao' | 'interacao'>('interacao')
  const [dataDe, setDataDe] = useState('')
  const [dataAte, setDataAte] = useState('')
  const [filtrosAbertos, setFiltrosAbertos] = useState(false)
  const filtrosRef = useRef<HTMLDivElement>(null)
  const [tagOptions, setTagOptions] = useState<string[]>([])
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
    atendimentoService.tagOptions().then(setTagOptions)
    atendimentoService.userNames().then(setNames).catch(() => {})
    if (podeAtribuir || verTodas || podeTransferir) atendimentoService.attendants().then(setAttendants).catch(() => setAttendants([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissions])

  const selectedIdRef = useRef<string | null>(null)
  selectedIdRef.current = selectedId

  // Cache por filtro: trocar de aba mostra na hora o que já foi visto e
  // atualiza por baixo, em vez de esperar a rede com a lista antiga na tela.
  const cacheRef = useRef<Map<string, { items: WaConversation[]; more: boolean }>>(new Map())
  const keyRef = useRef('')
  const filtroKey = `${scope}|${status}|${scope === 'todas' ? assignee : ''}|${debouncedSearch}|${tagFiltro}|${compra}|${anuncio}|${dataDe || dataAte ? `${dataTipo}:${dataDe}:${dataAte}` : ''}`
  keyRef.current = filtroKey
  useLayoutEffect(() => {
    const cached = cacheRef.current.get(filtroKey)
    setHasMore(cached?.more ?? false)
    setConversations(cached ? cached.items : null)
  }, [filtroKey])

  // Lista paginada: a primeira página é recarregada a cada evento, as
  // seguintes só quando a pessoa rola até o fim.
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const convRef = useRef<WaConversation[] | null>(null)
  convRef.current = conversations
  const hasMoreRef = useRef(false)
  hasMoreRef.current = hasMore
  const loadingMoreRef = useRef(false)
  const filtros = useCallback((): WaListFilters => ({
    scope, status, userId, assignee: scope === 'todas' ? assignee || undefined : undefined, search: debouncedSearch,
    tags: tagFiltro ? [tagFiltro] : undefined, compra: compra || undefined, anuncio: anuncio || undefined,
    data: dataDe || dataAte ? { tipo: dataTipo, de: dataDe || undefined, ate: dataAte || undefined } : undefined,
  }), [scope, status, userId, assignee, debouncedSearch, tagFiltro, compra, anuncio, dataDe, dataAte, dataTipo])

  const load = useCallback(async () => {
    if (!userId) return
    const key = filtroKey
    try {
      if (veTudo) atendimentoService.queueCount().then(setQueueCount)
      else setQueueCount(0)
      const first = await atendimentoService.listConversations(filtros(), 0, LIST_PAGE)
      // Páginas já carregadas além da primeira continuam; o que subiu para a
      // primeira sai do resto (sem duplicar).
      const prev = keyRef.current === key ? convRef.current : cacheRef.current.get(key)?.items ?? null
      const ids = new Set(first.map((c) => c.id))
      const tail = (prev ?? []).slice(LIST_PAGE).filter((c) => !ids.has(c.id))
      const list = [...first, ...tail]
      const more = tail.length > 0 ? (keyRef.current === key ? hasMoreRef.current : cacheRef.current.get(key)?.more ?? false) : first.length === LIST_PAGE
      cacheRef.current.set(key, { items: list, more })
      if (keyRef.current !== key) return // trocou de aba enquanto buscava
      setConversations(list)
      setHasMore(more)

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
  }, [userId, veTudo, filtroKey, filtros])

  useEffect(() => { load() }, [load])

  const loadMore = useCallback(async () => {
    const atual = convRef.current
    if (!atual || !hasMoreRef.current || loadingMoreRef.current) return
    const key = keyRef.current
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const page = await atendimentoService.listConversations(filtros(), atual.length, LIST_PAGE)
      if (keyRef.current !== key) return
      const have = new Set((convRef.current ?? []).map((c) => c.id))
      const items = [...(convRef.current ?? []), ...page.filter((c) => !have.has(c.id))]
      const more = page.length === LIST_PAGE
      cacheRef.current.set(key, { items, more })
      setConversations(items)
      setHasMore(more)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao carregar mais conversas')
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }, [filtros])

  const onListScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) loadMore()
  }

  // Aquece as outras abas: a primeira troca também já é instantânea.
  useEffect(() => {
    if (!userId || debouncedSearch || tagFiltro || compra || anuncio || dataDe || dataAte) return
    const outras = (['minhas', 'fila', 'todas'] as WaScope[]).filter((sc) => sc !== scope && (veTudo || sc === 'minhas'))
    outras.forEach((sc) => {
      const k = `${sc}|${status}||||||`
      atendimentoService.listConversations({ scope: sc, status, userId, search: '' }, 0, LIST_PAGE)
        .then((l) => { cacheRef.current.set(k, { items: l, more: l.length === LIST_PAGE }) })
        .catch(() => {})
    })
  }, [userId, status, veTudo, debouncedSearch, scope, tagFiltro, compra, anuncio, dataDe, dataAte])

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

  const filtrosAtivos = [tagFiltro, compra, anuncio, dataDe || dataAte, scope === 'todas' ? assignee : ''].filter(Boolean).length

  // Fecha o painel de filtros ao clicar fora ou com Esc.
  useEffect(() => {
    if (!filtrosAbertos) return
    const fora = (e: MouseEvent) => {
      if (filtrosRef.current && !filtrosRef.current.contains(e.target as Node)) setFiltrosAbertos(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setFiltrosAbertos(false) }
    document.addEventListener('mousedown', fora)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', fora); document.removeEventListener('keydown', esc) }
  }, [filtrosAbertos])

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

          <div className="at-filters" ref={filtrosRef}>
            <label className="channel-filter">
              <select value={status} onChange={(e) => setStatus(e.target.value as WaConversationStatus)} aria-label="Situação">
                <option value="aberta">Em aberto</option>
                <option value="resolvida">Concluídas</option>
              </select>
            </label>
            <button
              type="button"
              className={`channel-filter at-filter-btn${filtrosAtivos ? ' active' : ''}`}
              onClick={() => setFiltrosAbertos((v) => !v)}
              aria-expanded={filtrosAbertos}
              aria-haspopup="true"
            >
              <ListFilter size={14} /> Filtros
              {filtrosAtivos > 0 && <span className="at-seg-count">{filtrosAtivos}</span>}
            </button>
            {filtrosAbertos && (
              <div className="at-filter-pop" role="group" aria-label="Filtros">
                {tagOptions.length > 0 && (
                  <div className="field">
                    <label htmlFor="f-etiqueta">Etiqueta</label>
                    <select id="f-etiqueta" className="input" value={tagFiltro} onChange={(e) => setTagFiltro(e.target.value)}>
                      <option value="">Todas</option>
                      {tagOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                )}
                <div className="field">
                  <label htmlFor="f-compra">Compras</label>
                  <select id="f-compra" className="input" value={compra} onChange={(e) => setCompra(e.target.value as '' | 'com' | 'sem')}>
                    <option value="">Com ou sem compra</option>
                    <option value="com">Com compra</option>
                    <option value="sem">Sem compra</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="f-anuncio">Origem</label>
                  <select id="f-anuncio" className="input" value={anuncio} onChange={(e) => setAnuncio(e.target.value as '' | 'sim' | 'nao')}>
                    <option value="">Qualquer origem</option>
                    <option value="sim">Veio de anúncio</option>
                    <option value="nao">Não veio de anúncio</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="f-data-tipo">Data do atendimento</label>
                  <select id="f-data-tipo" className="input" value={dataTipo} onChange={(e) => setDataTipo(e.target.value as 'abertura' | 'conclusao' | 'interacao')}>
                    <option value="interacao">Última interação</option>
                    <option value="abertura">Abertura</option>
                    <option value="conclusao">Conclusão</option>
                  </select>
                  <div className="at-filter-dates">
                    <DateInput value={dataDe} max={dataAte || undefined} onChange={setDataDe} ariaLabel="Data inicial" />
                    <span className="text-muted">até</span>
                    <DateInput value={dataAte} min={dataDe || undefined} onChange={setDataAte} ariaLabel="Data final" />
                  </div>
                  {dataTipo === 'conclusao' && status === 'aberta' && (dataDe || dataAte) && (
                    <span className="text-muted" style={{ fontSize: 11 }}>
                      Atendimento concluído aparece em "Concluídas": troque a situação acima.
                    </span>
                  )}
                </div>
                {veTudo && scope === 'todas' && attendants.length > 0 && (
                  <div className="field">
                    <label htmlFor="f-atendente">Atendente</label>
                    <select id="f-atendente" className="input" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                      <option value="">Todos os atendentes</option>
                      {attendants.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                )}
                {filtrosAtivos > 0 && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => { setTagFiltro(''); setCompra(''); setAnuncio(''); setAssignee(''); setDataDe(''); setDataAte('') }}
                  >
                    Limpar filtros
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="at-list-items" onScroll={onListScroll}>
          {conversations === null ? (
            <Loader />
          ) : conversations.length === 0 ? (
            <EmptyState
              icon={<MessageCircle />}
              text={
                (debouncedSearch || tagFiltro || compra || anuncio || dataDe || dataAte) ? 'Nenhuma conversa encontrada.'
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
          {conversations && conversations.length > 0 && hasMore && (
            <div className="at-list-more">
              {loadingMore ? <span className="spinner" /> : (
                <button type="button" className="btn btn-ghost btn-sm" onClick={loadMore}>Carregar mais</button>
              )}
            </div>
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
