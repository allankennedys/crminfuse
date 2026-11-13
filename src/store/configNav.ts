import { create } from 'zustand'

/** Pedido para abrir uma aba específica das Configurações (ex.: o aviso de assinatura leva a "plano"). */
interface ConfigNav {
  pedida: string | null
  pedir: (tab: string) => void
  consumir: () => void
}

export const useConfigNav = create<ConfigNav>((set) => ({
  pedida: null,
  pedir: (tab) => set({ pedida: tab }),
  consumir: () => set({ pedida: null }),
}))
