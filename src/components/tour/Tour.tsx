import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TOUR_ADMIN, TOUR_ATENDENTE, type PassoTour } from './steps'

interface Retangulo { top: number; left: number; width: number; height: number }

/**
 * Tour de boas-vindas (151): destaca partes da tela, passo a passo. Pode ser
 * pulada a qualquer momento (botão, Esc ou clicar fora). O conteúdo muda com o
 * tipo de usuário: administrador ou atendente. Passo que pede uma aba que a
 * pessoa não tem é descartado; passo sem elemento na tela aparece centralizado.
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
  const cartaoRef = useRef<HTMLDivElement>(null)
  const [cartaoPos, setCartaoPos] = useState<{ top: number; left: number } | null>(null)
  const passo = passos[Math.min(i, passos.length - 1)]
  const ultimo = i >= passos.length - 1

  // Abre a aba do passo e acha o elemento (com algumas tentativas: a tela pode demorar a desenhar).
  useEffect(() => {
    if (!passo) return
    if (passo.aba) abrirAba(passo.aba)
    setAlvo(null)
    if (!passo.alvo) return
    let tentativas = 0
    const medir = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${passo.alvo}"]`)
      if (el) {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        const r = el.getBoundingClientRect()
        setAlvo({ top: r.top, left: r.left, width: r.width, height: r.height })
      } else if (tentativas++ < 8) {
        timer = setTimeout(medir, 150)
      }
    }
    let timer = setTimeout(medir, 80)
    const reajustar = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${passo.alvo}"]`)
      if (!el) return setAlvo(null)
      const r = el.getBoundingClientRect()
      setAlvo({ top: r.top, left: r.left, width: r.width, height: r.height })
    }
    window.addEventListener('resize', reajustar)
    window.addEventListener('scroll', reajustar, true)
    const intervalo = setInterval(reajustar, 500)
    return () => {
      clearTimeout(timer)
      clearInterval(intervalo)
      window.removeEventListener('resize', reajustar)
      window.removeEventListener('scroll', reajustar, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, passo?.alvo, passo?.aba])

  // Posiciona o cartão perto do alvo, sem sair da tela; sem alvo, no centro.
  useLayoutEffect(() => {
    const c = cartaoRef.current
    if (!c) return
    const w = c.offsetWidth
    const h = c.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    if (!alvo) {
      setCartaoPos({ top: Math.max(12, (vh - h) / 2), left: Math.max(12, (vw - w) / 2) })
      return
    }
    const abaixo = alvo.top + alvo.height + 14
    const top = abaixo + h + 12 <= vh ? abaixo : Math.max(12, alvo.top - h - 14)
    const left = Math.min(Math.max(12, alvo.left + alvo.width / 2 - w / 2), vw - w - 12)
    setCartaoPos({ top, left })
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
  return createPortal(
    <div className="tour-root" role="dialog" aria-modal="true" aria-label="Tour de boas-vindas">
      {/* Fundo escuro; com alvo, o "buraco" é uma caixa com sombra enorme. */}
      {alvo ? (
        <div
          className="tour-spot"
          style={{ top: alvo.top - pad, left: alvo.left - pad, width: alvo.width + pad * 2, height: alvo.height + pad * 2 }}
        />
      ) : (
        <div className="tour-dim" />
      )}
      <div className="tour-click" onClick={onFechar} aria-hidden="true" />
      <div
        ref={cartaoRef}
        className="tour-card"
        style={{ top: cartaoPos?.top ?? -9999, left: cartaoPos?.left ?? -9999, visibility: cartaoPos ? 'visible' : 'hidden' }}
      >
        <div className="tour-progress">Passo {Math.min(i + 1, passos.length)} de {passos.length}</div>
        <h2 className="tour-title">{passo.titulo}</h2>
        <p className="tour-text">{passo.texto}</p>
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
