import { useEffect, useState } from 'react'
import { ThumbsDown } from 'lucide-react'
import { crmService } from '@/services/crmService'
import { fmtInt } from './reportKit'

/** Perdidos por motivo no período (139). Só conta quem foi para a etapa de perdidos com a data do relatório. */
export function LostReasonsCard({ from, to, hasLostStage }: { from: string; to: string; hasLostStage: boolean }) {
  const [rows, setRows] = useState<Array<{ reason: string; total: number }> | null>(null)

  useEffect(() => {
    let vivo = true
    setRows(null)
    crmService.lostReasonsReport(from, to).then((r) => { if (vivo) setRows(r) }).catch(() => { if (vivo) setRows([]) })
    return () => { vivo = false }
  }, [from, to])

  const total = (rows ?? []).reduce((s, r) => s + r.total, 0)

  return (
    <div className="card mb-16">
      <div className="card-title" style={{ marginBottom: 4 }}><ThumbsDown size={14} /> Motivos de perda</div>
      <p className="text-muted" style={{ fontSize: 11.5, marginBottom: 14 }}>
        Contatos que foram para a etapa de perdidos no período, por motivo.
      </p>
      {rows === null ? <div className="spinner" /> : rows.length === 0 ? (
        <p className="text-muted" style={{ fontSize: 13 }}>
          {hasLostStage
            ? 'Nenhum contato perdido no período.'
            : 'Marque uma etapa como "Etapa de perdidos" no funil para registrar os motivos.'}
        </p>
      ) : (
        <div className="table-wrap" style={{ border: 'none', background: 'transparent' }}>
          <table>
            <thead>
              <tr><th>Motivo</th><th style={{ textAlign: 'right' }}>Perdidos</th><th style={{ textAlign: 'right' }}>%</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.reason}>
                  <td>{r.reason}</td>
                  <td style={{ textAlign: 'right' }}>{fmtInt(r.total)}</td>
                  <td style={{ textAlign: 'right' }}>{total ? `${Math.round((r.total / total) * 100)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
