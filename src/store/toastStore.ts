import { create } from 'zustand'

export type ToastType = 'success' | 'error' | 'info'
export interface ToastItem { id: number; message: string; type: ToastType }

interface ToastState {
  toasts: ToastItem[]
  push: (message: string, type: ToastType) => void
  dismiss: (id: number) => void
}

let counter = 0

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (message, type) => {
    const id = ++counter
    set((s) => ({ toasts: [...s.toasts, { id, message, type }] }))
    // Erros ficam mais tempo (podem ter texto maior); os demais somem rápido.
    const duration = type === 'error' ? 7000 : 4500
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), duration)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

/** Helper para disparar toasts fora de componentes React. */
export const toast = {
  success: (m: string) => useToastStore.getState().push(m, 'success'),
  error: (m: string) => useToastStore.getState().push(m, 'error'),
  info: (m: string) => useToastStore.getState().push(m, 'info'),
}
