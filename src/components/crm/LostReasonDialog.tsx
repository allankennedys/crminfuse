import { useEffect, useState } from 'react'
import { Modal } from '@/components/ui'
import { crmService } from '@/services/crmService'

/**
 * Motivo de perda (139): pergunta por que o contato foi para a etapa de
 * perdidos. O motivo é obrigatório: é ele que vira relatório. Lista
 * configurável na própria etapa de perdidos; "Outro" aceita texto livre.
 */
export function LostReasonDialog({ contactName, stageName, onCancel, onConfirm }: {
  contactName: string
  stageName: string
  onCancel: () => void
  onConfirm: (reason: string) => Promise<void> | void
}) {
  const [reasons, setReasons] = useState<string[] | null>(null)
  const [pick, setPick] = useState('')
  const [other, setOther] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    crmService.getLostReasons().then(setReasons).catch(() => setReasons([]))
  }, [])

  const isOther = pick === '__outro'
  const reason = (isOther ? other : pick).trim()

  const submit = async () => {
    if (!reason) return
    setBusy(true)
    try { await onConfirm(reason) } finally { setBusy(false) }
  }

  return (
    <Modal title={`Mover para ${stageName}`} onClose={onCancel} variant="dialog" small>
      <p className="text-secondary" style={{ marginBottom: 12 }}>
        Por que <strong>{contactName}</strong> foi perdido?
      </p>
      {reasons === null ? <div className="spinner" /> : (
        <div className="field">
          <label htmlFor="lost-reason">Motivo</label>
          <select id="lost-reason" className="input" value={pick} onChange={(e) => setPick(e.target.value)} autoFocus>
            <option value="">Escolha um motivo</option>
            {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
            <option value="__outro">Outro (escrever)</option>
          </select>
        </div>
      )}
      {isOther && (
        <div className="field">
          <input className="input" value={other} maxLength={120} onChange={(e) => setOther(e.target.value)} placeholder="Qual o motivo?" />
        </div>
      )}
      <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button className="btn btn-primary" onClick={submit} disabled={!reason || busy}>
          {busy ? <span className="spinner" /> : 'Mover'}
        </button>
      </div>
    </Modal>
  )
}
