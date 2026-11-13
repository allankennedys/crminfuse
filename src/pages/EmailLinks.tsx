import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ThemeToggle } from '@/components/ThemeToggle'
import { useTheme } from '@/lib/theme'
import { billingService } from '@/services/billingService'

function Moldura({ children }: { children: React.ReactNode }) {
  const theme = useTheme((s) => s.theme)
  return (
    <div className="auth-page">
      <div className="auth-theme"><ThemeToggle /></div>
      <div className="auth-card">
        <div className="sidebar-logo" style={{ justifyContent: 'center', paddingBottom: 24 }}>
          <img src={theme === 'light' ? '/logo-navy.png' : '/logo.png'} alt="Infuse" className="brand-logo" style={{ height: 38 }} />
        </div>
        {children}
      </div>
    </div>
  )
}

/** Link do e-mail de verificação (/verificar-email/:token) e de troca de e-mail (/confirmar-email/:token). */
export function ConfirmarEmailPage({ troca = false }: { troca?: boolean }) {
  const { token = '' } = useParams()
  const [estado, setEstado] = useState<'carregando' | 'ok' | 'erro'>('carregando')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    const chamada = troca ? billingService.confirmEmailChange(token) : billingService.verifyEmail(token)
    chamada
      .then((r) => { setMsg(r.email); setEstado('ok') })
      .catch((e) => { setMsg(e instanceof Error ? e.message : 'Link inválido.'); setEstado('erro') })
  }, [token, troca])

  return (
    <Moldura>
      {estado === 'carregando' && <div className="center-loader"><div className="spinner lg" /></div>}
      {estado === 'ok' && (
        <>
          <h1 style={{ fontSize: 18, textAlign: 'center', marginBottom: 8 }}>{troca ? 'E-mail trocado' : 'E-mail confirmado'}</h1>
          <p className="text-secondary" style={{ textAlign: 'center', lineHeight: 1.5, marginBottom: 16 }}>
            {troca ? <>A partir de agora, entre com <strong>{msg}</strong>.</> : <>Tudo certo com <strong>{msg}</strong>. Já dá para entrar.</>}
          </p>
          <Link className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} to="/login">Entrar</Link>
        </>
      )}
      {estado === 'erro' && (
        <>
          <p className="error-text" style={{ textAlign: 'center' }}>{msg}</p>
          <p style={{ textAlign: 'center', marginTop: 14, fontSize: 13 }}><Link to="/login">Voltar para a entrada</Link></p>
        </>
      )}
    </Moldura>
  )
}

/** "Esqueci minha senha": pede o e-mail. A resposta é sempre a mesma, exista a conta ou não. */
export function EsqueciSenhaPage() {
  const [email, setEmail] = useState('')
  const [enviado, setEnviado] = useState(false)
  const [erro, setErro] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setErro('')
    setLoading(true)
    try {
      await billingService.requestReset(email.trim())
      setEnviado(true)
    } catch (err) {
      setErro(err instanceof Error ? err.message : 'Não foi possível enviar agora.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Moldura>
      {enviado ? (
        <>
          <h1 style={{ fontSize: 18, textAlign: 'center', marginBottom: 8 }}>Confira seu e-mail</h1>
          <p className="text-secondary" style={{ textAlign: 'center', lineHeight: 1.5 }}>
            Se existe uma conta com <strong>{email.trim()}</strong>, enviamos um link para criar uma nova senha. Ele vale por 1 hora.
            Não chegou? Veja o spam.
          </p>
        </>
      ) : (
        <form onSubmit={submit}>
          <h1 style={{ fontSize: 18, textAlign: 'center', marginBottom: 6 }}>Esqueci minha senha</h1>
          <p className="text-secondary" style={{ textAlign: 'center', fontSize: 13, marginBottom: 16 }}>
            Informe o e-mail da conta e enviamos um link para criar uma senha nova.
          </p>
          <div className="field">
            <label htmlFor="es-email">E-mail</label>
            <input id="es-email" className="input" type="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          {erro && <p className="error-text">{erro}</p>}
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }} disabled={loading}>
            {loading ? <span className="spinner" /> : 'Enviar link'}
          </button>
        </form>
      )}
      <p style={{ textAlign: 'center', marginTop: 16, fontSize: 12.5 }} className="text-secondary"><Link to="/login">Voltar para a entrada</Link></p>
    </Moldura>
  )
}

/** Link do e-mail de recuperação (/redefinir-senha/:token): escolhe a senha nova. */
export function RedefinirSenhaPage() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const [senha, setSenha] = useState('')
  const [senha2, setSenha2] = useState('')
  const [erro, setErro] = useState('')
  const [loading, setLoading] = useState(false)
  const [pronto, setPronto] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setErro('')
    if (senha !== senha2) return setErro('As duas senhas não são iguais.')
    setLoading(true)
    try {
      await billingService.resetPassword(token, senha)
      setPronto(true)
      setTimeout(() => navigate('/login'), 2500)
    } catch (err) {
      setErro(err instanceof Error ? err.message : 'Não foi possível trocar a senha.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Moldura>
      {pronto ? (
        <>
          <h1 style={{ fontSize: 18, textAlign: 'center', marginBottom: 8 }}>Senha alterada</h1>
          <p className="text-secondary" style={{ textAlign: 'center' }}>Já dá para entrar com a senha nova.</p>
          <Link className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 14 }} to="/login">Entrar</Link>
        </>
      ) : (
        <form onSubmit={submit}>
          <h1 style={{ fontSize: 18, textAlign: 'center', marginBottom: 14 }}>Escolha uma nova senha</h1>
          <div className="field">
            <label htmlFor="rs-senha">Nova senha (mínimo 8 caracteres)</label>
            <input id="rs-senha" className="input" type="password" value={senha} onChange={(e) => setSenha(e.target.value)} minLength={8} required autoFocus />
          </div>
          <div className="field">
            <label htmlFor="rs-senha2">Repita a senha</label>
            <input id="rs-senha2" className="input" type="password" value={senha2} onChange={(e) => setSenha2(e.target.value)} minLength={8} required />
          </div>
          {erro && <p className="error-text">{erro}</p>}
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }} disabled={loading}>
            {loading ? <span className="spinner" /> : 'Salvar nova senha'}
          </button>
        </form>
      )}
    </Moldura>
  )
}
