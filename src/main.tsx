import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './styles/global.css'
import { useAuthStore } from './store/authStore'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)

// PWA: registra o service worker só em produção (no desenvolvimento ele
// atrapalharia o recarregamento a quente). Falha de registro não afeta o app.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* sem service worker o app segue normal */ })
  })
}

// Tela de abertura (#splash, no index.html): sai quando o app já sabe se há
// sessão (não mostra a tela de carregamento por baixo) E depois de um tempo
// mínimo desde que a página começou a abrir, para dar tempo de enxergar a
// marca em vez de piscar. Se algo travar, sai de qualquer jeito em 8 s.
const SPLASH_MINIMO_MS = 1400
const splash = document.getElementById('splash')
if (splash) {
  let saiu = false
  const sair = () => {
    if (saiu) return
    saiu = true
    unsub()
    const espera = Math.max(0, SPLASH_MINIMO_MS - performance.now())
    setTimeout(() => {
      splash.classList.add('saindo')
      setTimeout(() => splash.remove(), 450)
    }, espera)
  }
  const tentar = () => { if (!useAuthStore.getState().loading) sair() }
  const unsub = useAuthStore.subscribe(tentar)
  tentar()
  setTimeout(sair, 8000)
}
