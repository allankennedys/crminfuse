import { useEffect, useState } from 'react'
import { Bell, BellOff } from 'lucide-react'
import { Modal } from '@/components/ui'
import { toast } from '@/store/toastStore'
import { ativarPush, desativarPush, gravarDecisaoPush, pushAtivo, pushSuportado } from '@/lib/push'
import { useAuthStore } from '@/store/authStore'
import { useAvisosStore } from '@/store/avisosStore'
import { useConversaStore } from '@/store/conversaStore'
import { alternarAvisos } from './Avisos'
import { ListaMeusLembretes, useMeusLembretes } from './Lembretes'

/**
 * Um sino só, no topo, ao lado do nome do usuário: o número é o dos meus
 * lembretes vencidos. Abre a central: liga/desliga os avisos de mensagem nova
 * (som e notificação do navegador) e lista os lembretes.
 */
export function CentralAvisos() {
  const userId = useAuthStore((s) => s.profile?.id ?? '')
  const organizationId = useAuthStore((s) => s.profile?.organization_id ?? '')
  const ligado = useAvisosStore((s) => s.ligado)
  const abrirConversa = useConversaStore((s) => s.abrirConversa)
  const { tasks, load, atrasados } = useMeusLembretes(userId)
  const [aberto, setAberto] = useState(false)
  // Push (app fechado): neste aparelho.
  const [pushOn, setPushOn] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  useEffect(() => {
    if (aberto) pushAtivo().then(setPushOn)
  }, [aberto])

  const alternarPush = async () => {
    setPushBusy(true)
    try {
      if (pushOn) {
        await desativarPush()
        gravarDecisaoPush(userId, 'nao')
        setPushOn(false)
      } else {
        gravarDecisaoPush(userId, 'sim')
        const r = await ativarPush(userId, organizationId)
        if (r.ok) { setPushOn(true); toast.success('Notificações ligadas neste aparelho.') }
        else toast.error(r.motivo)
      }
    } finally {
      setPushBusy(false)
    }
  }
  // Lido a cada abertura: a permissão muda fora da tela, nas opções do navegador.
  const perm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'

  const estado = !ligado
    ? 'Avisos de mensagem nova desligados.'
    : perm === 'granted' ? 'Avisos ligados: som e notificação do navegador.'
      : perm === 'denied' ? 'Som ligado. A notificação está bloqueada nas permissões do navegador.'
        : perm === 'unsupported' ? 'Som ligado. Este navegador não mostra notificações.'
          : 'Som ligado. Falta permitir a notificação do navegador.'

  return (
    <>
      <button
        className="icon-btn at-bell"
        onClick={() => { load(); setAberto(true) }}
        title="Avisos e lembretes"
        aria-label={`Avisos e lembretes${atrasados ? `, ${atrasados} vencido(s)` : ''}`}
      >
        {ligado ? <Bell size={16} /> : <BellOff size={16} />}
        {atrasados > 0 && <span className="at-bell-count">{atrasados > 9 ? '9+' : atrasados}</span>}
      </button>

      {aberto && (
        <Modal title="Avisos e lembretes" onClose={() => setAberto(false)} variant="dialog">
          <div className="field">
            <label className="at-toggle">
              <input type="checkbox" checked={ligado} onChange={() => { void alternarAvisos() }} />
              <span>
                <strong>Avisar de mensagem nova</strong>
                <span className="text-muted">{estado}</span>
              </span>
            </label>
            {ligado && perm === 'default' && (
              <button className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={() => { void alternarAvisos() }}>
                Permitir notificações do navegador
              </button>
            )}
          </div>

          <div className="field">
            <label className="at-toggle">
              <input type="checkbox" checked={pushOn} disabled={pushBusy} onChange={() => { void alternarPush() }} />
              <span>
                <strong>Notificar com o app fechado (neste aparelho)</strong>
                <span className="text-muted">
                  {pushSuportado()
                    ? 'Mensagem nova de cliente e lembrete vencido chegam como notificação, mesmo com o navegador fechado ou o celular bloqueado.'
                    : 'Este navegador não suporta. No iPhone, instale o app na tela inicial (Compartilhar → Adicionar à Tela de Início) e abra por lá.'}
                </span>
              </span>
            </label>
          </div>

          <h3 className="card-title" style={{ margin: '14px 0 8px' }}>Meus lembretes</h3>
          <ListaMeusLembretes
            tasks={tasks}
            onChanged={load}
            onOpen={(id) => { setAberto(false); abrirConversa(id) }}
          />
        </Modal>
      )}
    </>
  )
}
