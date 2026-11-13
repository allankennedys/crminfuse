import { useState, type FormEvent } from 'react'
import { MailCheck } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { toast } from '@/store/toastStore'
import { billingService } from '@/services/billingService'
import { useTour } from '@/store/tourStore'

/**
 * Configurações → Minha conta: e-mail de acesso. Quem entra com o usuário antigo
 * (sem e-mail de verdade) cadastra um e-mail aqui: enviamos um link para o
 * endereço novo e, ao confirmar, o login passa a ser o e-mail (e dá para usar
 * "Esqueci minha senha").
 */
export function ContaSettings() {
  const atual = useAuthStore((s) => s.session?.user.email ?? '')
  const antigo = atual.endsWith('@infuse.local')
  const [novo, setNovo] = useState('')
  const [busy, setBusy] = useState(false)
  const [enviado, setEnviado] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await billingService.changeEmail(novo.trim())
      setEnviado(novo.trim())
      setNovo('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível enviar agora')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h3 className="card-title"><MailCheck size={15} /> E-mail de acesso</h3>
      <p className="text-secondary" style={{ marginBottom: 12, lineHeight: 1.5 }}>
        {antigo
          ? <>Você entra com o usuário <strong>{atual.replace('@infuse.local', '')}</strong>. Cadastre um e-mail de verdade: ele passa a ser o seu login e permite recuperar a senha.</>
          : <>Você entra com <strong>{atual}</strong>.</>}
      </p>
      {enviado ? (
        <p className="text-secondary" style={{ lineHeight: 1.5 }}>
          Enviamos um link para <strong>{enviado}</strong>. Abra-o para concluir a troca. Até lá, o acesso continua como está.
        </p>
      ) : (
        <form onSubmit={submit} className="flex" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ margin: 0, flex: 1, minWidth: 240 }}>
            <label htmlFor="conta-email">{antigo ? 'Seu e-mail' : 'Novo e-mail'}</label>
            <input id="conta-email" className="input" type="email" autoCapitalize="none" value={novo} onChange={(e) => setNovo(e.target.value)} placeholder="voce@empresa.com.br" required />
          </div>
          <button className="btn btn-primary" disabled={busy || !novo.trim()}>
            {busy ? <span className="spinner" /> : 'Enviar link de confirmação'}
          </button>
        </form>
      )}
    </section>
  )
}

/** Rever a tour de boas-vindas. */
export function ReverTour() {
  const pedirRever = useTour((s) => s.pedirRever)
  return (
    <section className="card">
      <h3 className="card-title">Tour de boas-vindas</h3>
      <p className="text-secondary" style={{ marginBottom: 12, lineHeight: 1.5 }}>
        Quer rever o passo a passo com o básico do sistema?
      </p>
      <button className="btn btn-ghost" onClick={pedirRever}>Rever a tour</button>
    </section>
  )
}
