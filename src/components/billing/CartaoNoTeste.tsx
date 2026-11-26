import { useEffect, useState } from 'react'
import { CreditCard, ShieldCheck } from 'lucide-react'
import { toast } from '@/store/toastStore'
import { formatSP } from '@/lib/datetime'
import { billingService, formatPrice, type MySubscription } from '@/services/billingService'

const CHAVE = 'infuse-cartao-teste-adiado'

/** Quem tem teste correndo, é administrador e ainda não cadastrou cartão nem escolheu Pix. */
export function precisaCartaoNoTeste(sub: MySubscription): boolean {
  return sub.is_admin && sub.status === 'trial' && !sub.courtesy && !sub.no_trial
    && !sub.has_billing && sub.payment_mode !== 'pix' && sub.acesso === 'total'
}

/**
 * Janela que aparece no teste grátis pedindo o cartão: nada é cobrado agora, e o
 * Stripe faz a primeira cobrança sozinho quando o teste acaba (e todo mês depois).
 * "Agora não" adia por um dia; o aviso volta enquanto não houver cartão.
 */
export function CartaoNoTeste({ sub, onOpenPlano }: { sub: MySubscription; onOpenPlano: () => void }) {
  const [aberto, setAberto] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!precisaCartaoNoTeste(sub)) { setAberto(false); return }
    let adiado = 0
    try { adiado = Number(localStorage.getItem(CHAVE) ?? 0) } catch { /* sem armazenamento */ }
    setAberto(Date.now() > adiado)
  }, [sub])

  if (!aberto) return null

  const fim = sub.trial_ends_at ? formatSP(sub.trial_ends_at).slice(0, 10) : null

  async function cadastrar() {
    setBusy(true)
    try {
      window.location.href = await billingService.checkout(sub.plan.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível abrir o pagamento')
      setBusy(false)
    }
  }

  function depois() {
    try { localStorage.setItem(CHAVE, String(Date.now() + 86_400_000)) } catch { /* ok */ }
    setAberto(false)
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="cnt-titulo" style={{ zIndex: 790 }}>
      <div className="modal" style={{ maxWidth: 440 }}>
        <h2 id="cnt-titulo" style={{ fontSize: 18, display: 'flex', gap: 8, alignItems: 'center' }}>
          <CreditCard size={18} /> Deixe a cobrança no automático
        </h2>
        <p className="text-secondary" style={{ lineHeight: 1.55, margin: '10px 0' }}>
          Cadastre o cartão agora e <strong>não pague nada hoje</strong>. Seu teste grátis segue
          {fim ? <> até <strong>{fim}</strong></> : null}; depois disso o plano <strong>{sub.plan.name}</strong> ({formatPrice(sub.plan.price_cents)}/mês)
          é cobrado sozinho, todo mês, sem você precisar lembrar. Sem fidelidade: cancele quando quiser em Configurações → Plano e cobrança.
        </p>
        <p className="text-muted" style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 14 }}>
          <ShieldCheck size={14} /> O cartão é digitado na página segura do Stripe; o Infuse nunca vê os dados.
        </p>
        <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={cadastrar} disabled={busy}>
            {busy ? <span className="spinner" /> : 'Cadastrar cartão (grátis até o fim do teste)'}
          </button>
          <button className="btn btn-ghost" onClick={() => { depois(); onOpenPlano() }} disabled={busy}>Trocar de plano</button>
          <button className="btn btn-ghost" onClick={depois} disabled={busy}>Agora não</button>
        </div>
      </div>
    </div>
  )
}
