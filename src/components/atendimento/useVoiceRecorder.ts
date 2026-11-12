import { useCallback, useEffect, useRef, useState } from 'react'

/** Limite de uma mensagem de voz. Ao chegar nele, a gravação para e é enviada. */
export const VOICE_MAX_SECONDS = 5 * 60

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

/**
 * Grava uma mensagem de voz pelo microfone.
 *
 *   start() ............. pede o microfone e começa
 *   stop(true) .......... para e entrega o arquivo em onDone
 *   stop(false) ......... descarta
 *
 * O microfone é sempre liberado ao parar ou ao desmontar a tela — sem isso
 * o navegador continua mostrando o ícone de "gravando".
 */
export function useVoiceRecorder(onDone: (file: File) => void, onError: (e: VoiceError) => void) {
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedRef = useRef(0)
  const sendRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const doneRef = useRef(onDone)
  const errorRef = useRef(onError)
  doneRef.current = onDone
  errorRef.current = onError

  const release = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    recorderRef.current = null
    setRecording(false)
    setSeconds(0)
  }, [])

  const stop = useCallback((send: boolean) => {
    const rec = recorderRef.current
    if (!rec) return
    sendRef.current = send
    if (rec.state !== 'inactive') rec.stop()
    else release()
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

    const rec = new MediaRecorder(stream, { mimeType: format.mime })
    chunksRef.current = []
    sendRef.current = false
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
    rec.onstop = () => {
      const duration = (Date.now() - startedRef.current) / 1000
      const blob = new Blob(chunksRef.current, { type: format.mime })
      const enviar = sendRef.current
      release()
      if (!enviar) return
      if (duration < 1 || blob.size < 1000) {
        errorRef.current('curto')
        return
      }
      const type = format.mime.split(';')[0]
      doneRef.current(new File([blob], `mensagem-de-voz-${Date.now()}.${format.ext}`, { type }))
    }

    streamRef.current = stream
    recorderRef.current = rec
    startedRef.current = Date.now()
    rec.start(250)
    setRecording(true)
    setSeconds(0)
    timerRef.current = setInterval(() => {
      const s = Math.floor((Date.now() - startedRef.current) / 1000)
      setSeconds(s)
      if (s >= VOICE_MAX_SECONDS) {
        sendRef.current = true
        if (rec.state !== 'inactive') rec.stop()
      }
    }, 250)
  }, [release])

  // Saiu da conversa no meio da gravação: descarta e solta o microfone.
  useEffect(() => () => {
    sendRef.current = false
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    if (timerRef.current) clearInterval(timerRef.current)
  }, [])

  return { recording, seconds, start, stop }
}
