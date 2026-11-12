import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Plus, X } from 'lucide-react'
import { AnchoredList, normalizeOption } from './Combobox'

/**
 * Entrada de etiquetas: digite e confirme com Enter, vírgula ou Tab.
 * Backspace no campo vazio remove a última — atalho esperado neste tipo de campo.
 *
 * Com `suggestions`, o campo também vira lista: as etiquetas já usadas na
 * organização aparecem ancoradas ao campo e entram com um clique. Escolher da
 * lista em vez de redigitar é o que evita "vip" e "VIP" convivendo como
 * etiquetas diferentes na base.
 */
export function TagInput({ value, onChange, suggestions = [], placeholder = 'Adicionar etiqueta…' }: {
  value: string[]
  onChange: (tags: string[]) => void
  /** Etiquetas já existentes, para escolher em vez de redigitar. */
  suggestions?: string[]
  placeholder?: string
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)

  const query = normalizeOption(draft)
  // Já escolhidas saem da lista: repetir uma etiqueta do contato não faz nada.
  const available = useMemo(
    () => suggestions.filter((s) => !value.some((t) => normalizeOption(t) === normalizeOption(s))),
    [suggestions, value],
  )
  const filtered = useMemo(
    () => (query ? available.filter((s) => normalizeOption(s).includes(query)) : available),
    [available, query],
  )
  const exists = [...value, ...suggestions].some((t) => normalizeOption(t) === query)
  const canCreate = draft.trim() !== '' && !exists
  const rows = filtered.length + (canCreate ? 1 : 0)

  useEffect(() => { if (!open) setActive(-1) }, [open])
  useEffect(() => { setActive((i) => (i >= rows ? rows - 1 : i)) }, [rows])

  function commit(raw: string) {
    const tag = raw.trim().replace(/,+$/, '')
    setDraft('')
    if (!tag) return
    // Sem duplicar ignorando caixa: "VIP" e "vip" são a mesma etiqueta.
    if (!value.some((t) => normalizeOption(t) === normalizeOption(tag))) onChange([...value, tag])
    // Sem focar o campo aqui: `commit` também roda ao clicar FORA (a lista
    // confirma o que estava digitado antes de fechar), e devolver o foco
    // roubaria o clique do campo de destino — e reabriria a lista logo em
    // seguida, pelo onFocus. Quem escolhe da lista nunca perdeu o foco:
    // as opções cancelam o mousedown.
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) { setOpen(true); return }
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (rows === 0 ? -1 : (i + step + rows) % rows))
    } else if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      // Com uma opção destacada, Enter escolhe ela; senão confirma o texto.
      if (open && active >= 0 && active < filtered.length && e.key !== 'Tab') {
        e.preventDefault()
        commit(filtered[active])
        return
      }
      if (!draft.trim()) return
      e.preventDefault()
      commit(draft)
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1))
    } else if (e.key === 'Escape' && open) {
      // Não deixa o Esc subir e fechar o drawer inteiro.
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div className="combo">
      <div
        className="tag-input"
        ref={wrapRef}
        // Clicar em qualquer ponto da caixa foca o campo e reabre a lista —
        // com o campo já focado, o `focus` não dispararia sozinho.
        onClick={() => { inputRef.current?.focus(); setOpen(true) }}
      >
        {value.map((tag) => (
          <span key={tag} className="tag-chip">
            {tag}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onChange(value.filter((t) => t !== tag)) }}
              aria-label={`Remover ${tag}`}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setOpen(true); setActive(-1) }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={value.length ? 'Adicionar…' : placeholder}
        />
      </div>

      {open && rows > 0 && (
        <AnchoredList anchor={wrapRef.current} onDismiss={() => { setOpen(false); commit(draft) }}>
          {filtered.map((s, i) => (
            <button
              key={s}
              type="button"
              role="option"
              aria-selected={false}
              className={`combo-option${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commit(s)}
            >
              <span className="tag-chip tag-chip-sm">{s}</span>
            </button>
          ))}
          {canCreate && (
            <button
              type="button"
              role="option"
              aria-selected={false}
              className={`combo-option combo-option-create${active === filtered.length ? ' active' : ''}`}
              onMouseEnter={() => setActive(filtered.length)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commit(draft)}
            >
              <Plus size={13} />
              <span className="combo-option-label">Criar “{draft.trim()}”</span>
            </button>
          )}
        </AnchoredList>
      )}
    </div>
  )
}

/** Etiquetas em modo leitura (card e tabela). */
export function TagList({ tags, max = 3 }: { tags: string[]; max?: number }) {
  if (!tags.length) return <span className="text-muted" style={{ fontSize: 12 }}>—</span>
  const shown = tags.slice(0, max)
  const rest = tags.length - shown.length
  return (
    <span className="tag-list">
      {shown.map((tag) => <span key={tag} className="tag-chip tag-chip-sm">{tag}</span>)}
      {rest > 0 && <span className="tag-chip tag-chip-more tag-chip-sm">+{rest}</span>}
    </span>
  )
}
