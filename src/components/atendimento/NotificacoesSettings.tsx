import { useEffect, useState } from 'react'
import { BellRing } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { useAvisosStore } from '@/store/avisosStore'
import { toast } from '@/store/toastStore'
import {
  ativarPush, desativarPush, gravarDecisaoPush, pushAtivo, pushPermissao, pushSuportado,
} from '@/lib/push'
import { alternarAvisos } from './Avisos'

/**
 * Configurações → Notificações (de cada pessoa, neste aparelho).
 *
 * Desligar aqui só apaga o registro do banco: o servidor para de mandar. A
 * permissão do aparelho não é mexida (o app não consegue e não deve): por isso
 * religar é um toque, sem pedir nada de novo. Ligar com a permissão bloqueada
 * no aparelho não tem como funcionar pelo app: a tela explica onde liberar.
 */
export function NotificacoesSettings() {
  const userId = useAuthStore((s) => s.profile?.id ?? '')
  const organizationId = useAuthStore((s) => s.profile?.organization_id ?? '')
  const avisosLigados = useAvisosStore((s) => s.ligado)
  const [push, setPush] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const perm = pushPermissao()

  useEffect(() => { pushAtivo().then(setPush) }, [])

  const alternarPush = async () => {
    setBusy(true)
    try {
      if (push) {
        await desativarPush()
        gravarDecisaoPush(userId, 'nao')
        setPush(false)
        toast.success('Notificações desligadas neste aparelho.')
      } else {
        gravarDecisaoPush(userId, 'sim')
        const r = await ativarPush(userId, organizationId)
        if (r.ok) { setPush(true); toast.success('Notificações ligadas neste aparelho.') }
        else toast.error(r.motivo)
      }
    } finally {
      setBusy(false)
    }
  }

  const estado = !pushSuportado()
    ? 'Este navegador não recebe notificação com o app fechado. No iPhone, instale o app na tela inicial (Compartilhar → Adicionar à Tela de Início) e abra por lá.'
    : perm === 'denied'
      ? 'As notificações estão bloqueadas neste aparelho. Libere nas configurações do navegador ou do aplicativo (permissões do site) e volte aqui para ligar.'
      : push
        ? 'Ligadas neste aparelho. Mensagem nova de cliente e lembrete vencido chegam como notificação, mesmo com o app fechado.'
        : 'Desligadas neste aparelho. Nada é enviado para ele.'

  return (
    <section className="card">
      <h3 className="card-title"><BellRing size={15} /> Notificações</h3>

      <label className="at-toggle">
        <input
          type="checkbox"
          checked={Boolean(push)}
          disabled={busy || push === null || !pushSuportado() || perm === 'denied'}
          onChange={() => { void alternarPush() }}
        />
        <span>
          <strong>Notificar com o app fechado (neste aparelho)</strong>
          <span className="text-muted">{estado}</span>
        </span>
      </label>

      <label className="at-toggle">
        <input type="checkbox" checked={avisosLigados} onChange={() => { void alternarAvisos() }} />
        <span>
          <strong>Som e aviso enquanto o app está aberto</strong>
          <span className="text-muted">
            Toca um som e mostra a notificação do navegador quando chega mensagem nova e a aba está em segundo plano.
          </span>
        </span>
      </label>

      <p className="text-muted" style={{ fontSize: 12, marginTop: 10 }}>
        Cada aparelho tem a sua configuração. Desligar aqui não tira a permissão do aparelho, então religar é só marcar de novo.
      </p>
    </section>
  )
}
