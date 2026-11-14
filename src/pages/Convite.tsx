import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { GoogleButton } from '@/components/GoogleButton'
import { CONVITE_PENDENTE } from '@/pages/CompletarCadastro'
import { ThemeToggle } from '@/components/ThemeToggle'
import { useTheme } from '@/lib/theme'
import { billingService } from '@/services/billingService'
import { toast } from '@/store/toastStore'

/** Aceitar um convite: a pessoa escolhe nome, usuário e senha e entra na empresa que convidou. */
export function ConvitePage() {
  const { token = '' } = useParams()
  const theme = useTheme((s) => s.theme)
  const session = useAuthStore((s) => s.session)
  const signIn = useAuthStore((s) => s.signIn)
  const signInWithGoogle = useAuthStore((s) => s.signInWithGoogle)
  const signOut = useAuthStore((s) => s.signOut)
  const navigate = useNavigate()
  const trocarOrganizacao = useAuthStore((s) => s.trocarOrganizacao)
  const [info, setInfo] = useState<{ organization: string; role: 'admin' | 'atendente'; email: string | null; has_account?: boolean } | null>(null)
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

  /** Quem já tem conta (e empresa) entra na nova como mais um vínculo e passa a alternar pelo seletor. */
  async function aceitarComContaAtual() {
    setError('')
    setLoading(true)
    try {
      const r = await billingService.acceptInviteExisting(token)
      toast.success('Convite aceito.')
      await trocarOrganizacao(r.organization_id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível aceitar o convite')
      setLoading(false)
    }
  }

  async function entrarParaAceitar(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await signIn(info?.email ?? '', f.password)
    } catch (err) {
      setError(err instanceof Error && err.message !== 'EMAIL_NAO_CONFIRMADO' ? err.message : 'Não foi possível entrar.')
    } finally {
      setLoading(false)
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
          session.user.email?.toLowerCase() === String(info.email ?? '').toLowerCase() ? (
            <>
              <h1 style={{ fontSize: 17, textAlign: 'center', marginBottom: 4 }}>Você foi convidado</h1>
              <p className="text-secondary" style={{ textAlign: 'center', lineHeight: 1.5, marginBottom: 14 }}>
                Para entrar em <strong>{info.organization}</strong> como {info.role === 'admin' ? 'administrador' : 'atendente'}.
                Você continua nas suas outras empresas e alterna entre elas ao lado do nome da empresa.
              </p>
              {error && <p className="error-text" style={{ textAlign: 'center' }}>{error}</p>}
              <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={loading} onClick={() => { void aceitarComContaAtual() }}>
                {loading ? <span className="spinner" /> : 'Aceitar convite'}
              </button>
            </>
          ) : (
            <>
              <p className="text-secondary" style={{ textAlign: 'center', lineHeight: 1.5, marginBottom: 14 }}>
                Você está com outra conta aberta neste navegador. O convite de <strong>{info.organization}</strong> é para o e-mail <strong>{info.email}</strong>: saia e entre com ele.
              </p>
              <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => { void signOut() }}>Sair e continuar</button>
            </>
          )
        ) : info.has_account ? (
          <form onSubmit={entrarParaAceitar}>
            <h1 style={{ fontSize: 17, textAlign: 'center', marginBottom: 4 }}>Você foi convidado</h1>
            <p className="text-secondary" style={{ textAlign: 'center', fontSize: 13, marginBottom: 16 }}>
              Para entrar em <strong>{info.organization}</strong> como {info.role === 'admin' ? 'administrador' : 'atendente'}. O e-mail {info.email} já tem conta: entre para aceitar.
            </p>
            <div className="field">
              <label htmlFor="cv-email2">E-mail</label>
              <input id="cv-email2" className="input" value={info.email ?? ''} readOnly />
            </div>
            <div className="field">
              <label htmlFor="cv-senha2">Senha</label>
              <input id="cv-senha2" className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
            </div>
            {error && <p className="error-text">{error}</p>}
            <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }} disabled={loading}>
              {loading ? <span className="spinner" /> : 'Entrar e aceitar'}
            </button>
            <p className="text-muted" style={{ textAlign: 'center', fontSize: 12, margin: '12px 0 0' }}>
              Sua conta é do Google?
            </p>
            <GoogleButton label="Entrar com o Google e aceitar" onClick={comGoogle} />
          </form>
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
