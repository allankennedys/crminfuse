import { useCallback, useEffect, useState } from 'react'
import { Building2 } from 'lucide-react'
import { toast } from '@/store/toastStore'
import { confirmDialog } from '@/store/confirmStore'
import { formatSP } from '@/lib/datetime'
import {
  billingService, formatPrice, type Plan, type PlatformOrg, type SubscriptionStatus,
} from '@/services/billingService'

/**
 * Configurações → Plataforma (só o dono, secret OWNER_EMAIL): organizações com
 * plano, status e uso; trocar plano, status, cortesia e somar dias de teste;
 * editar os planos (preço e limites). Nada disso precisa de SQL.
 */
export function PlataformaSettings() {
  const [orgs, setOrgs] = useState<PlatformOrg[] | null>(null)
  const [plans, setPlans] = useState<Plan[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    billingService.platformOrgs().then(setOrgs).catch((e) => { toast.error(e instanceof Error ? e.message : 'Falha ao listar'); setOrgs([]) })
    billingService.platformPlans().then(setPlans).catch(() => setPlans([]))
  }, [])
  useEffect(load, [load])

  async function mudar(orgId: string, patch: Parameters<typeof billingService.setSubscription>[0] extends infer P ? Partial<P> : never) {
    setBusy(orgId)
    try {
      await billingService.setSubscription({ organization_id: orgId, ...patch })
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar')
    } finally {
      setBusy(null)
    }
  }

  async function registrar(o: PlatformOrg) {
    if (!(await confirmDialog({
      title: 'Registrar pagamento por Pix',
      message: `Confirma que o Pix de "${o.name}" foi recebido? A assinatura fica ativa e o período avança 1 mês.`,
      confirmLabel: 'Registrar',
    }))) return
    setBusy(o.id)
    try {
      await billingService.registerPayment(o.id, 1)
      toast.success('Pagamento registrado.')
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao registrar')
    } finally {
      setBusy(null)
    }
  }

  async function salvarPlano(p: Plan) {
    try {
      await billingService.savePlan(p)
      toast.success('Plano salvo.')
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar o plano')
    }
  }

  return (
    <>
      <section className="card">
        <h3 className="card-title"><Building2 size={15} /> Organizações</h3>
        {orgs === null ? <div className="spinner" /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Empresa</th><th>Plano</th><th>Situação</th><th>Uso</th><th>Acesso</th><th>Teste até</th><th /></tr>
              </thead>
              <tbody>
                {orgs.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <strong>{o.name}</strong>
                      <div className="text-muted" style={{ fontSize: 11 }}>{o.subscription?.billing_email ?? 'sem e-mail'} · criada {formatSP(o.created_at).slice(0, 10)}</div>
                    </td>
                    <td>
                      <select className="input" value={o.subscription?.plan_id ?? ''} disabled={busy === o.id} onChange={(e) => mudar(o.id, { plan_id: e.target.value })} aria-label="Plano">
                        {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </td>
                    <td>
                      <select className="input" value={o.subscription?.status ?? 'trial'} disabled={busy === o.id} onChange={(e) => mudar(o.id, { status: e.target.value as SubscriptionStatus })} aria-label="Situação">
                        <option value="trial">Teste</option><option value="ativa">Ativa</option>
                        <option value="atrasada">Atrasada</option><option value="cancelada">Cancelada</option>
                      </select>
                      <label className="checkbox-row" style={{ marginTop: 4 }}>
                        <input type="checkbox" checked={Boolean(o.subscription?.courtesy)} disabled={busy === o.id} onChange={(e) => mudar(o.id, { courtesy: e.target.checked })} />
                        <span>Cortesia</span>
                      </label>
                    </td>
                    <td>{o.uso.whatsapps} núm. · {o.uso.agents} usuários</td>
                    <td><span className={`badge ${o.acesso === 'total' ? 'badge-green' : 'badge-yellow'}`}>{o.acesso}</span></td>
                    <td>{o.subscription?.trial_ends_at ? formatSP(o.subscription.trial_ends_at).slice(0, 10) : '—'}</td>
                    <td>
                      <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
                        <button className="btn btn-primary btn-sm" disabled={busy === o.id} onClick={() => registrar(o)}>Registrar Pix</button>
                        <button className="btn btn-ghost btn-sm" disabled={busy === o.id} onClick={() => mudar(o.id, { add_trial_days: 7 })}>+7 dias de teste</button>
                      </div>
                      {o.subscription?.current_period_end && (
                        <div className="text-muted" style={{ fontSize: 11, marginTop: 3 }}>
                          {o.subscription.payment_mode === 'pix' ? 'Pix' : o.subscription.payment_mode === 'cartao' ? 'Cartão' : ''} · pago até {formatSP(o.subscription.current_period_end).slice(0, 10)}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <PixSettingsCard />

      <section className="card">
        <h3 className="card-title">Planos</h3>
        <div style={{ display: 'grid', gap: 10 }}>
          {plans.map((p) => <PlanoEditor key={p.id} plan={p} onSave={salvarPlano} />)}
        </div>
        <p className="text-muted" style={{ fontSize: 12, marginTop: 10 }}>
          Mudar o preço aqui vale para novos cadastros e novas assinaturas; quem já assina no cartão continua com o valor combinado até trocar de plano.
        </p>
      </section>
    </>
  )
}

/** Chave Pix e contato mostrados ao cliente que escolhe pagar por Pix. */
function PixSettingsCard() {
  const [s, setS] = useState({ pix_key: '', pix_holder: '', pix_contact: '' })
  const [salvo, setSalvo] = useState('')
  useEffect(() => {
    billingService.pixSettings().then((r) => {
      const v = { pix_key: r.pix_key ?? '', pix_holder: r.pix_holder ?? '', pix_contact: r.pix_contact ?? '' }
      setS(v)
      setSalvo(JSON.stringify(v))
    }).catch(() => {})
  }, [])
  async function salvar() {
    try {
      await billingService.savePixSettings(s)
      setSalvo(JSON.stringify(s))
      toast.success('Dados do Pix salvos.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar')
    }
  }
  return (
    <section className="card">
      <h3 className="card-title">Pix (recebimento manual)</h3>
      <p className="text-muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
        Aparece para quem escolhe pagar por Pix. Depois de receber, use "Registrar Pix" na organização.
      </p>
      <div className="flex" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="field" style={{ margin: 0, flex: 1, minWidth: 200 }}><label>Chave Pix</label>
          <input className="input" value={s.pix_key} onChange={(e) => setS({ ...s, pix_key: e.target.value })} /></div>
        <div className="field" style={{ margin: 0, flex: 1, minWidth: 160 }}><label>Titular</label>
          <input className="input" value={s.pix_holder} onChange={(e) => setS({ ...s, pix_holder: e.target.value })} /></div>
        <div className="field" style={{ margin: 0, flex: 1, minWidth: 200 }}><label>Para onde enviar o comprovante</label>
          <input className="input" value={s.pix_contact} onChange={(e) => setS({ ...s, pix_contact: e.target.value })} placeholder="WhatsApp ou e-mail" /></div>
        <button className="btn btn-primary btn-sm" disabled={JSON.stringify(s) === salvo} onClick={salvar}>Salvar</button>
      </div>
    </section>
  )
}

function PlanoEditor({ plan, onSave }: { plan: Plan; onSave: (p: Plan) => void }) {
  const [p, setP] = useState(plan)
  const sujo = JSON.stringify(p) !== JSON.stringify(plan)
  const num = (v: string) => Number(v.replace(/\D/g, '')) || 0
  return (
    <div className="flex" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <div className="field" style={{ margin: 0 }}><label>Nome</label>
        <input className="input" style={{ width: 150 }} value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></div>
      <div className="field" style={{ margin: 0 }}><label>Preço (centavos)</label>
        <input className="input" style={{ width: 110 }} inputMode="numeric" value={p.price_cents} onChange={(e) => setP({ ...p, price_cents: num(e.target.value) })} /></div>
      <div className="field" style={{ margin: 0 }}><label>WhatsApps</label>
        <input className="input" style={{ width: 80 }} inputMode="numeric" value={p.max_whatsapps} onChange={(e) => setP({ ...p, max_whatsapps: num(e.target.value) })} /></div>
      <div className="field" style={{ margin: 0 }}><label>Usuários</label>
        <input className="input" style={{ width: 80 }} inputMode="numeric" value={p.max_agents} onChange={(e) => setP({ ...p, max_agents: num(e.target.value) })} /></div>
      <label className="checkbox-row"><input type="checkbox" checked={p.active !== false} onChange={(e) => setP({ ...p, active: e.target.checked })} /><span>À venda</span></label>
      <span className="text-muted" style={{ fontSize: 12 }}>{formatPrice(p.price_cents)}</span>
      <button className="btn btn-primary btn-sm" disabled={!sujo} onClick={() => onSave(p)}>Salvar</button>
    </div>
  )
}
