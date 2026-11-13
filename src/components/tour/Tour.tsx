import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TOUR_ADMIN, TOUR_ATENDENTE, type PassoTour } from './steps'

interface Retangulo { top: number; left: number; width: number; height: number }

const mudou = (a: Retangulo | null, b: Retangulo | null) =>
  !a || !b || Math.abs(a.top - b.top) > 0.5 || Math.abs(a.left - b.left) > 0.5
    || Math.abs(a.width - b.width) > 0.5 || Math.abs(a.height - b.height) > 0.5

/**
 * Tour de boas-vindas (151): destaca partes da tela, passo a passo. Pode ser
 * pulada a qualquer momento (botão, Esc ou clicar fora). O conteúdo muda com o
 * tipo de usuário: administrador ou atendente. Passo que pede uma aba que a
 * pessoa não tem é descartado; passo sem elemento na tela aparece centralizado.
 *
 * Desempenho: o destaque e o cartão se movem por `transform` (vai para a GPU,
 * sem refazer o layout) e só animam na TROCA de passo. Rolagem, redimensionar e
 * a conferência periódica atualizam na hora, sem animação, e só quando o alvo
 * de fato mudou de lugar. Passos que trocam de aba esperam a aba desenhar antes
 * de mover o destaque, para a animação não competir com o desenho da tela.
 */
export function Tour({ admin, abasVisiveis, abrirAba, onFechar }: {
  admin: boolean
  abasVisiveis: string[]
  abrirAba: (id: string) => void
  /** Chamada ao concluir OU pular. */
  onFechar: () => void
}) {
  const passos = useMemo<PassoTour[]>(
    () => (admin ? TOUR_ADMIN : TOUR_ATENDENTE).filter((p) => !p.aba || abasVisiveis.includes(p.aba)),
    [admin, abasVisiveis],
  )
  const [i, setI] = useState(0)
  const [alvo, setAlvo] = useState<Retangulo | null>(null)
  const alvoRef = useRef<Retangulo | null>(null)
  const [animando, setAnimando] = useState(false)
  const cartaoRef = useRef<HTMLDivElement>(null)
  const [cartaoPos, setCartaoPos] = useState<{ top: number; left: number } | null>(null)
  const jaPosicionou = useRef(false)
  const abaAtual = useRef<string | undefined>(undefined)
  const passo = passos[Math.min(i, passos.length - 1)]
  const ultimo = i >= passos.length - 1

  const aplicar = useCallback((r: Retangulo | null) => {
    if (!mudou(alvoRef.current, r) && (r !== null || alvoRef.current === null)) return
    alvoRef.current = r
    setAlvo(r)
  }, [])

  const medir = useCallback((alvoId: string): Retangulo | null => {
    const el = document.querySelector<HTMLElement>(`[data-tour="${alvoId}"]`)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: r.top, left: r.left, width: r.width, height: r.height }
  }, [])

  // Troca de passo: abre a aba (se for outra), espera desenhar, acha o alvo e anima até ele.
  useEffect(() => {
    if (!passo) return
    let cancelado = false
    const timers: ReturnType<typeof setTimeout>[] = []
    const trocaDeAba = Boolean(passo.aba) && passo.aba !== abaAtual.current
    if (passo.aba) { abrirAba(passo.aba); abaAtual.current = passo.aba }

    const chegar = (r: Retangulo | null) => {
      if (cancelado) return
      if (jaPosicionou.current) {
        setAnimando(true)
        timers.push(setTimeout(() => setAnimando(false), 480))
      }
      aplicar(r)
    }

    if (!passo.alvo) {
      timers.push(setTimeout(() => chegar(null), trocaDeAba ? 200 : 0))
    } else {
      let tentativas = 0
      const procurar = () => {
        if (cancelado) return
        const el = document.querySelector<HTMLElement>(`[data-tour="${passo.alvo}"]`)
        if (el) {
          // Se está fora da tela, rola ANTES de animar: assim o destaque vai direto ao lugar final.
          const r0 = el.getBoundingClientRect()
          const fora = r0.top < 0 || r0.bottom > window.innerHeight
          if (fora) el.scrollIntoView({ block: 'center', inline: 'nearest' })
          requestAnimationFrame(() => { const r = medir(passo.alvo!); if (r) chegar(r) })
        } else if (tentativas++ < 10) {
          timers.push(setTimeout(procurar, 120))
        } else {
          chegar(null)
        }
      }
      timers.push(setTimeout(procurar, trocaDeAba ? 220 : 60))
    }
    return () => { cancelado = true; timers.forEach(clearTimeout) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i])

  // Acompanha rolagem, redimensionamento e mudanças de layout, sem animação.
  useEffect(() => {
    if (!passo?.alvo) return
    const alvoId = passo.alvo
    let quadro = 0
    const atualizar = () => {
      quadro = 0
      const r = medir(alvoId)
      if (r) aplicar(r)
    }
    const agendar = () => { if (!quadro) quadro = requestAnimationFrame(atualizar) }
    window.addEventListener('resize', agendar)
    window.addEventListener('scroll', agendar, true)
    const intervalo = setInterval(agendar, 1000)
    return () => {
      if (quadro) cancelAnimationFrame(quadro)
      clearInterval(intervalo)
      window.removeEventListener('resize', agendar)
      window.removeEventListener('scroll', agendar, true)
    }
  }, [passo?.alvo, aplicar, medir])

  // Posiciona o cartão perto do alvo, sem sair da tela; sem alvo, no centro.
  useLayoutEffect(() => {
    const c = cartaoRef.current
    if (!c) return
    const w = c.offsetWidth
    const h = c.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    let top: number
    let left: number
    if (!alvo) {
      top = Math.max(12, (vh - h) / 2)
      left = Math.max(12, (vw - w) / 2)
    } else {
      const abaixo = alvo.top + alvo.height + 14
      top = abaixo + h + 12 <= vh ? abaixo : Math.max(12, alvo.top - h - 14)
      left = Math.min(Math.max(12, alvo.left + alvo.width / 2 - w / 2), vw - w - 12)
    }
    setCartaoPos((cur) => (cur && Math.abs(cur.top - top) < 0.5 && Math.abs(cur.left - left) < 0.5 ? cur : { top, left }))
    // A primeira posição é direta (o cartão não "voa" do canto); as seguintes animam.
    jaPosicionou.current = true
  }, [alvo, i])

  const proximo = useCallback(() => (ultimo ? onFechar() : setI((n) => n + 1)), [ultimo, onFechar])
  const anterior = useCallback(() => setI((n) => Math.max(0, n - 1)), [])

  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFechar()
      else if (e.key === 'ArrowRight' || e.key === 'Enter') proximo()
      else if (e.key === 'ArrowLeft') anterior()
    }
    document.addEventListener('keydown', tecla)
    return () => document.removeEventListener('keydown', tecla)
  }, [onFechar, proximo, anterior])

  if (!passo) return null

  const pad = 6
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const spot = alvo
    ? { x: alvo.left - pad, y: alvo.top - pad, w: alvo.width + pad * 2, h: alvo.height + pad * 2 }
    : { x: vw / 2, y: vh / 2, w: 0, h: 0 }

  return createPortal(
    <div className="tour-root" role="dialog" aria-modal="true" aria-label="Tour de boas-vindas">
      <div
        className={`tour-spot${alvo ? '' : ' sem-alvo'}${animando ? ' animando' : ''}`}
        style={{
          transform: `translate3d(${spot.x}px, ${spot.y}px, 0)`,
          width: spot.w,
          height: spot.h,
          // O "escurecer em volta" só precisa cobrir a tela, não 9999 px.
          boxShadow: `0 0 0 ${Math.max(vw, vh)}px rgba(0, 0, 0, 0.62)${alvo ? ', 0 0 0 2px var(--primary-text)' : ''}`,
        }}
      />
      <div className="tour-click" onClick={onFechar} aria-hidden="true" />
      <div
        ref={cartaoRef}
        className={`tour-card${animando ? ' animando' : ''}`}
        style={{
          transform: `translate3d(${cartaoPos?.left ?? 0}px, ${cartaoPos?.top ?? 0}px, 0)`,
          opacity: cartaoPos ? 1 : 0,
        }}
      >
        {/* key: o texto entra com um fade a cada passo, enquanto o cartão desliza. */}
        <div key={i} className="tour-body">
          <div className="tour-progress">Passo {Math.min(i + 1, passos.length)} de {passos.length}</div>
          <h2 className="tour-title">{passo.titulo}</h2>
          <p className="tour-text">{passo.texto}</p>
        </div>
        <div className="tour-actions">
          <button className="btn btn-ghost btn-sm" onClick={onFechar}>{ultimo ? 'Fechar' : 'Pular tour'}</button>
          <span style={{ flex: 1 }} />
          {i > 0 && <button className="btn btn-ghost btn-sm" onClick={anterior}>Voltar</button>}
          <button className="btn btn-primary btn-sm" onClick={proximo} autoFocus>{ultimo ? 'Concluir' : 'Próximo'}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
