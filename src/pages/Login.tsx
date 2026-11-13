import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { ThemeToggle } from '@/components/ThemeToggle'
import { useTheme } from '@/lib/theme'

export function LoginPage() {
  const theme = useTheme((s) => s.theme)
  const signIn = useAuthStore((s) => s.signIn)
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await signIn(username, password)
      // Serve os dois domínios sem alteração: na build do CRM não existe rota
      // /dashboard, então o catch-all do App redireciona para /crm.
      navigate('/crm')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha no login')
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
            <label>Usuário</label>
            <input className="input" type="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="seu.usuario" required />
          </div>
          <div className="field">
            <label>Senha</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
          </div>

          {error && <p className="error-text">{error}</p>}

          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }} disabled={loading}>
            {loading ? <span className="spinner" /> : 'Entrar'}
          </button>
        </form>

        <p style={{ textAlign: 'center', marginTop: 20, fontSize: 12.5 }} className="text-secondary">
          Quer usar com a sua empresa? <Link to="/cadastro">Teste grátis por 7 dias</Link>
          <br />
          Vai entrar numa empresa que já usa? Peça o link de convite ao administrador.
        </p>
      </div>
    </div>
  )
}
