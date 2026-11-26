import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Plus, Send, XCircle } from 'lucide-react'
import { Loader, EmptyState, Modal } from '@/components/ui'
import { broadcastService, type Broadcast, type BroadcastRecipient, type BroadcastStatus } from '@/services/broadcastService'
import { confirmDialog } from '@/store/confirmStore'
import { toast } from '@/store/toastStore'
import { formatSP } from '@/lib/datetime'
import type { CrmStage } from '@/types'
import { NovoDisparo } from './NovoDisparo'

const STATUS: Record<BroadcastStatus, string> = {
  agendada: 'Agendada',
  enviando: 'Enviando',
  concluida: 'Concluída',
  cancelada: 'Cancelada',
  falhou: 'Parou',
}
const TIPO: Record<string, string> = { text: 'Texto', image: 'Imagem', video: 'Vídeo', audio: 'Áudio', document: 'Arquivo' }

/** Aba "Envio em massa": campanhas feitas e agendadas, com o andamento ao vivo. */
export function Disparos({ stages }: { stages: CrmStage[] }) {
  const [lista, setLista] = useState<Broadcast[] | null>(null)
  const [novo, setNovo] = useState(false)
  const [detalhe, setDetalhe] = useState<Broadcast | null>(null)

  const carregar = useCallback(() => {
    broadcastService.list().then(setLista).catch(() => { setLista((l) => l ?? []); toast.error('Falha ao carregar os envios') })
  }, [])
  useEffect(carregar, [carregar])

  // Enquanto há envio correndo, acompanha o progresso.
  const ativo = (lista ?? []).some((b) => b.status === 'agendada' || b.status === 'enviando')
  useEffect(() => {
    if (!ativo) return
    const i = setInterval(carregar, 5000)
    return () => clearInterval(i)
  }, [ativo, carregar])

  async function cancelar(b: Broadcast) {
    if (!(await confirmDialog({
      title: 'Cancelar envio', message: b.status === 'enviando'
        ? 'Quem já recebeu não é desfeito; o resto não será enviado.' : 'O envio agendado não vai sair.',
      confirmLabel: 'Cancelar envio', danger: true,
    }))) return
    try { await broadcastService.cancel(b.id); toast.success('Envio cancelado.'); carregar() }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Não foi possível cancelar') }
  }

  return (
    <div style={{ padding: '0 0 24px' }}>
      <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'center', margin: '4px 0 14px', gap: 8, flexWrap: 'wrap' }}>
        <span />
        <button className="btn btn-primary" onClick={() => setNovo(true)}><Plus size={14} /> Novo envio</button>
      </div>

      {lista === null ? <Loader /> : lista.length === 0 ? (
        <EmptyState icon={<Send />} text="Nenhum envio em massa ainda. Crie o primeiro." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Campanha</th><th>Tipo</th><th>Quando</th><th>Situação</th><th>Andamento</th><th /></tr></thead>
            <tbody>
              {lista.map((b) => {
                const feitos = b.sent + b.failed
                const pct = b.total ? Math.round((feitos / b.total) * 100) : 0
                                return (
                  <tr key={b.id} className="row-clickable" onClick={() => setDetalhe(b)}>
                    <td><strong>{b.name}</strong></td>
                    <td>{TIPO[b.kind]}</td>
                    <td>{formatSP(b.scheduled_at).slice(0, 16)}</td>
                    <td><span className={`disparo-status ${b.status}`}>{STATUS[b.status]}</span></td>
                    <td style={{ minWidth: 160 }}>
                      <div className="disparo-barra"><div style={{ width: `${pct}%` }} /></div>
                      <span className="text-muted" style={{ fontSize: 12 }}>
                        {b.sent} enviada{b.sent === 1 ? '' : 's'}{b.failed ? ` · ${b.failed} falha${b.failed === 1 ? '' : 's'}` : ''} de {b.total}
                      </span>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {(b.status === 'agendada' || b.status === 'enviando') && (
                        <button className="btn btn-ghost btn-sm" onClick={() => cancelar(b)}><XCircle size={13} /> Cancelar</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {novo && <NovoDisparo stages={stages} onClose={() => setNovo(false)} onCreated={carregar} />}
      {detalhe && <DetalheDisparo b={detalhe} onClose={() => setDetalhe(null)} />}
    </div>
  )
}

function DetalheDisparo({ b, onClose }: { b: Broadcast; onClose: () => void }) {
  const [falhas, setFalhas] = useState<BroadcastRecipient[] | null>(null)
  useEffect(() => { broadcastService.recipients(b.id, 'falha').then(setFalhas).catch(() => setFalhas([])) }, [b.id])
  return (
    <Modal title={b.name} onClose={onClose} variant="dialog">
      <p className="text-secondary" style={{ fontSize: 13, marginBottom: 8 }}>
        {b.sent} enviadas · {b.failed} com falha · {b.total - b.sent - b.failed} pendentes
      </p>
      {b.error && <div className="plano-alerta"><AlertTriangle size={16} /><span>{b.error}</span></div>}
      {b.body && <p style={{ whiteSpace: 'pre-wrap', fontSize: 13, background: 'var(--surface-hover)', borderRadius: 8, padding: 10, margin: '8px 0' }}>{b.body}</p>}
      <h4 style={{ margin: '12px 0 6px', fontSize: 13 }}>Falhas</h4>
      {falhas === null ? <Loader /> : falhas.length === 0 ? <p className="text-muted" style={{ fontSize: 13 }}>Nenhuma falha.</p> : (
        <div className="table-wrap"><table><tbody>
          {falhas.map((r) => <tr key={r.id}><td>{r.name ?? '—'}</td><td>{r.phone}</td><td className="text-muted">{r.error}</td></tr>)}
        </tbody></table></div>
      )}
    </Modal>
  )
}
