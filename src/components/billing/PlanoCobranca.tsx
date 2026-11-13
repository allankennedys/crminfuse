import { useEffect, useState } from 'react'
import { AlertTriangle, CreditCard, ExternalLink, MessageCircle, Smartphone, Users } from 'lucide-react'
import { toast } from '@/store/toastStore'
import { confirmDialog } from '@/store/confirmStore'
import { formatSP } from '@/lib/datetime'
import {
  billingService, formatPrice, type MySubscription, type Plan,
} from '@/services/billingService'

/** Outras formas de pagamento (Pix etc.) são combinadas direto com o time. */
const WHATS_TIME = 'https://wa.me/5575982938031'

const STATUS_LABEL: Record<string, string> = {
  trial: 'Teste grátis', ativa: 'Ativa', atrasada: 'Pagamento atrasado', cancelada: 'Cancelada',
}

const diasAte = (iso: string | null) =>
  iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000) : null

function Uso({ icon, label, usado, max }: { icon: React.ReactNode; label: string; usado: number; max: number }) {
  const pct = Math.min(100, Math.round((usado / Math.max(1, max)) * 100))
  const cheio = usado >= max
  return (
    <div className="plano-uso">
      <div className="plano-uso-top">
        <span>{icon} {label}</span>
        <strong>{usado} de {max}</strong>
      </div>
      <div className="at-reason-bar-track">
        <div style={{ width: `${pct}%`, background: cheio ? 'var(--warning)' : 'var(--primary)' }} />
      </div>
    </div>
  )
}

/**
 * Configurações → Plano e cobrança (147). Cartão: pagamento no Stripe, com
 * cobrança automática todo mês. Pix: o cliente paga pela chave da empresa e o
 * dono da plataforma registra o pagamento (aba Plataforma).
 */
export function PlanoCobranca({ sub, onChanged }: { sub: MySubscription; onChanged: () => void }) {
  const [plans, setPlans] = useState<Plan[]>([])
  const [cartaoOk, setCartaoOk] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    billingService.listPlans().then(setPlans)
    billingService.billingConfigured().then(setCartaoOk)
  }, [])

  // Voltou do Stripe: recarrega (o aviso de pagamento pode levar alguns segundos).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('assinatura')
    if (q === 'ok') {
      toast.success('Pagamento recebido. A confirmação pode levar alguns instantes.')
      const t = setTimeout(onChanged, 4000)
      window.history.replaceState({}, '', window.location.pathname)
      return () => clearTimeout(t)
    }
    if (q === 'cancelada') window.history.replaceState({}, '', window.location.pathname)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const abrir = (url: string) => { window.location.href = url }

  async function cartao(p: Plan) {
    setBusy(`c-${p.id}`)
    try {
      const url = await billingService.checkout(p.id)
      if (url.includes('/crm')) { toast.success('Plano alterado.'); onChanged() } else abrir(url)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível iniciar o pagamento')
    } finally {
      setBusy(null)
    }
  }


  async function gerenciarCartao() {
    setBusy('portal')
    try { abrir(await billingService.portal()) }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Não foi possível abrir o portal'); setBusy(null) }
  }

  async function cancelar() {
    if (!(await confirmDialog({
      title: 'Cancelar assinatura',
      message: 'O acesso continua até o fim do período já pago. Depois a conta fica bloqueada, e os dados são guardados por 90 dias.',
      confirmLabel: 'Cancelar assinatura', danger: true,
    }))) return
    setBusy('cancelar')
    try {
      await billingService.cancel()
      toast.success('Cancelamento agendado para o fim do período.')
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível cancelar')
    } finally {
      setBusy(null)
    }
  }


  const dTeste = diasAte(sub.trial_ends_at)
  const noCartao = sub.payment_mode === 'cartao' && sub.has_billing
  const noPix = sub.payment_mode === 'pix'
  // Em teste (ou sem assinatura paga) mostra todos; assinante vê só os mais caros (upgrade).
  const emTeste = sub.status === 'trial' || sub.status === 'cancelada' || sub.courtesy
  const opcoes = emTeste ? plans : plans.filter((p) => p.price_cents > sub.plan.price_cents)

  return (
    <>
      <section className="card">
        <h3 className="card-title"><CreditCard size={15} /> Plano e cobrança</h3>

        <div className="plano-resumo">
          <div>
            <div className="plano-nome">{sub.plan.name} <span className="text-muted">· {formatPrice(sub.plan.price_cents)}/mês</span></div>
            <span className={`badge ${sub.status === 'ativa' ? 'badge-green' : sub.status === 'trial' ? 'badge-blue' : 'badge-yellow'}`}>
              {sub.courtesy ? 'Cortesia' : STATUS_LABEL[sub.status]}
            </span>
            {!sub.courtesy && sub.payment_mode && (
              <span className="text-muted" style={{ fontSize: 12, marginLeft: 8 }}>{sub.payment_mode === 'pix' ? 'Pagamento por Pix' : 'Cartão'}</span>
            )}
          </div>
          <div className="text-secondary" style={{ fontSize: 12.5, textAlign: 'right' }}>
            {sub.courtesy ? 'Sem cobrança.'
              : sub.status === 'trial' && dTeste !== null
                ? dTeste > 0 ? `O teste acaba em ${formatSP(sub.trial_ends_at!).slice(0, 10)} (${dTeste} dia${dTeste > 1 ? 's' : ''}).` : 'O teste acabou.'
                : sub.current_period_end ? `${sub.cancel_at_period_end ? 'Cancela em' : noPix ? 'Pago até' : 'Próxima cobrança em'} ${formatSP(sub.current_period_end).slice(0, 10)}.` : null}
          </div>
        </div>

        {sub.acesso !== 'total' && (
          <div className="plano-alerta">
            <AlertTriangle size={16} />
            <span>
              {sub.acesso === 'leitura'
                ? 'Sua conta está em modo leitura: dá para ver tudo, mas não enviar mensagens nem editar. Escolha um plano ou regularize o pagamento para voltar ao normal.'
                : 'Sua conta está suspensa. Escolha um plano ou regularize o pagamento para voltar a usar. Seus dados continuam guardados.'}
            </span>
          </div>
        )}

        <div className="plano-usos">
          <Uso icon={<Smartphone size={13} />} label="WhatsApps conectados" usado={sub.uso.whatsapps} max={sub.plan.max_whatsapps} />
          <Uso icon={<Users size={13} />} label="Usuários" usado={sub.uso.agents} max={sub.plan.max_agents} />
        </div>

        <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
          {noCartao && (
            <button className="btn btn-ghost btn-sm" onClick={gerenciarCartao} disabled={busy !== null}>
              <ExternalLink size={14} /> Trocar cartão, ver faturas
            </button>
          )}
          {noCartao && !sub.cancel_at_period_end && sub.status !== 'cancelada' && (
            <button className="btn btn-ghost btn-sm" onClick={cancelar} disabled={busy !== null}>Cancelar assinatura</button>
          )}
          {noPix && <a className="btn btn-ghost btn-sm" href={WHATS_TIME} target="_blank" rel="noreferrer"><MessageCircle size={14} /> Falar com o time</a>}
        </div>
        <p className="text-muted" style={{ fontSize: 12.5, marginTop: 12 }}>
          Quer pagar de outra forma, como Pix? <a href={WHATS_TIME} target="_blank" rel="noreferrer">Fale com o nosso time no WhatsApp</a>.
        </p>
      </section>

      {opcoes.length > 0 && <section className="card">
        <h3 className="card-title">{emTeste ? 'Escolher um plano' : 'Fazer upgrade'}</h3>
        <div className="plano-grid">
          {opcoes.map((p) => {
            const atual = p.id === sub.plan.id && (sub.status === 'ativa' || sub.status === 'atrasada') && !sub.courtesy
            return (
              <div key={p.id} className={`plano-card${p.id === sub.plan.id ? ' atual' : ''}`}>
                <strong>{p.name}</strong>
                <span className="plano-preco">{formatPrice(p.price_cents)}<small>/mês</small></span>
                <span>{p.max_whatsapps} WhatsApp{p.max_whatsapps > 1 ? 's' : ''}</span>
                <span>{p.max_agents} usuários</span>
                <button
                  className={`btn btn-sm ${atual && noCartao ? 'btn-ghost' : 'btn-primary'}`}
                  disabled={(atual && noCartao) || busy !== null || cartaoOk === false}
                  onClick={() => cartao(p)}
                  title={cartaoOk === false ? 'O pagamento por cartão ainda não foi configurado' : undefined}
                >
                  {busy === `c-${p.id}` ? <span className="spinner" /> : atual && noCartao ? 'Plano atual' : noCartao ? 'Trocar (cartão)' : 'Assinar no cartão'}
                </button>
              </div>
            )
          })}
        </div>
      </section>}
    </>
  )
}
