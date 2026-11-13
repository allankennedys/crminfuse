import { useEffect, useState } from 'react'
import { Download, Share, X as XIcon } from 'lucide-react'
import { emAppInstalado, ehCelular, ehIOS } from '@/lib/push'

/** O evento que deixa o Chrome do Android instalar com um toque (main.tsx guarda o primeiro). */
interface PromptInstalacao extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}
declare global {
  interface Window { __promptInstalacao?: PromptInstalacao }
}

const CHAVE = 'install-dispensado'
const DIAS_SEM_INSISTIR = 7

function dispensadoRecentemente(): boolean {
  try {
    const t = Number(localStorage.getItem(CHAVE))
    return Number.isFinite(t) && t > 0 && Date.now() - t < DIAS_SEM_INSISTIR * 86_400_000
  } catch { return false }
}

/**
 * Faixa no rodapé, só no celular e só quando o app NÃO está instalado,
 * sugerindo instalar e explicando o ganho (tela cheia e notificações com o app
 * fechado). Android com Chrome: botão "Instalar" abre o instalador do sistema.
 * iPhone: não existe botão, então mostra o caminho (Compartilhar → Adicionar à
 * Tela de Início). "X" some por 7 dias.
 */
export function InstallBanner() {
  const [visivel, setVisivel] = useState(false)
  const [temPrompt, setTemPrompt] = useState(false)
  const [comoFazer, setComoFazer] = useState(false)
  const ios = ehIOS()

  useEffect(() => {
    if (!ehCelular() || emAppInstalado() || dispensadoRecentemente()) return
    setVisivel(true)
    setTemPrompt(Boolean(window.__promptInstalacao))
    const aoChegar = () => setTemPrompt(Boolean(window.__promptInstalacao))
    const aoInstalar = () => setVisivel(false)
    window.addEventListener('prompt-instalacao', aoChegar)
    window.addEventListener('appinstalled', aoInstalar)
    return () => {
      window.removeEventListener('prompt-instalacao', aoChegar)
      window.removeEventListener('appinstalled', aoInstalar)
    }
  }, [])

  if (!visivel) return null

  const dispensar = () => {
    try { localStorage.setItem(CHAVE, String(Date.now())) } catch { /* sem armazenamento: aparece de novo */ }
    setVisivel(false)
  }

  const instalar = async () => {
    const p = window.__promptInstalacao
    if (!p) { setComoFazer(true); return }
    await p.prompt()
    const r = await p.userChoice.catch(() => null)
    window.__promptInstalacao = undefined
    setTemPrompt(false)
    if (r?.outcome === 'accepted') setVisivel(false)
  }

  return (
    <div className="install-banner" role="region" aria-label="Instalar o app">
      <img src="/icon-192.png" alt="" width={40} height={40} />
      <div className="install-text">
        <strong>Instale o Infuse no seu celular</strong>
        <span>
          Abre direto da tela inicial, em tela cheia, e avisa de mensagem nova mesmo com o app fechado.
        </span>
        {(comoFazer || (ios && !temPrompt)) && (
          <span className="install-how">
            {ios
              ? <>No iPhone: toque em <Share size={13} style={{ verticalAlign: '-2px' }} /> Compartilhar e depois em <strong>Adicionar à Tela de Início</strong>. É assim que as notificações passam a funcionar por lá.</>
              : <>No menu do navegador (⋮), escolha <strong>Instalar app</strong> ou <strong>Adicionar à tela inicial</strong>.</>}
          </span>
        )}
      </div>
      {!ios && (
        <button className="btn btn-primary btn-sm" onClick={instalar}>
          <Download size={14} /> Instalar
        </button>
      )}
      <button className="icon-btn" onClick={dispensar} aria-label="Agora não" title="Agora não">
        <XIcon size={15} />
      </button>
    </div>
  )
}
