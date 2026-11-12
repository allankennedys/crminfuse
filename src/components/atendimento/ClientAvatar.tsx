import { useEffect, useState } from 'react'
import { atendimentoService } from '@/services/atendimentoService'
import { initials } from './format'
import type { WaConversation } from '@/types'

/** Pedidos de link novo já feitos nesta sessão — um por conversa basta. */
const pedidos = new Set<string>()

/**
 * Foto de perfil do cliente (127), com as iniciais no lugar quando não há
 * foto ou quando ela não carrega. Link do WhatsApp expira: imagem quebrada
 * pede um novo ao servidor (uma vez por conversa nesta sessão).
 */
export function ClientAvatar({ conv, name }: { conv: WaConversation; name: string }) {
  const [quebrou, setQuebrou] = useState(false)
  useEffect(() => { setQuebrou(false) }, [conv.avatar_url])

  if (conv.avatar_url && !quebrou) {
    return (
      <img
        className="at-avatar at-avatar-img"
        src={conv.avatar_url}
        alt=""
        aria-hidden="true"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => {
          setQuebrou(true)
          if (!pedidos.has(conv.id)) {
            pedidos.add(conv.id)
            atendimentoService.refreshAvatar(conv.id, true).catch(() => { /* fica com as iniciais */ })
          }
        }}
      />
    )
  }
  return <span className="at-avatar" aria-hidden="true">{initials(name)}</span>
}
