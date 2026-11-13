import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Pause, Play } from 'lucide-react'
import { altura, analisarAudio, fmtDur, ondaProvisoria } from './wave'

const BARRAS = 36
const VELOCIDADES = [1, 1.5, 2]
/** Avisa os outros players: só um áudio toca por vez. */
const EVENTO = 'infuse-audio-play'

/**
 * Mensagem de voz na conversa: play/pausa, onda do próprio áudio (preenche
 * enquanto toca; clique ou setas para pular), duração e velocidade
 * (1x → 1,5x → 2x), que aparece depois do primeiro play.
 */
export function AudioMessage({ id, url }: { id: string; url: string }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [barras, setBarras] = useState<number[]>(() => ondaProvisoria(id, BARRAS))
  const [duracao, setDuracao] = useState<number | null>(null)
  const [pos, setPos] = useState(0)
  const [tocando, setTocando] = useState(false)
  const [usado, setUsado] = useState(false)
  const [vel, setVel] = useState(1)

  // Onda e duração de verdade (decodifica o arquivo uma vez).
  useEffect(() => {
    let vivo = true
    analisarAudio(url, BARRAS).then((r) => {
      if (!vivo || !r) return
      setBarras(r.picos)
      setDuracao(r.duracao)
    })
    return () => { vivo = false }
  }, [url])

  // Outro áudio começou: este pausa.
  useEffect(() => {
    const outro = (e: Event) => { if ((e as CustomEvent<string>).detail !== id) audioRef.current?.pause() }
    window.addEventListener(EVENTO, outro)
    return () => window.removeEventListener(EVENTO, outro)
  }, [id])

  // Progresso suave enquanto toca.
  useEffect(() => {
    if (!tocando) return
    let raf = 0
    const tick = () => {
      const a = audioRef.current
      if (a) setPos(a.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [tocando])

  const total = duracao ?? 0

  const alternar = () => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) {
      window.dispatchEvent(new CustomEvent(EVENTO, { detail: id }))
      a.playbackRate = vel
      a.play().catch(() => setTocando(false))
      setUsado(true)
    } else {
      a.pause()
    }
  }

  const irPara = (s: number) => {
    if (!total) return
    const alvo = Math.max(0, Math.min(total, s))
    const a = audioRef.current
    if (a) a.currentTime = alvo
    setPos(alvo)
    setUsado(true)
  }

  const onSeek = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    irPara(((e.clientX - r.left) / r.width) * total)
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); irPara(pos + 5) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); irPara(pos - 5) }
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); alternar() }
  }

  const trocarVelocidade = () => {
    const prox = VELOCIDADES[(VELOCIDADES.indexOf(vel) + 1) % VELOCIDADES.length]
    setVel(prox)
    if (audioRef.current) audioRef.current.playbackRate = prox
  }

  const progresso = total > 0 ? pos / total : 0
  const mostraPos = tocando || pos > 0

  return (
    <div className="at-voice">
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration
          if (Number.isFinite(d) && d > 0) setDuracao((atual) => atual ?? d)
        }}
        onPlay={() => setTocando(true)}
        onPause={() => setTocando(false)}
        onEnded={() => { setTocando(false); setPos(0) }}
      />
      <button
        type="button"
        className="at-voice-btn"
        onClick={alternar}
        aria-label={tocando ? 'Pausar mensagem de voz' : 'Ouvir mensagem de voz'}
      >
        {tocando ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
      </button>
      <div className="at-voice-main">
        <div
          className="at-voice-wave"
          onClick={onSeek}
          onKeyDown={onKey}
          role="slider"
          tabIndex={0}
          aria-label="Posição na mensagem de voz"
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(pos)}
          aria-valuetext={`${fmtDur(pos)} de ${fmtDur(total)}`}
        >
          {barras.map((l, i) => (
            <i key={i} className={(i + 0.5) / barras.length <= progresso ? 'on' : undefined} style={{ height: altura(l) }} />
          ))}
        </div>
        <div className="at-voice-sub">
          <span>{duracao === null && !mostraPos ? '—:—' : fmtDur(mostraPos ? pos : total)}</span>
          {usado && (
            <button type="button" className="at-voice-rate" onClick={trocarVelocidade} aria-label="Velocidade de reprodução">
              {String(vel).replace('.', ',')}x
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
