import { create } from 'zustand'

export interface ConfirmOptions {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

interface ConfirmState {
  current: (ConfirmOptions & { id: number }) | null
  resolver: ((v: boolean) => void) | null
  open: (opts: ConfirmOptions) => Promise<boolean>
  respond: (v: boolean) => void
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  current: null,
  resolver: null,
  open: (opts) =>
    new Promise<boolean>((resolve) => {
      // Se já houver um diálogo aberto, cancela o anterior.
      get().resolver?.(false)
      set({ current: { ...opts, id: Date.now() }, resolver: resolve })
    }),
  respond: (v) => {
    get().resolver?.(v)
    set({ current: null, resolver: null })
  },
}))

/** Abre um diálogo de confirmação estilizado; resolve true/false. */
export function confirmDialog(opts: ConfirmOptions | string): Promise<boolean> {
  return useConfirmStore.getState().open(typeof opts === 'string' ? { message: opts } : opts)
}
