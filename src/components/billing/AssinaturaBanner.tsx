import { AlertTriangle, Clock } from 'lucide-react'
import type { MySubscription } from '@/services/billingService'

/** Faixa de aviso sob o topo: teste acabando, pagamento atrasado ou modo leitura. */
export function AssinaturaBanner({ sub, onOpenPlano }: { sub: MySubscription; onOpenPlano: () => void }) {
  if (sub.courtesy) return null
  const dias = sub.trial_ends_at ? Math.ceil((new Date(sub.trial_ends_at).getTime() - Date.now()) / 86_400_000) : null

  let texto: string | null = null
  let alerta = false
  if (sub.acesso === 'leitura') {
    texto = 'Conta em modo leitura: não dá para enviar nem editar até regularizar.'
    alerta = true
  } else if (sub.status === 'atrasada') {
    texto = 'Pagamento em atraso. Regularize para não perder o acesso.'
    alerta = true
  } else if (sub.payment_mode === 'pix' && sub.status === 'ativa' && sub.current_period_end) {
    // Pix não tem gateway mandando lembrete: o aviso é daqui.
    const venc = Math.ceil((new Date(sub.current_period_end).getTime() - Date.now()) / 86_400_000)
    if (venc <= 5) texto = venc > 0 ? `Sua assinatura vence em ${venc} dia${venc > 1 ? 's' : ''}. Fale com o nosso time para renovar e não perder o acesso.` : 'Sua assinatura venceu hoje. Fale com o nosso time para renovar e não perder o acesso.'
    alerta = venc <= 2
  } else if (sub.status === 'trial' && dias !== null) {
    texto = dias > 0 ? `Teste grátis: ${dias} dia${dias > 1 ? 's' : ''} restante${dias > 1 ? 's' : ''}.` : 'O teste acabou hoje.'
  }
  if (!texto) return null

  return (
    <div className={`assinatura-banner${alerta ? ' alerta' : ''}`} role="status">
      {alerta ? <AlertTriangle size={14} /> : <Clock size={14} />}
      <span>{texto}</span>
      {sub.is_admin && <button className="btn btn-ghost btn-sm" onClick={onOpenPlano}>Ver plano</button>}
    </div>
  )
}
