import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Pause, Play, Send, Square, Trash2 } from 'lucide-react'
import { VOICE_MAX_SECONDS, type VoicePreview, type VoiceRecorder } from './useVoiceRecorder'

/** Barras da onda na revisão. */
const PREVIEW_BARS = 56

const fmt = (s: number) => {
  const t = Math.max(0, Math.round(s))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

/** Altura da barra: nunca some de vez (silêncio vira um tracinho). */
const altura = (l: number) => `${Math.round(12 + Math.min(1, l) * 88)}%`

/**
 * Comprime o volume da gravação inteira em `n` barras (o pico de cada
 * trecho) e normaliza pelo maior — gravação baixa também desenha uma onda
 * legível. O piso de 0,25 evita "inflar" um áudio que é quase só silêncio.
 */
function resumir(levels: number[], n: number): number[] {
  if (levels.length === 0) return Array(n).fill(0)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * levels.length) / n)
    const b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / n))
    let pico = 0
    for (let j = a; j < b && j < levels.length; j++) pico = Math.max(pico, levels[j])
    out.push(pico)
  }
  const max = Math.max(0.25, ...out)
  return out.map((v) => v / max)
}

/**
 * Linha do compositor enquanto há mensagem de voz: gravando (onda ao vivo)
 * ou revisão (ouvir antes de enviar).
 */
export function VoiceComposer({ voice }: { voice: VoiceRecorder }) {
  if (voice.phase === 'preview' && voice.preview) {
    return (
      <div className="at-composer-row at-recording">
        <button
          type="button"
          className="icon-btn btn-danger-ghost"
          onClick={voice.discard}
          title="Descartar áudio"
          aria-label="Descartar áudio"
        >
          <Trash2 size={17} />
        </button>
        <PreviewPlayer preview={voice.preview} />
        <button
          type="button"
          className="btn btn-primary at-send"
          onClick={voice.send}
          title="Enviar áudio"
          aria-label="Enviar áudio"
        >
          <Send size={16} />
        </button>
      </div>
    )
  }

  const perto = voice.seconds >= VOICE_MAX_SECONDS - 30
  return (
    <div className="at-composer-row at-recording">
      <button
        type="button"
        className="icon-btn btn-danger-ghost"
        onClick={() => voice.stop('discard')}
        title="Descartar áudio"
        aria-label="Descartar áudio"
      >
        <Trash2 size={17} />
      </button>
      <div className="at-rec-status">
        <span className="at-rec-dot" aria-hidden="true" />
        <span className="sr-only" role="status">Gravando mensagem de voz</span>
        <strong className="at-rec-time" aria-hidden="true">{fmt(voice.seconds)}</strong>
        <div className="at-wave at-wave-live" aria-hidden="true">
          {voice.levels.map((l, i) => <i key={i} style={{ height: altura(l) }} />)}
        </div>
        {perto && <span className="text-muted at-rec-limit">limite de 5 min</span>}
      </div>
      <button
        type="button"
        className="btn btn-ghost at-send"
        onClick={() => voice.stop('preview')}
        title="Parar e ouvir antes de enviar"
        aria-label="Parar e ouvir antes de enviar"
      >
        <Square size={13} fill="currentColor" />
      </button>
      <button
        type="button"
        className="btn btn-primary at-send"
        onClick={() => voice.stop('send')}
        title="Enviar áudio"
        aria-label="Enviar áudio"
      >
        <Send size={16} />
      </button>
    </div>
  )
}

/**
 * Player da revisão: play/pausa, onda que vai sendo preenchida enquanto toca
 * (clique ou setas para pular) e o tempo. A duração é a do arquivo quando o
 * navegador a informa; senão, a medida na gravação (o webm do Chrome às
 * vezes chega ao <audio> com duração "Infinity").
 */
function PreviewPlayer({ preview }: { preview: VoicePreview }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  // Começa com a duração medida; se o navegador souber a do arquivo, vale ela.
  const [total, setTotal] = useState(preview.seconds)
  const barras = useMemo(() => resumir(preview.levels, PREVIEW_BARS), [preview.levels])

  // Progresso suave enquanto toca.
  useEffect(() => {
    if (!playing) return
    let id = 0
    const tick = () => {
      const a = audioRef.current
      if (a) setPos(Math.min(total, a.currentTime))
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [playing, total])

  const toggle = () => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) a.play().catch(() => setPlaying(false))
    else a.pause()
  }

  const irPara = (s: number) => {
    const alvo = Math.max(0, Math.min(total, s))
    const a = audioRef.current
    if (a) a.currentTime = alvo
    setPos(alvo)
  }

  const onSeek = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    irPara(((e.clientX - r.left) / r.width) * total)
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); irPara(pos + 2) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); irPara(pos - 2) }
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle() }
  }

  const progresso = total > 0 ? pos / total : 0
  const tocou = playing || pos > 0

  return (
    <div className="at-rec-status at-voice-preview">
      <audio
        ref={audioRef}
        src={preview.url}
        preload="auto"
        onLoadedMetadata={(e) => {
          // webm do Chrome chega sem duração (Infinity). Pular para o "fim"
          // obriga o navegador a calculá-la; depois volta para o começo.
          const a = e.currentTarget
          if (a.duration !== Infinity) return
          const pronto = () => {
            a.removeEventListener('timeupdate', pronto)
            a.currentTime = 0
          }
          a.addEventListener('timeupdate', pronto)
          a.currentTime = 1e101
        }}
        onDurationChange={(e) => {
          const d = e.currentTarget.duration
          if (Number.isFinite(d) && d > 0) setTotal(d)
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setPos(0) }}
      />
      <button
        type="button"
        className="at-voice-play"
        onClick={toggle}
        title={playing ? 'Pausar' : 'Ouvir antes de enviar'}
        aria-label={playing ? 'Pausar' : 'Ouvir antes de enviar'}
      >
        {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
      </button>
      <div
        className="at-wave at-wave-preview"
        onClick={onSeek}
        onKeyDown={onKey}
        role="slider"
        tabIndex={0}
        aria-label="Posição no áudio"
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(pos)}
        aria-valuetext={`${fmt(pos)} de ${fmt(total)}`}
      >
        {barras.map((l, i) => (
          <i key={i} className={(i + 0.5) / barras.length <= progresso ? 'on' : undefined} style={{ height: altura(l) }} />
        ))}
      </div>
      <strong className="at-rec-time">{tocou ? fmt(pos) : fmt(total)}</strong>
    </div>
  )
}
