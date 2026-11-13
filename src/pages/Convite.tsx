import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { GoogleButton } from '@/components/GoogleButton'
import { CONVITE_PENDENTE } from '@/pages/CompletarCadastro'
import { ThemeToggle } from '@/components/ThemeToggle'
import { useTheme } from '@/lib/theme'
import { billingService } from '@/services/billingService'

/** Aceitar um convite: a pessoa escolhe nome, usuário e senha e entra na empresa que convidou. */
export function ConvitePage() {
  const { token = '' } = useParams()
  const theme = useTheme((s) => s.theme)
  const session = useAuthStore((s) => s.session)
  const signIn = useAuthStore((s) => s.signIn)
  const signInWithGoogle = useAuthStore((s) => s.signInWithGoogle)
  const signOut = useAuthStore((s) => s.signOut)
  const navigate = useNavigate()
  const [info, setInfo] = useState<{ organization: string; role: 'admin' | 'atendente'; email: string | null } | null>(null)
  const [invalido, setInvalido] = useState('')
  const [f, setF] = useState({ full_name: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    billingService.inviteInfo(token).then(setInfo).catch((e) => setInvalido(e instanceof Error ? e.message : 'Convite inválido.'))
  }, [token])

  async function comGoogle() {
    setError('')
    try {
      localStorage.setItem(CONVITE_PENDENTE, token)
      await signInWithGoogle()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao entrar com o Google.')
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const r = await billingService.acceptInvite({ token, ...f })
      await signIn(r.email, f.password)
      navigate('/crm')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível aceitar o convite')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-theme"><ThemeToggle /></div>
      <div className="auth-card">
        <div className="sidebar-logo" style={{ justifyContent: 'center', paddingBottom: 20 }}>
          <img src={theme === 'light' ? '/logo-navy.png' : '/logo.png'} alt="Infuse" className="brand-logo" style={{ height: 38 }} />
        </div>

        {invalido ? (
          <p className="error-text" style={{ textAlign: 'center' }}>{invalido}</p>
        ) : !info ? (
          <div className="center-loader"><div className="spinner lg" /></div>
        ) : session ? (
          <>
            <p className="text-secondary" style={{ textAlign: 'center', lineHeight: 1.5, marginBottom: 14 }}>
              Você já está com uma conta aberta neste navegador. Saia dela para aceitar o convite de <strong>{info.organization}</strong>.
            </p>
            <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => { void signOut() }}>Sair e aceitar o convite</button>
          </>
        ) : (
          <form onSubmit={submit}>
            <h1 style={{ fontSize: 17, textAlign: 'center', marginBottom: 4 }}>Você foi convidado</h1>
            <p className="text-secondary" style={{ textAlign: 'center', fontSize: 13, marginBottom: 16 }}>
              Para entrar em <strong>{info.organization}</strong> como {info.role === 'admin' ? 'administrador' : 'atendente'}.
            </p>
            <GoogleButton label="Aceitar com o Google" onClick={comGoogle} />
            <p className="text-muted" style={{ textAlign: 'center', fontSize: 12, margin: '8px 0 0' }}>Use a conta Google do e-mail {info.email}.</p>
            <div className="auth-divisor"><span>ou crie uma senha</span></div>
            <div className="field">
              <label htmlFor="cv-nome">Seu nome</label>
              <input id="cv-nome" className="input" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} maxLength={80} required />
            </div>
            <div className="field">
              <label htmlFor="cv-email">E-mail (você entra com ele)</label>
              <input id="cv-email" className="input" value={info.email ?? ''} readOnly />
            </div>
            <div className="field">
              <label htmlFor="cv-senha">Senha (mínimo 8 caracteres)</label>
              <input id="cv-senha" className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} minLength={8} required />
            </div>
            {error && <p className="error-text">{error}</p>}
            <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }} disabled={loading}>
              {loading ? <span className="spinner" /> : 'Aceitar convite e entrar'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
