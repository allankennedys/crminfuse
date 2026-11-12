import { useEffect, useState } from 'react'
import { FileText, Paperclip, Pencil, User } from 'lucide-react'
import { Modal } from '../ui'
import { crmService, formatBRL } from '@/services/crmService'
import { RefundFileGrid } from './RefundAttachments'
import { LinkifiedText } from '../LinkifiedText'
import type { RefundTarget } from './RefundEditDialog'
import { formatSP } from '@/lib/datetime'
import type { CrmRefundDetail, CrmRefundFile } from '@/types'

/** O detalhe do card vira a venda que o formulário de edição espera. */
export function refundTargetFromDetail(d: CrmRefundDetail): RefundTarget {
  return {
    id: d.sale_id,
    value_cents: d.value_cents,
    sold_at: d.sold_at,
    refunded_at: d.refunded_at,
    refunded_cents: d.partial ? d.refund_cents : null,
    refund_note: d.refund_note,
  }
}

/**
 * O card do reembolso (103): valores, quem marcou, a nota e os anexos.
 * Abre ao clicar no reembolso — no drawer do contato e na lista de
 * reembolsos do relatório.
 */
export function RefundDetailDialog({ saleId, onClose, onOpenContact, onEdit }: {
  saleId: string
  onClose: () => void
  /** No relatório: leva ao contato da venda. */
  onOpenContact?: (contactId: string) => void
  /** Abre o formulário do reembolso (valor, nota e anexos). undefined = sem permissão. */
  onEdit?: (detail: CrmRefundDetail) => void
}) {
  const [detail, setDetail] = useState<CrmRefundDetail | null | undefined>(undefined)
  const [files, setFiles] = useState<CrmRefundFile[]>([])
  const [erro, setErro] = useState<string | null>(null)

  useEffect(() => {
    let vivo = true
    Promise.all([crmService.getRefundDetail(saleId), crmService.listRefundFiles(saleId)])
      .then(([d, f]) => {
        if (!vivo) return
        setDetail(d)
        setFiles(f)
      })
      .catch((err) => vivo && setErro(err instanceof Error ? err.message : 'Falha ao carregar o reembolso'))
    return () => { vivo = false }
  }, [saleId])

  const rotulo = { fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }

  return (
    <Modal title="Reembolso" onClose={onClose}>
      {erro ? (
        <p style={{ color: 'var(--danger)', fontSize: 14 }}>{erro}</p>
      ) : detail === undefined ? (
        <p className="text-muted" style={{ fontSize: 13 }}>Carregando…</p>
      ) : detail === null ? (
        <p className="text-muted" style={{ fontSize: 14 }}>Esta venda não está mais marcada como reembolsada.</p>
      ) : (
        <div style={{ display: 'grid', gap: 18 }}>
          <div className="card" style={{ display: 'grid', gap: 12 }}>
            <div className="flex" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={rotulo}>Reembolsado</div>
                <div style={{ fontSize: 22, fontWeight: 600 }}>
                  {formatBRL(detail.refund_cents)}
                  <span className="badge badge-red" style={{ marginLeft: 8, verticalAlign: 'middle' }}>
                    {detail.partial ? 'Parcial' : 'Total'}
                  </span>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={rotulo}>Venda</div>
                <div>{formatBRL(detail.value_cents)}</div>
              </div>
            </div>
            <div className="text-muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
              Venda em {formatSP(detail.sold_at)} · reembolso em {formatSP(detail.refunded_at)}
              {detail.refunded_by_name && <> · marcado por {detail.refunded_by_name}</>}
            </div>
            {onOpenContact && (
              <button
                className="btn btn-ghost btn-sm"
                style={{ justifySelf: 'start' }}
                onClick={() => onOpenContact(detail.contact_id)}
              >
                <User size={13} /> {detail.name || detail.phone || 'Abrir contato'}
                {detail.channel && <span className="text-muted" style={{ fontSize: 11 }}> · {detail.channel}</span>}
              </button>
            )}
          </div>

          <div>
            <div className="card-title" style={{ marginBottom: 8 }}><FileText size={14} /> Notas</div>
            {detail.refund_note ? (
              <p style={{ fontSize: 14, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>
                <LinkifiedText text={detail.refund_note} />
              </p>
            ) : (
              <p className="text-muted" style={{ fontSize: 13, margin: 0 }}>Nenhuma nota.</p>
            )}
          </div>

          <div>
            <div className="card-title" style={{ marginBottom: 8 }}><Paperclip size={14} /> Anexos</div>
            {files.length === 0 ? (
              <p className="text-muted" style={{ fontSize: 13, margin: 0 }}>Nenhum arquivo anexado.</p>
            ) : (
              <RefundFileGrid files={files} />
            )}
          </div>

          <div className="flex" style={{ justifyContent: 'flex-end', gap: 8 }}>
            {onEdit && (
              <button className="btn btn-ghost" onClick={() => onEdit(detail)}>
                <Pencil size={15} /> Editar reembolso
              </button>
            )}
            <button className="btn btn-primary" onClick={onClose}>
              Fechar
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
