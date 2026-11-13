import { useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/store/authStore'
import { useAvisosStore } from '@/store/avisosStore'
import { useConversaStore } from '@/store/conversaStore'
import { atendimentoService, conversationName } from '@/services/atendimentoService'
import type { WaMessage } from '@/types'

const TITULO = typeof document !== 'undefined' ? document.title : ''

let audioCtx: AudioContext | null = null
/** Dois tons curtos. Sem arquivo de áudio: nada para carregar nem hospedar. */
function beep() {
  try {
    audioCtx = audioCtx ?? new AudioContext()
    const ctx = audioCtx
    if (ctx.state === 'suspended') void ctx.resume()
    const t0 = ctx.currentTime
    ;[[880, 0], [1175, 0.14]].forEach(([freq, delay]) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t0 + delay)
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + delay + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 0.18)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t0 + delay)
      osc.stop(t0 + delay + 0.2)
    })
  } catch { /* navegador sem áudio ou ainda sem gesto do usuário: segue sem som */ }
}

function notificar(titulo: string, corpo: string, tag: string, onClick: () => void) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try {
    const n = new Notification(titulo, { body: corpo, tag })
    n.onclick = () => { window.focus(); onClick(); n.close() }
  } catch { /* alguns navegadores móveis só aceitam pelo service worker */ }
}

/**
 * Escuta o Realtime e avisa de mensagem nova de cliente e de lembrete que
 * venceu. Montado uma vez, na página do CRM: vale em qualquer aba do sistema,
 * não só no Atendimento. A RLS decide o que chega: só as conversas visíveis.
 */
export function AvisosAtendimento() {
  const userId = useAuthStore((s) => s.profile?.id ?? '')
  const naoLidas = useRef(0)
  const avisados = useRef<Set<string>>(new Set())
  const abrirConversa = useConversaStore((s) => s.abrirConversa)

  // Toque numa notificação push: o service worker abre /?conversa=ID (app
  // fechado) ou manda um recado (app aberto).
  useEffect(() => {
    const url = new URL(window.location.href)
    const id = url.searchParams.get('conversa')
    if (id) {
      url.searchParams.delete('conversa')
      window.history.replaceState({}, '', url.pathname + url.search + url.hash)
      abrirConversa(id)
    }
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'abrir-conversa' && typeof e.data.id === 'string') abrirConversa(e.data.id)
    }
    navigator.serviceWorker?.addEventListener('message', onMsg)
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg)
  }, [abrirConversa])

  // Título da aba: "(2) ..." enquanto há mensagem que ninguém viu.
  useEffect(() => {
    const zera = () => {
      naoLidas.current = 0
      document.title = TITULO
    }
    const onVis = () => { if (document.visibilityState === 'visible') zera() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', zera)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', zera)
    }
  }, [])

  useEffect(() => {
    if (!userId) return
    const channel = supabase
      .channel(`avisos:${crypto.randomUUID()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'wa_messages' }, async (payload) => {
        const m = payload.new as WaMessage
        const { ligado, aberta } = useAvisosStore.getState()
        if (!ligado || !m?.conversation_id || m.from_me) return
        const escondida = document.visibilityState !== 'visible'
        // Quem está com esta conversa aberta e a aba à vista já está vendo.
        if (!escondida && aberta === m.conversation_id) return

        const conv = await atendimentoService.getConversation(m.conversation_id).catch(() => null)
        if (!conv) return
        // Só o que é dele: a conversa que atende, ou a que está na fila.
        if (conv.assigned_to && conv.assigned_to !== userId) return

        beep()
        if (escondida) {
          naoLidas.current += 1
          document.title = `(${naoLidas.current}) ${TITULO}`
          notificar(
            conversationName(conv),
            (m.body ?? '').slice(0, 120) || 'Nova mensagem',
            conv.id,
            () => abrirConversa(conv.id),
          )
        }
      })
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [userId, abrirConversa])

  // Lembretes que venceram: confere a cada 30 s e avisa uma vez cada.
  useEffect(() => {
    if (!userId) return
    const confere = async () => {
      if (!useAvisosStore.getState().ligado) return
      const tasks = await atendimentoService.myTasks(userId).catch(() => [])
      for (const t of tasks) {
        if (new Date(t.due_at).getTime() > Date.now() || avisados.current.has(t.id)) continue
        avisados.current.add(t.id)
        beep()
        notificar('Lembrete', t.title, `task-${t.id}`, () => abrirConversa(t.conversation_id))
      }
    }
    void confere()
    const i = setInterval(confere, 30_000)
    return () => clearInterval(i)
  }, [userId, abrirConversa])

  return null
}

/**
 * Liga/desliga os avisos e pede a permissão do navegador. Devolve o estado
 * para a central de avisos mostrar (ligado, permissão do navegador).
 */
export async function alternarAvisos() {
  const { ligado, setLigado } = useAvisosStore.getState()
  const temNotif = typeof Notification !== 'undefined'
  if (!ligado) {
    setLigado(true)
    beep() // também libera o áudio do navegador (precisa de um gesto)
    if (temNotif && Notification.permission === 'default') await Notification.requestPermission()
    return
  }
  if (temNotif && Notification.permission === 'default') {
    await Notification.requestPermission()
    return
  }
  setLigado(false)
}
