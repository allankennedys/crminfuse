import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Plus } from 'lucide-react'

/** Compara ignorando caixa e acento — mesma regra do agrupamento no banco (038). */
export function normalizeOption(s: string): string {
  return s.trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
}

export interface ComboOption {
  value: string
  /** Texto discreto à direita (ex.: quantos contatos usam esta origem). */
  hint?: string
}

/**
 * Lista ancorada ao campo: mesma largura, colada logo abaixo dele — e acima
 * quando falta espaço na tela.
 *
 * Fica num portal no body de propósito. Dentro da árvore ela seria recortada
 * pelo `.drawer-body`, que rola: um campo perto do fim do painel abriria a
 * lista atrás da borda. `position: fixed` só se ancora na viewport fora de
 * ancestrais com transform/filter — o mesmo motivo que levou o drawer e o
 * Modal ao portal.
 */
function sameStyle(a: CSSProperties, b: CSSProperties): boolean {
  const keys: Array<keyof CSSProperties> = ['left', 'width', 'top', 'bottom', 'maxHeight']
  return keys.every((k) => a[k] === b[k])
}

function AnchoredList({ anchor, onDismiss, children }: {
  anchor: HTMLElement | null
  onDismiss: () => void
  children: ReactNode
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties | null>(null)

  const place = useCallback(() => {
    if (!anchor) return
    const r = anchor.getBoundingClientRect()
    const below = window.innerHeight - r.bottom
    const above = r.top
    // Abre para cima só quando embaixo não cabe uma lista mínima e em cima
    // sobra mais espaço — senão a lista pularia de lado a cada rolagem.
    const up = below < 160 && above > below
    const next: CSSProperties = {
      left: r.left,
      width: r.width,
      ...(up
        ? { bottom: window.innerHeight - r.top + 5, maxHeight: Math.min(260, above - 12) }
        : { top: r.bottom + 5, maxHeight: Math.min(260, below - 12) }),
    }
    // Só re-renderiza quando a posição muda de verdade: o loop abaixo roda a
    // cada quadro e sem isso seria um setState por quadro.
    setStyle((cur) => (cur && sameStyle(cur, next) ? cur : next))
  }, [anchor])

  useLayoutEffect(place, [place])

  /**
   * Reposiciona a cada quadro enquanto a lista está aberta.
   *
   * Ouvir só scroll/resize não basta: o campo também se move por animação
   * (o drawer entra deslizando) e por mudança de layout — medir uma vez, no
   * meio da animação de entrada, deixava a lista ancorada onde o campo
   * ESTAVA, fora da tela. rAF custa nada aqui: a lista vive alguns segundos.
   */
  useEffect(() => {
    let raf = 0
    const tick = () => { place(); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    // Rolagem (em qualquer container, por isso captura) e resize também
    // avisam direto: são os casos comuns e não dependem de haver quadro
    // sendo desenhado.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [place])

  // Clique fora fecha. `mousedown` e não `click`: o clique numa opção começa
  // com o mousedown dela, que já está dentro da lista.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (listRef.current?.contains(t) || anchor?.contains(t)) return
      onDismiss()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [anchor, onDismiss])

  if (!style) return null
  return createPortal(
    <div className="combo-list" ref={listRef} style={style} role="listbox">{children}</div>,
    document.body,
  )
}

/**
 * Campo de texto com lista de opções já usadas — o substituto do `datalist`,
 * que o navegador desenhava como um balão fora de alinhamento e sem estilo.
 *
 * Continua sendo TEXTO LIVRE: a lista sugere, não restringe. O que não está
 * nela aparece como "Criar" e é gravado igual ao que foi escolhido.
 */
export function Combobox({ value, onChange, options, placeholder, ariaLabel, createLabel = 'Criar', autoFocus = false }: {
  value: string
  onChange: (value: string) => void
  options: ComboOption[]
  placeholder?: string
  ariaLabel?: string
  createLabel?: string
  /**
   * Foca o campo ao montar — e, como o foco abre a lista, as opções já
   * aparecem sem o usuário clicar. Para a tela em que escolher da lista É a
   * tarefa, não um detalhe de um formulário maior.
   */
  autoFocus?: boolean
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  // Filtrar só depois de digitar: abrir pela seta (ou com um valor já
  // escolhido) mostra a lista inteira, senão a única opção visível seria a
  // que já está no campo.
  const [typing, setTyping] = useState(false)
  const [active, setActive] = useState(-1)

  const query = normalizeOption(value)
  const filtered = useMemo(
    () => (typing && query ? options.filter((o) => normalizeOption(o.value).includes(query)) : options),
    [options, query, typing],
  )
  const exact = options.some((o) => normalizeOption(o.value) === query)
  const canCreate = value.trim() !== '' && !exact
  const rows = filtered.length + (canCreate ? 1 : 0)

  /**
   * Abertura automática, quando escolher da lista É a tarefa da tela.
   *
   * Em efeito, e não pelo atributo `autoFocus` do input: aquele foca durante
   * o commit e a lista dependia do evento de foco chegar ao onFocus para
   * abrir — o que não acontecia dentro do modal. Aqui o efeito roda depois
   * de as refs estarem atribuídas, então a AnchoredList encontra o campo
   * para se ancorar. Sem âncora ela mede null, `place()` desiste e o
   * componente devolve null: a lista existiria sem nunca aparecer.
   */
  useEffect(() => {
    if (!autoFocus) return
    inputRef.current?.focus()
    setOpen(true)
  }, [autoFocus])

  useEffect(() => { if (!open) setActive(-1) }, [open])
  // A lista encolhe ao digitar: sem isso o destaque ficaria fora dela.
  useEffect(() => { setActive((i) => (i >= rows ? rows - 1 : i)) }, [rows])

  function choose(v: string) {
    onChange(v)
    setTyping(false)
    setOpen(false)
    inputRef.current?.focus()
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) { setOpen(true); return }
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (rows === 0 ? -1 : (i + step + rows) % rows))
    } else if (e.key === 'Enter') {
      if (!open || active < 0) return
      e.preventDefault()
      // Última linha com "Criar" disponível é a de criar o valor digitado.
      choose(active < filtered.length ? filtered[active].value : value.trim())
    } else if (e.key === 'Escape' && open) {
      // Sem parar aqui, o Esc chegaria ao listener do drawer e fecharia o
      // painel inteiro — quem aperta Esc com a lista aberta quer fechar a lista.
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div className="combo" ref={wrapRef}>
      <input
        ref={inputRef}
        className="input combo-input"
        value={value}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); setTyping(true); setOpen(true); setActive(-1) }}
        onFocus={() => setOpen(true)}
        // Também no clique: depois de escolher (ou de fechar com Esc) o campo
        // continua focado, então o `focus` não dispararia de novo.
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className={`combo-toggle${open ? ' open' : ''}`}
        tabIndex={-1}
        aria-label={open ? 'Fechar lista' : 'Abrir lista'}
        // O mousedown padrão tiraria o foco do campo e o blur fecharia a
        // lista antes do clique virar toggle.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { setTyping(false); setOpen((o) => !o); inputRef.current?.focus() }}
      >
        <ChevronDown size={15} />
      </button>

      {open && (
        <AnchoredList anchor={wrapRef.current} onDismiss={() => setOpen(false)}>
          {filtered.map((o, i) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={normalizeOption(o.value) === query}
              className={`combo-option${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(o.value)}
            >
              <span className="combo-option-label">{o.value}</span>
              {o.hint && <span className="combo-option-hint">{o.hint}</span>}
              {normalizeOption(o.value) === query && <Check size={13} className="combo-option-check" />}
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
              onClick={() => choose(value.trim())}
            >
              <Plus size={13} />
              <span className="combo-option-label">{createLabel} “{value.trim()}”</span>
            </button>
          )}

          {rows === 0 && (
            <p className="combo-empty">Nada registrado ainda. Digite para criar.</p>
          )}
        </AnchoredList>
      )}
    </div>
  )
}

export { AnchoredList }
