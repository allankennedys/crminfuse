import { create } from 'zustand'

/** Pedido para rever a tour (botão em Configurações → Minha conta), mesmo já concluída. */
interface TourState {
  rever: boolean
  pedirRever: () => void
  fechar: () => void
}

export const useTour = create<TourState>((set) => ({
  rever: false,
  pedirRever: () => set({ rever: true }),
  fechar: () => set({ rever: false }),
}))
