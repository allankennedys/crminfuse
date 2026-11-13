import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Search, ArrowLeft, X, CalendarDays } from 'lucide-react'
import type { Group, QueueStatus, SessionStatus, LogStatus, ScheduleStatus, QueuePriority, WhatsAppSession } from '@/types'

// Pilha dos popups abertos: o Esc fecha só o de cima (há popup dentro de popup).
const popupStack: symbol[] = []

export function Modal({ title, onClose, children, variant = 'page', wide = false, small = false }: {
  title: string
  onClose: () => void
  children: ReactNode
  /**
   * 'page' (padrão): tela cheia que rola naturalmente. Para conteúdo longo
   * (matriz de permissões, visualizador de arquivo).
   *
   * 'dialog': popup centralizado, para formulário e confirmação curtos. A
   * caixa tem teto de altura (dvh) e rola por dentro, ancora no topo quando
   * não cabe e vira quase tela cheia no celular, então não some nem estoura
   * a viewport. Fecha no X e no Esc (só o de cima, se houver mais de um); o
   * clique no fundo só fecha o `small` (confirmação), para não perder um
   * formulário preenchido por um clique errado.
   */
  variant?: 'page' | 'dialog'
  /**
   * Solta o teto de 600px do corpo. Existe para o conteúdo que é de fato em
   * duas colunas — formulário e prévia lado a lado. Dentro dos 600px padrão,
   * a segunda coluna espreme a primeira até o formulário virar uma tira.
   */
  wide?: boolean
  /** Popup estreito, para confirmação (só no variant 'dialog'). */
  small?: boolean
}) {
  const isDialog = variant === 'dialog'
  useEffect(() => {
    if (!isDialog) return
    const id = Symbol('popup')
    popupStack.push(id)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && popupStack[popupStack.length - 1] === id) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      const i = popupStack.indexOf(id)
      if (i >= 0) popupStack.splice(i, 1)
    }
    // onClose costuma ser uma função nova a cada render; só a abertura conta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDialog])

  if (isDialog) {
    // Portal no body: garante centralização na viewport, imune a transform/filter de ancestrais
    return createPortal(
      <div className="modal-overlay" onClick={(e) => small && e.target === e.currentTarget && onClose()}>
        <div
          className={`modal${wide ? ' modal-wide' : small ? ' modal-small' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label={title}
        >
          <div className="modal-head">
            <h2 className="modal-title">{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label="Fechar"><X size={17} /></button>
          </div>
          {children}
        </div>
      </div>,
      document.body,
    )
  }
  // Página de tela cheia: coluna flex com corpo rolável — sem caixa flutuante,
  // então não há como o conteúdo estourar/sumir fora da viewport.
  return createPortal(
    <div className="modal-page">
      <header className="modal-page-bar">
        <button className="modal-back" onClick={onClose} aria-label="Voltar">
          <ArrowLeft size={17} /> Voltar
        </button>
        <h2 className="modal-page-title">{title}</h2>
      </header>
      <div className="modal-page-body">
        <div className={`modal-page-content${wide ? ' modal-page-content-wide' : ''}`}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}

const isoParaBR = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ''
}

/** "dd/mm/aaaa" completo e existente no calendário → "aaaa-mm-dd"; senão ''. */
function brParaISO(br: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(br)
  if (!m) return ''
  const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3])
  const t = new Date(Date.UTC(y, mo - 1, d))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return ''
  return `${m[3]}-${m[2]}-${m[1]}`
}

/**
 * Campo de data SEMPRE em dia/mês/ano. O <input type="date"> nativo mostra
 * no formato do navegador de quem abre (mm/dd/aaaa num Chrome em inglês), e
 * a página não tem como mudar isso. Aqui o texto é digitado com máscara
 * (dd/mm/aaaa) e o calendário nativo fica só como seletor, pelo botão.
 *
 * `value` e `onChange` usam "aaaa-mm-dd" (o mesmo do input nativo). Só emite
 * data completa e válida (dentro de min/max); apagar tudo emite ''.
 */
export function DateInput({ value, onChange, min, max, id, className = 'input', disabled, ariaLabel }: {
  value: string
  onChange: (iso: string) => void
  min?: string
  max?: string
  id?: string
  className?: string
  disabled?: boolean
  ariaLabel?: string
}) {
  const [draft, setDraft] = useState(isoParaBR(value))
  const nativo = useRef<HTMLInputElement>(null)

  // O pai mudou o valor (ex.: pelo calendário ou ao abrir outro registro).
  useEffect(() => {
    setDraft((cur) => (brParaISO(cur) === value ? cur : isoParaBR(value)))
  }, [value])

  const dentro = (iso: string) => (!min || iso >= min) && (!max || iso <= max)

  const digitar = (raw: string) => {
    const d = raw.replace(/\D/g, '').slice(0, 8)
    const masked = d.length > 4 ? `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`
      : d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d
    setDraft(masked)
    if (!masked) return onChange('')
    const iso = brParaISO(masked)
    if (iso && dentro(iso)) onChange(iso)
  }

  const invalida = draft.length === 10 && (!brParaISO(draft) || !dentro(brParaISO(draft)))

  return (
    <div className="date-input" style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <input
        id={id}
        className={className}
        inputMode="numeric"
        autoComplete="off"
        placeholder="dd/mm/aaaa"
        maxLength={10}
        value={draft}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalida || undefined}
        style={{ paddingRight: 34, ...(invalida ? { borderColor: 'var(--danger)' } : {}) }}
        onChange={(e) => digitar(e.target.value)}
        onBlur={() => { if (invalida || draft.length < 10) setDraft(isoParaBR(value)) }}
      />
      <button
        type="button"
        className="icon-btn"
        style={{ position: 'absolute', right: 4 }}
        disabled={disabled}
        aria-label="Abrir calendário"
        onClick={() => { const el = nativo.current; if (el?.showPicker) el.showPicker(); else el?.click() }}
      >
        <CalendarDays size={15} />
      </button>
      <input
        ref={nativo}
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        value={value}
        min={min}
        max={max}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        style={{ position: 'absolute', right: 4, bottom: 0, width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
      />
    </div>
  )
}

export function Loader() {
  return <div className="center-loader"><div className="spinner lg" /></div>
}

export function EmptyState({ icon, text }: { icon: ReactNode; text: string }) {
  return <div className="empty-state">{icon}<p>{text}</p></div>
}

const STATUS_STYLES: Record<string, { cls: string; label: string }> = {
  connected: { cls: 'badge-green', label: 'Conectado' },
  connecting: { cls: 'badge-yellow', label: 'Conectando' },
  disconnected: { cls: 'badge-gray', label: 'Desconectado' },
  error: { cls: 'badge-red', label: 'Erro' },
  pending: { cls: 'badge-blue', label: 'Aguardando' },
  processing: { cls: 'badge-yellow', label: 'Enviando' },
  sent: { cls: 'badge-green', label: 'Enviado' },
  failed: { cls: 'badge-red', label: 'Falhou' },
  cancelled: { cls: 'badge-gray', label: 'Cancelado' },
  queued: { cls: 'badge-blue', label: 'Aguardando' },
  retrying: { cls: 'badge-yellow', label: 'Reenviando' },
  scheduled: { cls: 'badge-blue', label: 'Agendado' },
  executed: { cls: 'badge-green', label: 'Executado' },
  urgent: { cls: 'badge-red', label: 'Urgente' },
  normal: { cls: 'badge-gray', label: 'Normal' },
  low: { cls: 'badge-gray', label: 'Baixa' },
}

export function StatusBadge({ status, pulse }: {
  status: QueueStatus | SessionStatus | LogStatus | ScheduleStatus | QueuePriority
  pulse?: boolean
}) {
  const s = STATUS_STYLES[status] ?? { cls: 'badge-gray', label: status }
  return (
    <span className={`badge ${s.cls}`}>
      {pulse && <span className="dot" />}
      {s.label}
    </span>
  )
}

/**
 * Seletor de grupos de destino com busca. Preserva seleções fora do filtro
 * atual — "Selecionar todos/Limpar" age apenas sobre os grupos visíveis.
 */
export function GroupPicker({ groups, selected, onChange }: {
  groups: Group[]
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? groups.filter((g) => g.name.toLowerCase().includes(q)) : groups
  }, [groups, query])

  const filteredIds = filtered.map((g) => g.id)
  const allFilteredSelected =
    filteredIds.length > 0 && filteredIds.every((id) => selected.includes(id))

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id])
  }

  function toggleAllFiltered() {
    if (allFilteredSelected) {
      onChange(selected.filter((id) => !filteredIds.includes(id)))
    } else {
      onChange([...new Set([...selected, ...filteredIds])])
    }
  }

  return (
    <div className="field">
      <div className="flex-between">
        <label>Grupos de destino ({selected.length})</label>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={toggleAllFiltered}
          disabled={filtered.length === 0}
        >
          {allFilteredSelected ? 'Limpar' : 'Selecionar todos'}
        </button>
      </div>
      {groups.length === 0 ? (
        <p className="text-muted" style={{ fontSize: 12 }}>Nenhum grupo ativo. Cadastre em Grupos.</p>
      ) : (
        <>
          <div className="search-field" style={{ marginBottom: 8 }}>
            <input
              className="input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Pesquisar entre ${groups.length} grupo(s)…`}
            />
            <Search />
          </div>
          {filtered.length === 0 ? (
            <p className="text-muted" style={{ fontSize: 12 }}>Nenhum grupo encontrado para “{query}”.</p>
          ) : (
            <div className="flex" style={{ flexWrap: 'wrap', gap: 6, maxHeight: 140, overflowY: 'auto' }}>
              {filtered.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  className={`btn btn-sm ${selected.includes(g.id) ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => toggle(g.id)}
                >
                  {g.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * Nome legível de um número. O nome da instância é gerado pelo sistema
 * (117), então quem o usuário reconhece é o telefone; sem ele (QR ainda não
 * lido), o nome técnico.
 */
export function sessionLabel(s: Pick<WhatsAppSession, 'instance_name' | 'phone_number'>): string {
  if (!s.phone_number) return `Aguardando conexão (${s.instance_name})`
  const d = s.phone_number.replace(/\D/g, '')
  const br = d.match(/^55(\d{2})(\d{4,5})(\d{4})$/)
  return br ? `+55 (${br[1]}) ${br[2]}-${br[3]}` : `+${d}`
}

/**
 * Escolha do número de origem do envio. `null` = automático: o worker
 * distribui entre os números conectados vinculados ao grupo.
 *
 * Um número escolhido explicitamente é respeitado — se estiver desconectado
 * na hora do envio, a mensagem falha em vez de sair por outro número. Por isso
 * o aviso quando a escolha está offline agora.
 */
export function SessionPicker({ sessions, value, onChange }: {
  sessions: WhatsAppSession[]
  value: string | null
  onChange: (id: string | null) => void
}) {
  const chosen = sessions.find((s) => s.id === value) ?? null

  return (
    <div className="field">
      <label>Enviar pelo número</label>
      {sessions.length === 0 ? (
        <p className="text-muted" style={{ fontSize: 12 }}>Nenhum número cadastrado. Conecte em Números.</p>
      ) : (
        <>
          <select
            className="input"
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value || null)}
          >
            <option value="">Automático: distribui entre os conectados</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {sessionLabel(s)}{s.status === 'connected' ? '' : ' (desconectado)'}
              </option>
            ))}
          </select>
          {chosen && chosen.status !== 'connected' && (
            <span style={{ fontSize: 12, color: 'var(--warning)' }}>
              Esse número está desconectado. Se continuar assim na hora do envio, a mensagem falha e
              não será enviada por outro número.
            </span>
          )}
        </>
      )}
    </div>
  )
}
