import { useEffect, useState } from 'react'
import { Paperclip, RotateCcw, Save, Undo2, X } from 'lucide-react'
import { Modal } from '../ui'
import { RefundFileGrid } from './RefundAttachments'
import {
  crmService, formatBRL, formatBytes, parseBRL, REFUND_FILE_MAX, refundTooBig,
} from '@/services/crmService'
import {
  ACCEPTED_ATTACHMENT, compressAttachment, isAcceptedAttachment, type CompressedFile,
} from '@/lib/compressFile'
import { useAuthStore } from '@/store/authStore'
import { toast } from '@/store/toastStore'
import { confirmDialog } from '@/store/confirmStore'
import { formatSP } from '@/lib/datetime'
import type { CrmRefundFile } from '@/types'

/** O mínimo da venda que o formulário precisa — CrmSale serve, e o detalhe do relatório também. */
export interface RefundTarget {
  id: string
  value_cents: number
  sold_at: string
  refunded_at?: string | null
  refunded_cents?: number | null
  refund_note?: string | null
}

/**
 * Marcar ou editar o reembolso de uma venda (101/102/103): valor devolvido,
 * nota e anexos. Abre do drawer do contato e do card do relatório.
 *
 * Os anexos novos já ficam comprimidos na fila: a compressão roda ao
 * escolher o arquivo, para o aviso de tamanho e de espaço sair na hora, e
 * não depois de clicar em salvar.
 */
export function RefundEditDialog({ sale, onClose, onSaved }: {
  sale: RefundTarget
  /** `desfeito` = fechou porque o reembolso foi desfeito: não há mais card para voltar. */
  onClose: (desfeito?: boolean) => void
  /** Depois de gravar ou desfazer — quem abriu recarrega o que mostra. */
  onSaved: () => void | Promise<void>
}) {
  const profile = useAuthStore((s) => s.profile)
  const [value, setValue] = useState(() =>
    formatBRL(sale.refunded_at ? sale.refunded_cents ?? sale.value_cents : sale.value_cents))
  const [note, setNote] = useState(sale.refund_note ?? '')
  const [files, setFiles] = useState<CrmRefundFile[]>([])
  const [pending, setPending] = useState<CompressedFile[]>([])
  const [space, setSpace] = useState<{ used: number; limit: number } | null>(null)
  const [compressing, setCompressing] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    crmService.listRefundFiles(sale.id)
      .then(setFiles)
      .catch((err) => toast.error(err instanceof Error ? err.message : 'Falha ao carregar os anexos'))
    crmService.storageUsage().then(setSpace).catch(() => {})
  }, [sale.id])

  /**
   * Comprime os arquivos escolhidos e só deixa entrar o que é PDF ou imagem,
   * cabe no limite por arquivo e cabe no espaço livre do storage — somando
   * os que já estão na fila.
   */
  async function pick(list: File[]) {
    if (!list.length) return
    setCompressing(true)
    try {
      const atual = await crmService.storageUsage().catch(() => space)
      if (atual) setSpace(atual)
      let reservado = pending.reduce((n, f) => n + f.blob.size, 0)
      const aceitos: CompressedFile[] = []
      for (const file of list) {
        if (!isAcceptedAttachment(file)) {
          toast.error(`"${file.name}" não é PDF nem imagem.`)
          continue
        }
        const c = await compressAttachment(file)
        if (c.blob.size > REFUND_FILE_MAX) {
          toast.error(refundTooBig(file.name, c.blob.size))
          continue
        }
        if (atual && atual.used + reservado + c.blob.size > atual.limit) {
          const livre = Math.max(0, atual.limit - atual.used - reservado)
          toast.error(`Sem espaço livre para "${file.name}" (${formatBytes(c.blob.size)}): restam ${formatBytes(livre)} de ${formatBytes(atual.limit)} no armazenamento.`)
          continue
        }
        reservado += c.blob.size
        aceitos.push(c)
      }
      setPending((p) => [...p, ...aceitos])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao preparar o anexo')
    } finally {
      setCompressing(false)
    }
  }

  /** Tira um anexo já gravado — sai da tabela e do bucket na hora. */
  async function removeFile(file: CrmRefundFile) {
    const ok = await confirmDialog({
      title: 'Remover anexo',
      message: `"${file.name}" será apagado do reembolso.`,
      confirmLabel: 'Remover',
    })
    if (!ok) return
    try {
      await crmService.removeRefundFile(file)
      setFiles((fs) => fs.filter((f) => f.id !== file.id))
      crmService.storageUsage().then(setSpace).catch(() => {})
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao remover o anexo')
    }
  }

  /**
   * Grava valor e nota e depois sobe os anexos, um por vez. Um anexo que
   * falhe não derruba os outros nem o reembolso: o que subiu sai da fila, o
   * que falhou fica nela com o aviso, e o formulário continua aberto para
   * tentar de novo.
   */
  async function save() {
    const cents = parseBRL(value)
    if (!(cents > 0)) {
      toast.error('Informe o valor reembolsado')
      return
    }
    if (cents > sale.value_cents) {
      toast.error(`O reembolso não pode passar de ${formatBRL(sale.value_cents)}`)
      return
    }
    if (!profile) return
    setSaving(true)
    try {
      const parcial = cents < sale.value_cents ? cents : null
      await crmService.setSaleRefunded(sale.id, true, parcial, note)
      const falharam: CompressedFile[] = []
      for (const f of pending) {
        try {
          await crmService.addRefundFile(sale.id, profile.organization_id, f)
        } catch (err) {
          falharam.push(f)
          toast.error(err instanceof Error ? err.message : `Falha ao anexar "${f.name}"`)
        }
      }
      await onSaved()
      if (falharam.length) {
        setPending(falharam)
        crmService.listRefundFiles(sale.id).then(setFiles).catch(() => {})
        toast.error(`Reembolso salvo, mas ${falharam.length} anexo${falharam.length > 1 ? 's' : ''} não subi${falharam.length > 1 ? 'ram' : 'u'}. Tente salvar de novo.`)
        return
      }
      toast.success(parcial != null
        ? `Reembolso parcial de ${formatBRL(parcial)} salvo`
        : sale.refunded_at ? 'Reembolso salvo' : 'Venda marcada como reembolsada')
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar o reembolso')
    } finally {
      setSaving(false)
    }
  }

  /**
   * Desfazer confirma antes porque perde a data original — remarcar grava a
   * de hoje, e é ela que define o período do líquido.
   */
  async function undo() {
    if (!sale.refunded_at) return
    const ok = await confirmDialog({
      title: 'Desfazer reembolso',
      message: `Venda de ${formatBRL(sale.value_cents)} em ${formatSP(sale.sold_at)}.\n`
        + `${sale.refunded_cents != null ? `${formatBRL(sale.refunded_cents)} reembolsados` : 'Reembolsada'} em ${formatSP(sale.refunded_at)}. `
        + 'O valor volta para o líquido do relatório. A nota e os anexos ficam guardados '
        + 'e voltam se a venda for marcada de novo.',
      confirmLabel: 'Desfazer reembolso',
    })
    if (!ok) return
    setSaving(true)
    try {
      await crmService.setSaleRefunded(sale.id, false)
      await onSaved()
      toast.success('Reembolso desfeito')
      onClose(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao desfazer o reembolso')
    } finally {
      setSaving(false)
    }
  }

  const rotulo = { fontSize: 12, color: 'var(--text-secondary)' }

  return (
    <Modal title={sale.refunded_at ? 'Editar reembolso' : 'Marcar como reembolso'} onClose={() => onClose()} variant="dialog">
      <form onSubmit={(e) => { e.preventDefault(); void save() }}>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 14 }}>
          Venda de <strong>{formatBRL(sale.value_cents)}</strong> em {formatSP(sale.sold_at)}.
          {sale.refunded_at && ` Reembolsada em ${formatSP(sale.refunded_at)}.`}
        </p>
        <label style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
          <span style={rotulo}>Valor reembolsado</span>
          <input
            className="input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => setValue(value.trim() ? formatBRL(parseBRL(value)) : '')}
            onFocus={(e) => e.target.select()}
            placeholder="R$ 0,00"
            autoFocus
          />
        </label>
        <p className="text-muted" style={{ fontSize: 12, lineHeight: 1.5, marginBottom: 14 }}>
          Deixe o valor inteiro para reembolso total ou digite só a parte devolvida.
          {sale.refunded_at
            ? ' A data do reembolso continua a mesma.'
            : ' A venda continua no sistema e nenhum sistema externo é avisado; o valor'
              + ' sai do líquido do período de hoje.'}
        </p>

        <label style={{ display: 'grid', gap: 6, marginBottom: 14 }}>
          <span style={rotulo}>Notas</span>
          <textarea
            className="input"
            rows={4}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Motivo do reembolso, o que foi combinado com o cliente…"
            style={{ resize: 'vertical' }}
          />
        </label>

        <div style={{ display: 'grid', gap: 8, marginBottom: 18 }}>
          <span style={rotulo}>Anexos</span>
          {files.length > 0 && <RefundFileGrid files={files} onRemove={(f) => void removeFile(f)} />}
          {pending.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 4 }}>
              {pending.map((f, i) => (
                <li key={`novo-${i}`} className="flex" style={{ gap: 6, alignItems: 'center', fontSize: 13 }}>
                  <Paperclip size={13} />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <span className="text-muted" style={{ fontSize: 11 }}>
                    {f.blob.size < f.originalBytes
                      ? `${formatBytes(f.originalBytes)} → ${formatBytes(f.blob.size)}`
                      : formatBytes(f.blob.size)}
                    {' · sobe ao salvar'}
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setPending((p) => p.filter((_, j) => j !== i))}
                    aria-label={`Tirar ${f.name}`}
                  >
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label className="btn btn-ghost btn-sm" style={{ justifySelf: 'start', cursor: compressing ? 'wait' : 'pointer' }}>
            <Paperclip size={13} /> {compressing ? 'Comprimindo…' : 'Anexar arquivos'}
            <input
              type="file"
              multiple
              accept={ACCEPTED_ATTACHMENT}
              disabled={compressing}
              style={{ display: 'none' }}
              onChange={(e) => {
                // files é uma lista viva: limpar o campo a esvazia. Copia antes.
                const escolhidos = Array.from(e.target.files ?? [])
                e.target.value = ''
                void pick(escolhidos)
              }}
            />
          </label>
          <span className="text-muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
            PDF ou imagem (PNG, JPG, WebP…), até {formatBytes(REFUND_FILE_MAX)} cada depois de comprimido.
            {space && ` Espaço livre: ${formatBytes(Math.max(0, space.limit - space.used))} de ${formatBytes(space.limit)}.`}
          </span>
        </div>

        <div className="flex" style={{ justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          {sale.refunded_at && (
            <button
              type="button"
              className="btn btn-ghost"
              style={{ marginRight: 'auto' }}
              onClick={() => void undo()}
              disabled={saving}
            >
              <Undo2 size={15} /> Desfazer reembolso
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => onClose()} disabled={saving}>Cancelar</button>
          <button type="submit" className="btn btn-primary" disabled={saving || compressing}>
            {saving
              ? 'Salvando…'
              : sale.refunded_at
                ? <><Save size={15} /> Salvar</>
                : <><RotateCcw size={15} /> Marcar como reembolso</>}
          </button>
        </div>
      </form>
    </Modal>
  )
}
