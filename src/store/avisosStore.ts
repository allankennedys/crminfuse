import { create } from 'zustand'

const KEY = 'at-avisos'

function lerLigado(): boolean {
  try { return localStorage.getItem(KEY) !== 'off' } catch { return true }
}

/**
 * Avisos do atendimento (138): som e notificação do navegador quando chega
 * mensagem de cliente. `aberta` é a conversa que está na tela agora — quem
 * está olhando para ela não precisa ser avisado.
 */
interface AvisosState {
  ligado: boolean
  aberta: string | null
  setLigado: (v: boolean) => void
  setAberta: (id: string | null) => void
}

export const useAvisosStore = create<AvisosState>((set) => ({
  ligado: lerLigado(),
  aberta: null,
  setLigado: (v) => {
    try { localStorage.setItem(KEY, v ? 'on' : 'off') } catch { /* sem armazenamento: vale só nesta aba */ }
    set({ ligado: v })
  },
  setAberta: (id) => set({ aberta: id }),
}))
