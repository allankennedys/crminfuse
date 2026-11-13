import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { billingService, trialDays } from '@/services/billingService'
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
  const [dias, setDias] = useState<number | null>(null)
  useEffect(() => { void trialDays().then(setDias) }, [])

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
    <div className="login6">
      <header className="login6-top">
        <img src={theme === 'light' ? '/logo-navy.png' : '/logo.png'} alt="Infuse" />
        <ThemeToggle />
      </header>

      <main className="login6-mid">
        <div className="login6-box">
          <span className="login6-bar" aria-hidden="true" />
          <h1>Entrar<span>.</span></h1>
          <p className="login6-lead">Atendimento e vendas num só lugar.</p>

          <GoogleButton label="Continuar com o Google" onClick={entrarComGoogle} />
          <div className="auth-divisor"><span>ou entre com e-mail</span></div>

          <form onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="lg-email">E-mail</label>
              <input id="lg-email" className="input" type="text" inputMode="email" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="voce@empresa.com.br" required />
            </div>
            <div className="field">
              <div className="login-label-row">
                <label htmlFor="lg-senha">Senha</label>
                <Link to="/esqueci-senha" className="login-forgot">Esqueci minha senha</Link>
              </div>
              <input id="lg-senha" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
            </div>

            {error && <p className="error-text">{error}</p>}
            {naoConfirmado && (
              <p className="error-text" style={{ lineHeight: 1.5 }}>
                Falta confirmar o seu e-mail. Abra o link que enviamos para você.{' '}
                <button type="button" className="link-btn" onClick={reenviar}>Reenviar o e-mail</button>
              </p>
            )}

            <button className="btn btn-primary login-submit" disabled={loading}>
              {loading ? <span className="spinner" /> : 'Entrar'}
            </button>
          </form>

          <p className="login-signup">
            Ainda não usa o Infuse? <Link to="/cadastro">Criar conta da minha empresa</Link>
            {dias ? <span>Teste grátis por {dias} dias, sem cartão.</span> : null}
          </p>
          <p className="login-invite">Sua empresa já usa o Infuse? Peça o link de convite a um administrador.</p>
        </div>
      </main>

      <footer className="login6-bot">
        <span>© {new Date().getFullYear()} Infuse Software</span>
        <span><Link to="/privacidade">Privacidade</Link> · <Link to="/termos">Termos</Link></span>
      </footer>
    </div>
  )
}
