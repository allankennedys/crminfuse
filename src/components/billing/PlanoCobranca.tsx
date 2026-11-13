import { useEffect, useState } from 'react'
import { AlertTriangle, Copy, CreditCard, ExternalLink, QrCode, Smartphone, Users } from 'lucide-react'
import { toast } from '@/store/toastStore'
import { confirmDialog } from '@/store/confirmStore'
import { formatSP } from '@/lib/datetime'
import {
  billingService, formatPrice, type MySubscription, type Plan,
} from '@/services/billingService'

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
  const [pixPlano, setPixPlano] = useState<Plan | null>(null)

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

  async function escolherPix(p: Plan) {
    setBusy(`p-${p.id}`)
    try {
      await billingService.choosePix(p.id)
      setPixPlano(p)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível escolher o Pix')
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

  const copiar = (t: string) => {
    void navigator.clipboard?.writeText(t).then(() => toast.success('Copiado.')).catch(() => toast.error('Não consegui copiar.'))
  }

  const dTeste = diasAte(sub.trial_ends_at)
  const noCartao = sub.payment_mode === 'cartao' && sub.has_billing
  const noPix = sub.payment_mode === 'pix'
  const valorAtual = pixPlano ?? sub.plan
  const pix = sub.pix

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
          {noPix && (
            <button className="btn btn-ghost btn-sm" onClick={() => setPixPlano(sub.plan)}>
              <QrCode size={14} /> Ver como pagar por Pix
            </button>
          )}
        </div>
      </section>

      {pixPlano && (
        <section className="card">
          <h3 className="card-title"><QrCode size={15} /> Pagar por Pix</h3>
          {pix?.pix_key ? (
            <div style={{ display: 'grid', gap: 10 }}>
              <p className="text-secondary" style={{ lineHeight: 1.5 }}>
                Faça um Pix de <strong>{formatPrice(valorAtual.price_cents)}</strong> para a chave abaixo e informe o código no campo de mensagem do Pix.
              </p>
              <div className="field" style={{ margin: 0 }}>
                <label>Chave Pix{pix.pix_holder ? ` (${pix.pix_holder})` : ''}</label>
                <div className="flex" style={{ gap: 6 }}>
                  <input className="input" readOnly value={pix.pix_key} onFocus={(e) => e.currentTarget.select()} />
                  <button className="btn btn-ghost btn-sm" onClick={() => copiar(pix.pix_key!)} aria-label="Copiar chave"><Copy size={14} /></button>
                </div>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Código da sua empresa</label>
                <div className="flex" style={{ gap: 6 }}>
                  <input className="input" readOnly value={sub.reference} />
                  <button className="btn btn-ghost btn-sm" onClick={() => copiar(sub.reference)} aria-label="Copiar código"><Copy size={14} /></button>
                </div>
              </div>
              <p className="text-muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                Depois de pagar, {pix.pix_contact ? <>envie o comprovante para <strong>{pix.pix_contact}</strong>. </> : 'envie o comprovante ao suporte. '}
                A liberação é feita por uma pessoa, em até 1 dia útil. O acesso continua normal até lá.
              </p>
            </div>
          ) : (
            <p className="text-muted">O pagamento por Pix ainda não foi configurado. Fale com o suporte.</p>
          )}
        </section>
      )}

      <section className="card">
        <h3 className="card-title">{sub.status === 'trial' ? 'Escolher um plano' : 'Trocar de plano'}</h3>
        <div className="plano-grid">
          {plans.map((p) => {
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
                <button className="btn btn-sm btn-ghost" disabled={busy !== null} onClick={() => escolherPix(p)}>
                  {busy === `p-${p.id}` ? <span className="spinner" /> : 'Pagar por Pix'}
                </button>
              </div>
            )
          })}
        </div>
      </section>
    </>
  )
}
