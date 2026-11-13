import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { BarChart3, Kanban, MessageCircle } from 'lucide-react'
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
    <div className="login-split">
      <aside className="login-brand" aria-hidden="false">
        <img src="/logo.png" alt="Infuse" className="login-brand-logo" />
        <div className="login-brand-body">
          <h2>Atendimento e vendas da sua empresa, num só lugar.</h2>
          <p>Converse com clientes pelo WhatsApp, acompanhe o funil e saiba o que está fechando venda.</p>
          <ul>
            <li><MessageCircle size={18} /><span><strong>Atendimento em equipe</strong>Várias pessoas, vários números, cada conversa com um responsável.</span></li>
            <li><Kanban size={18} /><span><strong>Funil de vendas</strong>Do primeiro contato ao fechamento, com histórico completo.</span></li>
            <li><BarChart3 size={18} /><span><strong>Relatórios claros</strong>Desempenho por atendente, canal e período.</span></li>
          </ul>
        </div>
        <span className="login-brand-foot">© {new Date().getFullYear()} Infuse Software</span>
      </aside>

      <main className="login-main">
        <div className="auth-theme"><ThemeToggle /></div>
        <div className="login-box">
          <img src={theme === 'light' ? '/logo-navy.png' : '/logo.png'} alt="Infuse" className="login-mobile-logo" />
          <h1>Entrar no Infuse CRM</h1>
          <p className="login-sub">Use o e-mail da sua conta para acessar.</p>

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
            <span>Teste grátis por 7 dias, sem cartão.</span>
          </p>
          <p className="login-invite">Sua empresa já usa o Infuse? Peça o link de convite a um administrador.</p>
        </div>
      </main>
    </div>
  )
}
