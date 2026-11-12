import { create } from 'zustand'

/**
 * Tema claro/escuro. A escolha fica no navegador; sem escolha, segue o
 * sistema operacional. O index.html aplica o tema salvo antes de o CSS
 * desenhar a página (sem piscar escuro → claro); aqui fica o estado para o
 * botão e para quem precisa saber o tema (logos).
 */
export type Theme = 'light' | 'dark'

const KEY = 'infuse-theme'

function initial(): Theme {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch { /* navegador sem storage: segue o sistema */ }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function apply(t: Theme) {
  document.documentElement.dataset.theme = t
}

export const useTheme = create<{ theme: Theme; toggle: () => void }>((set, get) => {
  const t = initial()
  apply(t)
  return {
    theme: t,
    toggle: () => {
      const next: Theme = get().theme === 'dark' ? 'light' : 'dark'
      apply(next)
      try { localStorage.setItem(KEY, next) } catch { /* só não lembra */ }
      set({ theme: next })
    },
  }
})
