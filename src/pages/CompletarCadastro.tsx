import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useAuthStore } from '@/store/authStore'
import { ThemeToggle } from '@/components/ThemeToggle'
import { useTheme } from '@/lib/theme'
import { billingService, formatPrice, trialDays, type Plan } from '@/services/billingService'

/** Guarda o convite enquanto a pessoa vai e volta do Google. */
export const CONVITE_PENDENTE = 'infuse-convite-pendente'

function mascaraDoc(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 14)
  if (d.length <= 11) return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1-$2')
  return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2')
}

/**
 * Quem entrou com o Google mas ainda não pertence a nenhuma empresa cai aqui:
 * se veio de um convite, entra na empresa convidante; senão, cadastra a própria
 * empresa (CPF/CNPJ e plano, como no cadastro normal).
 */
export function CompletarCadastroPage() {
  const theme = useTheme((s) => s.theme)
  const session = useAuthStore((s) => s.session)
  const recarregar = useAuthStore((s) => s.recarregarPerfil)
  const signOut = useAuthStore((s) => s.signOut)
  const meta = (session?.user.user_metadata ?? {}) as { full_name?: string; name?: string }
  const [plans, setPlans] = useState<Plan[]>([])
  const [planId, setPlanId] = useState('profissional')
  const [f, setF] = useState({ organization_name: '', full_name: meta.full_name ?? meta.name ?? '', doc: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [convite, setConvite] = useState<boolean>(() => {
    try { return Boolean(localStorage.getItem(CONVITE_PENDENTE)) } catch { return false }
  })
  const tentou = useRef(false)

  const [dias, setDias] = useState<number | null>(null)
  useEffect(() => { billingService.listPlans().then(setPlans); void trialDays().then(setDias) }, [])

  // Veio de um convite: aceita sozinho.
  useEffect(() => {
    if (!convite || tentou.current) return
    tentou.current = true
    let token = ''
    try { token = localStorage.getItem(CONVITE_PENDENTE) ?? '' } catch { /* sem armazenamento */ }
    billingService.acceptInviteGoogle(token)
      .then(async () => { try { localStorage.removeItem(CONVITE_PENDENTE) } catch { /* ok */ } await recarregar() })
      .catch((e) => {
        try { localStorage.removeItem(CONVITE_PENDENTE) } catch { /* ok */ }
        setError(e instanceof Error ? e.message : 'Não foi possível aceitar o convite.')
        setConvite(false)
      })
  }, [convite, recarregar])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await billingService.completeGoogleSignup({ ...f, doc: f.doc.replace(/\D/g, ''), plan_id: planId })
      await recarregar()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível criar a conta')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-theme"><ThemeToggle /></div>
      <div className="auth-card signup-card">
        <div className="sidebar-logo" style={{ justifyContent: 'center', paddingBottom: 16 }}>
          <img src={theme === 'light' ? '/logo-navy.png' : '/logo.png'} alt="Infuse" className="brand-logo" style={{ height: 38 }} />
        </div>

        {convite ? (
          <div className="center-loader" style={{ flexDirection: 'column', gap: 12 }}>
            <div className="spinner lg" />
            <p className="text-secondary">Entrando na empresa que te convidou…</p>
          </div>
        ) : (
          <>
            <h1 style={{ fontSize: 18, textAlign: 'center', marginBottom: 4 }}>Complete seu cadastro</h1>
            <p className="text-secondary" style={{ textAlign: 'center', fontSize: 13, lineHeight: 1.5, marginBottom: 16 }}>
              Você entrou como <strong>{session?.user.email}</strong>. Para criar a conta da sua empresa{dias ? `, ${dias} dias grátis e sem cartão,` : ''} preencha abaixo.
              Foi convidado para uma empresa que já usa o Infuse? Abra o link do convite que recebeu por e-mail.
            </p>

            {plans.length > 0 && (
              <div className="signup-plans" role="radiogroup" aria-label="Plano">
                {plans.map((p) => (
                  <button key={p.id} type="button" role="radio" aria-checked={planId === p.id} className={`signup-plan${planId === p.id ? ' active' : ''}`} onClick={() => setPlanId(p.id)}>
                    <strong>{p.name}</strong>
                    <span className="signup-price">{formatPrice(p.price_cents)}<small>/mês</small></span>
                  </button>
                ))}
              </div>
            )}

            <form onSubmit={submit}>
              <div className="field">
                <label htmlFor="cc-empresa">Nome da empresa</label>
                <input id="cc-empresa" className="input" value={f.organization_name} onChange={(e) => setF({ ...f, organization_name: e.target.value })} maxLength={80} required />
              </div>
              <div className="field">
                <label htmlFor="cc-doc">CNPJ ou CPF</label>
                <input id="cc-doc" className="input" inputMode="numeric" value={f.doc} onChange={(e) => setF({ ...f, doc: mascaraDoc(e.target.value) })} required />
              </div>
              <div className="field">
                <label htmlFor="cc-nome">Seu nome</label>
                <input id="cc-nome" className="input" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} maxLength={80} required />
              </div>
              {error && <p className="error-text">{error}</p>}
              <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }} disabled={loading}>
                {loading ? <span className="spinner" /> : dias ? 'Criar conta e começar o teste' : 'Criar conta'}
              </button>
            </form>
            <p style={{ textAlign: 'center', marginTop: 16, fontSize: 12.5 }} className="text-secondary">
              Não é essa conta? <button type="button" className="link-btn" onClick={() => { void signOut() }}>Sair</button>
            </p>
          </>
        )}
      </div>
    </div>
  )
}
