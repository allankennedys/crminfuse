import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { billingService } from '@/services/billingService'
import { toast } from '@/store/toastStore'
import { GoogleButton } from '@/components/GoogleButton'
import { ThemeToggle } from '@/components/ThemeToggle'
import { useTheme } from '@/lib/theme'

export function LoginPage() {
  const theme = useTheme((s) => s.theme)
  const signIn = useAuthStore((s) => s.signIn)
  const signInWithGoogle = useAuthStore((s) => s.signInWithGoogle)
  const session = useAuthStore((s) => s.session)
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const [naoConfirmado, setNaoConfirmado] = useState(false)

  // Volta do Google: já logado segue para o CRM; se deu erro, explica em português.
  useEffect(() => {
    if (session) navigate('/crm', { replace: true })
  }, [session, navigate])
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, '') + '&' + window.location.search.replace(/^\?/, ''))
    const desc = (params.get('error_description') ?? '').toLowerCase()
    if (!params.get('error') && !desc) return
    window.history.replaceState({}, '', window.location.pathname)
    setError(
      'Não foi possível entrar com o Google. Tente de novo.',
    )
  }, [])

  async function entrarComGoogle() {
    setError('')
    try { await signInWithGoogle() } catch (err) { setError(err instanceof Error ? err.message : 'Falha ao entrar com o Google.') }
  }

  async function reenviar() {
    try {
      await billingService.sendVerification(username.trim())
      toast.success('Enviamos um novo link. Veja sua caixa de entrada e o spam.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível reenviar agora.')
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setNaoConfirmado(false)
    setLoading(true)
    try {
      await signIn(username, password)
      // Serve os dois domínios sem alteração: na build do CRM não existe rota
      // /dashboard, então o catch-all do App redireciona para /crm.
      navigate('/crm')
    } catch (err) {
      const m = err instanceof Error ? err.message : 'Falha no login'
      if (m === 'EMAIL_NAO_CONFIRMADO') setNaoConfirmado(true)
      else setError(m)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-theme"><ThemeToggle /></div>
      <div className="auth-card">
        <div className="sidebar-logo" style={{ justifyContent: 'center', paddingBottom: 28 }}>
          <img src={theme === 'light' ? '/logo-navy.png' : '/logo.png'} alt="Infuse" className="brand-logo" style={{ height: 38 }} />
        </div>

        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="lg-email">E-mail</label>
            <input id="lg-email" className="input" type="text" inputMode="email" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="voce@empresa.com.br" required />
          </div>
          <div className="field">
            <label>Senha</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
            <div style={{ textAlign: 'right', marginTop: 6, fontSize: 12.5 }}>
              <Link to="/esqueci-senha">Esqueci minha senha</Link>
            </div>
          </div>

          {error && <p className="error-text">{error}</p>}
          {naoConfirmado && (
            <p className="error-text" style={{ lineHeight: 1.5 }}>
              Falta confirmar o seu e-mail. Abra o link que enviamos para você.{' '}
              <button type="button" className="link-btn" onClick={reenviar}>Reenviar o e-mail</button>
            </p>
          )}

          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }} disabled={loading}>
            {loading ? <span className="spinner" /> : 'Entrar'}
          </button>
        </form>

        <div className="auth-divisor"><span>ou</span></div>

        <div style={{ marginBottom: 10 }}><GoogleButton label="Entrar com o Google" onClick={entrarComGoogle} /></div>

        <Link to="/cadastro" className="btn btn-ghost" style={{ width: '100%', justifyContent: 'center' }}>
          Criar conta da minha empresa
        </Link>
        <p className="text-muted" style={{ textAlign: 'center', marginTop: 8, fontSize: 12.5 }}>Teste grátis por 7 dias, sem cartão.</p>
        <p className="text-muted" style={{ textAlign: 'center', marginTop: 16, fontSize: 12.5, lineHeight: 1.5 }}>
          Sua empresa já usa o Infuse? Peça o link de convite a um administrador.
        </p>
      </div>
    </div>
  )
}
