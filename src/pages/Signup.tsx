import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Check } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { ThemeToggle } from '@/components/ThemeToggle'
import { useTheme } from '@/lib/theme'
import { billingService, formatPrice, type Plan } from '@/services/billingService'

/** "12345678000199" → "12.345.678/0001-99"; CPF com 11 dígitos. Só enfeita: o servidor valida. */
function mascaraDoc(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 14)
  if (d.length <= 11) {
    return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1-$2')
  }
  return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2')
}

/** Cadastro de uma empresa nova: 7 dias grátis, sem cartão. */
export function SignupPage() {
  const theme = useTheme((s) => s.theme)
  const signIn = useAuthStore((s) => s.signIn)
  const navigate = useNavigate()
  const [plans, setPlans] = useState<Plan[]>([])
  const [planId, setPlanId] = useState('profissional')
  const [f, setF] = useState({ organization_name: '', full_name: '', username: '', email: '', doc: '', password: '', website: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => { billingService.listPlans().then(setPlans) }, [])
  const set = (k: keyof typeof f, v: string) => setF((cur) => ({ ...cur, [k]: v }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await billingService.signup({ ...f, doc: f.doc.replace(/\D/g, ''), plan_id: planId })
      await signIn(f.username, f.password)
      navigate('/crm')
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
        <h1 style={{ fontSize: 18, textAlign: 'center', marginBottom: 4 }}>Teste grátis por 7 dias</h1>
        <p className="text-secondary" style={{ textAlign: 'center', fontSize: 13, marginBottom: 16 }}>
          Sem cartão. Você escolhe o plano depois, se gostar.
        </p>

        {plans.length > 0 && (
          <div className="signup-plans" role="radiogroup" aria-label="Plano">
            {plans.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={planId === p.id}
                className={`signup-plan${planId === p.id ? ' active' : ''}`}
                onClick={() => setPlanId(p.id)}
              >
                <strong>{p.name}</strong>
                <span className="signup-price">{formatPrice(p.price_cents)}<small>/mês</small></span>
                <span><Check size={12} /> {p.max_whatsapps} WhatsApp{p.max_whatsapps > 1 ? 's' : ''}</span>
                <span><Check size={12} /> {p.max_agents} usuários</span>
              </button>
            ))}
          </div>
        )}

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="su-empresa">Nome da empresa</label>
            <input id="su-empresa" className="input" value={f.organization_name} onChange={(e) => set('organization_name', e.target.value)} maxLength={80} required />
          </div>
          <div className="field">
            <label htmlFor="su-doc">CNPJ ou CPF</label>
            <input id="su-doc" className="input" inputMode="numeric" value={f.doc} onChange={(e) => set('doc', mascaraDoc(e.target.value))} required />
          </div>
          <div className="field">
            <label htmlFor="su-nome">Seu nome</label>
            <input id="su-nome" className="input" value={f.full_name} onChange={(e) => set('full_name', e.target.value)} maxLength={80} required />
          </div>
          <div className="field">
            <label htmlFor="su-email">E-mail</label>
            <input id="su-email" className="input" type="email" autoCapitalize="none" value={f.email} onChange={(e) => set('email', e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="su-user">Usuário para entrar</label>
            <input id="su-user" className="input" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={f.username} onChange={(e) => set('username', e.target.value.toLowerCase())} placeholder="seu.usuario" required />
          </div>
          <div className="field">
            <label htmlFor="su-senha">Senha (mínimo 8 caracteres)</label>
            <input id="su-senha" className="input" type="password" value={f.password} onChange={(e) => set('password', e.target.value)} minLength={8} required />
          </div>
          {/* Isca para robôs: escondida de gente, que não preenche. */}
          <input
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            value={f.website}
            onChange={(e) => set('website', e.target.value)}
            style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
          />

          {error && <p className="error-text">{error}</p>}

          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }} disabled={loading}>
            {loading ? <span className="spinner" /> : 'Criar conta e começar o teste'}
          </button>
        </form>

        <p style={{ textAlign: 'center', marginTop: 16, fontSize: 12.5 }} className="text-secondary">
          Já tem conta? <Link to="/login">Entrar</Link>
        </p>
      </div>
    </div>
  )
}
