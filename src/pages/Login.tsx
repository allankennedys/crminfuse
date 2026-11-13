import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { billingService } from '@/services/billingService'
import { toast } from '@/store/toastStore'
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
      desc.includes('signup') || desc.includes('not allowed') || desc.includes('database error')
        ? 'Não encontramos uma conta com esse e-mail do Google. Entre com e-mail e senha, ou crie a conta da sua empresa.'
        : 'Não foi possível entrar com o Google. Tente de novo.',
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

        <button type="button" className="btn btn-ghost" style={{ width: '100%', justifyContent: 'center', marginBottom: 10 }} onClick={entrarComGoogle}>
          <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.5l6.8-6.8C35.8 2.4 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"/><path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.1 0 24s.9 7.6 2.6 10.8l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7.5-5.8c-2.1 1.4-4.8 2.3-7.7 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>
          Entrar com o Google
        </button>

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
