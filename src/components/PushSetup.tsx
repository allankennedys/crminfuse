import { useEffect, useState } from 'react'
import { BellRing } from 'lucide-react'
import { Modal } from '@/components/ui'
import { useAuthStore, useCan } from '@/store/authStore'
import { toast } from '@/store/toastStore'
import { ativarPush, gravarDecisaoPush, lerDecisaoPush, pushAtivo, pushPermissao, pushSuportado } from '@/lib/push'

/**
 * Notificações push neste aparelho, ao entrar no app.
 *
 * - Aparelho novo (ainda sem resposta): pergunta DENTRO do app se a pessoa quer
 *   ativar. Só se ela disser "Sim" é que o aparelho mostra o pedido de
 *   permissão. "Agora não" não chama o aparelho de jeito nenhum: um "não" no
 *   pedido do sistema é difícil de desfazer, e assim ela ainda pode mudar de
 *   ideia depois (Configurações → Notificações).
 * - Quem já disse "Sim" e já deu permissão: religa sozinho depois de sair e
 *   entrar de novo (sair apaga o registro deste aparelho).
 * - Permissão bloqueada no aparelho: não pergunta (não adiantaria).
 */
export function PushSetup() {
  const userId = useAuthStore((s) => s.profile?.id ?? '')
  const organizationId = useAuthStore((s) => s.profile?.organization_id ?? '')
  const can = useCan()
  const atende = can('atendimento.ver')
  const [perguntar, setPerguntar] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!userId || !atende || !pushSuportado()) return
    let vivo = true
    ;(async () => {
      if (await pushAtivo()) return
      const decisao = lerDecisaoPush(userId)
      const perm = pushPermissao()
      if (decisao === 'sim' && perm === 'granted') {
        await ativarPush(userId, organizationId)
        return
      }
      if (!decisao && perm !== 'denied' && vivo) setPerguntar(true)
    })()
    return () => { vivo = false }
  }, [userId, organizationId, atende])

  if (!perguntar) return null

  const agoraNao = () => {
    gravarDecisaoPush(userId, 'nao')
    setPerguntar(false)
  }

  const ativar = async () => {
    setBusy(true)
    gravarDecisaoPush(userId, 'sim')
    const r = await ativarPush(userId, organizationId)
    setBusy(false)
    setPerguntar(false)
    if (r.ok) toast.success('Notificações ligadas neste aparelho.')
    else toast.error(r.motivo)
  }

  return (
    <Modal title="Ativar notificações?" onClose={agoraNao} variant="dialog" small>
      <div className="flex" style={{ gap: 12, alignItems: 'flex-start', marginBottom: 14 }}>
        <BellRing size={22} style={{ flexShrink: 0, color: 'var(--primary-text)' }} />
        <p className="text-secondary" style={{ lineHeight: 1.5 }}>
          Receba um aviso quando chegar mensagem nova de cliente ou quando um lembrete vencer, mesmo com o app
          fechado. Se disser que sim, o aparelho vai pedir a sua permissão.
        </p>
      </div>
      <div className="flex" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={agoraNao} disabled={busy}>Agora não</button>
        <button className="btn btn-primary" onClick={ativar} disabled={busy}>
          {busy ? <span className="spinner" /> : 'Sim, ativar'}
        </button>
      </div>
      <p className="text-muted" style={{ fontSize: 12, marginTop: 10 }}>
        Dá para ligar ou desligar depois em Configurações → Notificações.
      </p>
    </Modal>
  )
}
