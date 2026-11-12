import { useCallback, useEffect, useRef, useState } from 'react'

/** Limite de uma mensagem de voz. Ao chegar nele, a gravação para e vai para a revisão. */
export const VOICE_MAX_SECONDS = 5 * 60

/** Uma barra da onda a cada 100 ms. */
const LEVEL_MS = 100
/** Barras guardadas para a onda ao vivo — sobra para a largura do compositor. */
const LIVE_BARS = 160

/**
 * Formatos em ordem de preferência. ogg/opus é o do próprio WhatsApp
 * (Firefox grava nele); webm/opus é o do Chrome; mp4 é o do Safari. A
 * Evolution converte qualquer um deles para mensagem de voz.
 */
const FORMATS: { mime: string; ext: string }[] = [
  { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
  { mime: 'audio/webm;codecs=opus', ext: 'webm' },
  { mime: 'audio/webm', ext: 'webm' },
  { mime: 'audio/mp4', ext: 'm4a' },
]

function pickFormat() {
  if (typeof MediaRecorder === 'undefined') return null
  return FORMATS.find((f) => MediaRecorder.isTypeSupported(f.mime)) ?? null
}

export type VoiceError = 'sem-suporte' | 'sem-permissao' | 'curto'

/** Gravação pronta, esperando a pessoa ouvir e decidir. */
export type VoicePreview = {
  file: File
  /** blob: para o <audio> da revisão — revogado ao enviar ou descartar. */
  url: string
  /** Duração medida na gravação (o webm do Chrome não informa a dele). */
  seconds: number
  /** Volume de cada trecho de 100 ms, 0–1: a onda da revisão. */
  levels: number[]
}

export type VoicePhase = 'idle' | 'recording' | 'preview'

/** O que fazer quando o gravador terminar de entregar o áudio. */
type AfterStop = 'send' | 'preview' | 'discard'

/**
 * Grava uma mensagem de voz pelo microfone.
 *
 *   start() .............. pede o microfone e começa
 *   stop('preview') ...... para e abre a revisão (ouvir antes de enviar)
 *   stop('send') ......... para e entrega o arquivo direto em onDone
 *   stop('discard') ...... para e joga fora
 *   send() / discard() ... na revisão: envia ou joga fora
 *
 * Enquanto grava, `levels` traz o volume dos últimos trechos para a onda ao
 * vivo (AnalyserNode no mesmo stream do microfone — nada vai para o alto-
 * falante). O microfone é sempre liberado ao parar ou ao desmontar a tela —
 * sem isso o navegador continua mostrando o ícone de "gravando".
 */
export function useVoiceRecorder(onDone: (file: File) => void, onError: (e: VoiceError) => void) {
  const [phase, setPhase] = useState<VoicePhase>('idle')
  const [seconds, setSeconds] = useState(0)
  const [levels, setLevels] = useState<number[]>([])
  const [preview, setPreview] = useState<VoicePreview | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const levelsRef = useRef<number[]>([])
  const startedRef = useRef(0)
  const afterStopRef = useRef<AfterStop>('discard')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const previewUrlRef = useRef<string | null>(null)
  const doneRef = useRef(onDone)
  const errorRef = useRef(onError)
  doneRef.current = onDone
  errorRef.current = onError

  /** Solta microfone, analisador e cronômetro. */
  const release = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
    recorderRef.current = null
  }, [])

  const clearPreview = useCallback(() => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = null
    setPreview(null)
  }, [])

  const stop = useCallback((after: AfterStop) => {
    const rec = recorderRef.current
    if (!rec) return
    afterStopRef.current = after
    if (rec.state !== 'inactive') rec.stop()
    else { release(); setPhase('idle') }
  }, [release])

  const start = useCallback(async () => {
    const format = pickFormat()
    if (!format || !navigator.mediaDevices?.getUserMedia) {
      errorRef.current('sem-suporte')
      return
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch {
      errorRef.current('sem-permissao')
      return
    }

    clearPreview()
    const rec = new MediaRecorder(stream, { mimeType: format.mime })
    chunksRef.current = []
    levelsRef.current = []
    afterStopRef.current = 'discard'
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
    rec.onstop = () => {
      const duration = (Date.now() - startedRef.current) / 1000
      const blob = new Blob(chunksRef.current, { type: format.mime })
      const after = afterStopRef.current
      release()
      setSeconds(0)
      setLevels([])
      if (after === 'discard') { setPhase('idle'); return }
      if (duration < 1 || blob.size < 1000) {
        setPhase('idle')
        errorRef.current('curto')
        return
      }
      const type = format.mime.split(';')[0]
      const file = new File([blob], `mensagem-de-voz-${Date.now()}.${format.ext}`, { type })
      if (after === 'send') {
        setPhase('idle')
        doneRef.current(file)
        return
      }
      const url = URL.createObjectURL(blob)
      previewUrlRef.current = url
      setPreview({ file, url, seconds: duration, levels: levelsRef.current.slice() })
      setPhase('preview')
    }

    // Medidor de volume para a onda. Sem Web Audio (raro) a gravação segue,
    // só sem a onda.
    let medir: (() => number) | null = null
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (Ctx) {
        const ctx = new Ctx()
        ctx.resume().catch(() => {})
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 2048
        ctx.createMediaStreamSource(stream).connect(analyser)
        const buf = new Float32Array(analyser.fftSize)
        audioCtxRef.current = ctx
        medir = () => {
          analyser.getFloatTimeDomainData(buf)
          let soma = 0
          for (let i = 0; i < buf.length; i++) soma += buf[i] * buf[i]
          // Raiz do RMS: fala baixa ainda aparece, fala alta não estoura.
          return Math.min(1, Math.sqrt(Math.sqrt(soma / buf.length)) * 1.8)
        }
      }
    } catch {
      medir = null
    }

    streamRef.current = stream
    recorderRef.current = rec
    startedRef.current = Date.now()
    rec.start(250)
    setPhase('recording')
    setSeconds(0)
    setLevels([])
    timerRef.current = setInterval(() => {
      if (medir) {
        levelsRef.current.push(medir())
        setLevels(levelsRef.current.slice(-LIVE_BARS))
      }
      const s = Math.floor((Date.now() - startedRef.current) / 1000)
      setSeconds(s)
      if (s >= VOICE_MAX_SECONDS && rec.state !== 'inactive') {
        afterStopRef.current = 'preview'
        rec.stop()
      }
    }, LEVEL_MS)
  }, [release, clearPreview])

  /** Revisão: manda o áudio ouvido. */
  const send = useCallback(() => {
    if (!preview) return
    const file = preview.file
    clearPreview()
    setPhase('idle')
    doneRef.current(file)
  }, [preview, clearPreview])

  /** Revisão: joga fora. */
  const discard = useCallback(() => {
    clearPreview()
    setPhase('idle')
  }, [clearPreview])

  // Saiu da conversa no meio da gravação ou da revisão: descarta e solta o
  // microfone. (O ChatThread é montado de novo a cada conversa, então um
  // áudio nunca muda de cliente.)
  useEffect(() => () => {
    afterStopRef.current = 'discard'
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    audioCtxRef.current?.close().catch(() => {})
    if (timerRef.current) clearInterval(timerRef.current)
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
  }, [])

  return { phase, seconds, levels, preview, start, stop, send, discard }
}

export type VoiceRecorder = ReturnType<typeof useVoiceRecorder>
