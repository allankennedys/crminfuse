import { useCallback, useEffect, useState } from 'react'
import { QrCode, Smartphone } from 'lucide-react'
import { Modal, Loader, EmptyState, StatusBadge } from '@/components/ui'
import { useCan } from '@/store/authStore'
import { confirmDialog } from '@/store/confirmStore'
import { toast } from '@/store/toastStore'
import { SessionsPage } from '@/pages/Sessions'
import { atendimentoService, sessionLabel } from '@/services/atendimentoService'
import type { WaSession } from '@/types'

/**
 * Quais números da organização entram no Atendimento.
 *
 * Ligar um número aponta o webhook da Evolution para a at-webhook. A
 * Evolution tem UM webhook por instância: se o número já mandava eventos
 * para outro lugar (n8n, bot), a tela avisa antes, e desligar devolve o
 * webhook anterior.
 */
export function NumerosAtendimento({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const can = useCan()
  const [sessions, setSessions] = useState<WaSession[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [managing, setManaging] = useState(false)

  const load = useCallback(() => {
    // Só os números do próprio usuário: a lista também traz, para rótulo,
    // os números das conversas que ele enxerga — esses ele não configura.
    atendimentoService.sessions()
      .then((list) => setSessions(list.filter((s) => s.mine)))
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : 'Falha ao carregar os números')
        setSessions([])
      })
  }, [])

  useEffect(load, [load])

  const enable = async (s: WaSession) => {
    setBusy(s.id)
    try {
      const info = await atendimentoService.sessionInfo(s.id)
      if (info.webhook && !info.webhook.ours && info.webhook.enabled) {
        const ok = await confirmDialog({
          title: 'Este número já envia mensagens para outro sistema',
          message:
            `Hoje as mensagens deste número vão para ${info.webhook.host ?? 'outro endereço'}. ` +
            'Ligar o atendimento substitui esse envio (cada número aceita um só destino): ' +
            'automações que dependem dele param de receber. Desligar o atendimento depois devolve o envio anterior.',
          confirmLabel: 'Ligar mesmo assim',
          danger: true,
        })
        if (!ok) return
      }
      await atendimentoService.enableSession(s.id)
      toast.success(`${sessionLabel(s)} ligado ao atendimento.`)
      load()
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível ligar o número')
    } finally {
      setBusy(null)
    }
  }

  const disable = async (s: WaSession) => {
    const ok = await confirmDialog({
      title: 'Desligar do atendimento?',
      message: 'As conversas e o histórico continuam aqui. Mensagens novas deste número deixam de chegar ao CRM.',
      confirmLabel: 'Desligar',
      danger: true,
    })
    if (!ok) return
    setBusy(s.id)
    try {
      const r = await atendimentoService.disableSession(s.id)
      toast.success(r.restored ? 'Desligado — o webhook anterior do número foi devolvido.' : 'Número desligado do atendimento.')
      load()
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível desligar o número')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal title="Números do atendimento" onClose={onClose}>
      <p className="text-secondary" style={{ marginBottom: 16 }}>
        As conversas individuais dos números ligados aparecem na aba Atendimento. Grupos não entram.
      </p>

      {can('painel.numeros.ver') && (
        <div style={{ marginBottom: 16 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setManaging(true)}>
            <QrCode size={14} /> Conectar ou gerenciar números (QR Code)
          </button>
        </div>
      )}

      {sessions === null ? (
        <Loader />
      ) : sessions.length === 0 ? (
        <EmptyState icon={<Smartphone />} text="Você ainda não conectou nenhum número." />
      ) : (
        <div className="at-numbers">
          {sessions.map((s) => (
            <div key={s.id} className="at-number">
              <div className="at-number-info">
                <strong>{sessionLabel(s)}</strong>
                <span className="text-muted">{s.instance_name}</span>
              </div>
              <StatusBadge status={s.status} />
              {s.chat_enabled ? (
                <button className="btn btn-ghost btn-sm" disabled={busy === s.id} onClick={() => disable(s)}>
                  {busy === s.id ? 'Aguarde…' : 'Desligar'}
                </button>
              ) : (
                <button className="btn btn-primary btn-sm" disabled={busy === s.id} onClick={() => enable(s)}>
                  {busy === s.id ? 'Aguarde…' : 'Ligar ao atendimento'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {managing && (
        <Modal title="Números de WhatsApp" onClose={() => { setManaging(false); load() }} wide>
          <SessionsPage />
        </Modal>
      )}
    </Modal>
  )
}
