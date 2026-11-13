import { LogOut } from 'lucide-react'
import { PlanoCobranca } from './PlanoCobranca'
import type { MySubscription } from '@/services/billingService'

/**
 * Tela cheia quando a assinatura está suspensa. Administradores veem as
 * opções de pagamento; os demais, o aviso para falar com o administrador.
 * Sempre dá para sair.
 */
export function BloqueioAssinatura({ sub, onChanged, onSignOut }: {
  sub: MySubscription
  onChanged: () => void
  onSignOut: () => void
}) {
  return (
    <div className="bloqueio-overlay">
      <div className="bloqueio-assinatura">
        <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h1 style={{ fontSize: 20 }}>{sub.no_trial ? 'Escolha seu plano' : 'Assinatura suspensa'}</h1>
          <button className="btn btn-ghost btn-sm" onClick={onSignOut}><LogOut size={14} /> Sair</button>
        </div>
        {sub.is_admin ? (
          <PlanoCobranca sub={sub} onChanged={onChanged} />
        ) : (
          <p className="text-secondary" style={{ lineHeight: 1.5 }}>
            {sub.no_trial
              ? 'A assinatura da sua empresa ainda não foi ativada. Peça a um administrador da conta para escolher um plano.'
              : 'O acesso da sua empresa está suspenso por falta de pagamento. Peça a um administrador da conta para regularizar a assinatura. Os dados continuam guardados.'}
          </p>
        )}
      </div>
    </div>
  )
}
