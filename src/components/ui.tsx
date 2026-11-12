import { useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Search, ArrowLeft } from 'lucide-react'
import type { Group, QueueStatus, SessionStatus, LogStatus, ScheduleStatus, QueuePriority, WhatsAppSession } from '@/types'

export function Modal({ title, onClose, children, variant = 'page', wide = false }: {
  title: string
  onClose: () => void
  children: ReactNode
  /**
   * 'page' (padrão): tela cheia que rola naturalmente, imune aos bugs de
   * centralização.
   *
   * 'dialog' (caixa flutuante centralizada) NÃO É USADO POR NINGUÉM. As três
   * últimas telas que o usavam — confirmação, comprovante e escolha de número
   * — viraram página, porque a caixa flutuante dá problema em parte dos
   * dispositivos e a régua do projeto passou a ser página sempre, inclusive
   * para conteúdo curto. O branch continua aqui só para não quebrar código
   * que ainda passe a prop; antes de usá-lo, releia este parágrafo.
   */
  variant?: 'page' | 'dialog'
  /**
   * Solta o teto de 600px do corpo. Existe para o conteúdo que é de fato em
   * duas colunas — formulário e prévia lado a lado. Dentro dos 600px padrão,
   * a segunda coluna espreme a primeira até o formulário virar uma tira.
   * Só no variant 'page'.
   */
  wide?: boolean
}) {
  if (variant === 'dialog') {
    // Portal no body: garante centralização na viewport, imune a transform/filter de ancestrais
    return createPortal(
      <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal">
          <h2 className="modal-title">{title}</h2>
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

/** Nome legível de um número: "instância · telefone" quando o telefone é conhecido. */
export function sessionLabel(s: WhatsAppSession): string {
  return s.phone_number ? `${s.instance_name} · ${s.phone_number}` : s.instance_name
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
            <option value="">Automático — distribui entre os conectados</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {sessionLabel(s)}{s.status === 'connected' ? '' : ' (desconectado)'}
              </option>
            ))}
          </select>
          {chosen && chosen.status !== 'connected' && (
            <span style={{ fontSize: 12, color: 'var(--warning)' }}>
              Esse número está desconectado. Se continuar assim na hora do envio, a mensagem falha —
              não será enviada por outro número.
            </span>
          )}
        </>
      )}
    </div>
  )
}
