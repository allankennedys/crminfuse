import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Download, FileText, ImageOff, Loader2, X } from 'lucide-react'
import { Modal } from '../ui'
import { crmService, formatBytes } from '@/services/crmService'
import type { CrmRefundFile } from '@/types'

/**
 * Anexos do reembolso (103): miniatura e visualizador dentro do CRM.
 *
 * O PDF é desenhado pelo pdf.js, e não num <iframe>: o Chrome e o Brave do
 * Android não mostram PDF embutido — abririam um download. O pdf.js só é
 * carregado quando aparece o primeiro PDF.
 */

/** Um download por anexo: a miniatura e o visualizador dividem o mesmo. */
const blobs = new Map<string, Promise<Blob>>()

function loadBlob(file: CrmRefundFile) {
  let p = blobs.get(file.id)
  if (!p) {
    p = crmService.refundFileBlob(file)
    // Falha não fica em cache: abrir de novo tenta outra vez.
    p.catch(() => blobs.delete(file.id))
    blobs.set(file.id, p)
  }
  return p
}

function isPdf(file: CrmRefundFile) {
  return file.mime_type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

function useRefundBlob(file: CrmRefundFile) {
  const [state, setState] = useState<{ id?: string; blob?: Blob; url?: string; erro?: string }>({})
  useEffect(() => {
    let vivo = true
    let url: string | undefined
    setState({})
    loadBlob(file)
      .then((blob) => {
        if (!vivo) return
        url = URL.createObjectURL(blob)
        setState({ id: file.id, blob, url })
      })
      .catch((err) => vivo && setState({ id: file.id, erro: err instanceof Error ? err.message : 'Falha ao baixar' }))
    return () => {
      vivo = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [file.id])
  // No carrossel o arquivo troca antes do efeito rodar: não mostrar o anterior.
  return state.id === file.id ? state : {}
}

type PdfJs = typeof import('pdfjs-dist')
let pdfjs: Promise<PdfJs> | null = null

function loadPdfJs() {
  pdfjs ??= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]).then(([m, worker]) => {
    m.GlobalWorkerOptions.workerSrc = worker.default
    return m
  })
  return pdfjs
}

/** Desenha as páginas do PDF em canvas, na largura do container. */
function PdfPages({ blob, maxPages }: { blob: Blob; maxPages?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [erro, setErro] = useState(false)
  const [carregando, setCarregando] = useState(true)

  useEffect(() => {
    const box = ref.current
    if (!box) return
    let cancelado = false
    let destroy: (() => void) | undefined
    setErro(false)
    setCarregando(true)
    ;(async () => {
      const lib = await loadPdfJs()
      const doc = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise
      destroy = () => void doc.destroy()
      const total = Math.min(doc.numPages, maxPages ?? doc.numPages)
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      for (let i = 1; i <= total && !cancelado; i++) {
        const page = await doc.getPage(i)
        const base = page.getViewport({ scale: 1 })
        const largura = box.clientWidth || 600
        const viewport = page.getViewport({ scale: (largura / base.width) * dpr })
        const canvas = document.createElement('canvas')
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        canvas.style.cssText = 'width:100%;display:block;background:#fff'
        if (maxPages == null) canvas.style.marginBottom = '12px'
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('canvas')
        await page.render({ canvasContext: ctx, viewport }).promise
        if (cancelado) break
        box.appendChild(canvas)
        setCarregando(false)
      }
    })().catch(() => { if (!cancelado) setErro(true) })
      .finally(() => { if (!cancelado) setCarregando(false) })
    return () => {
      cancelado = true
      destroy?.()
      box.replaceChildren()
    }
  }, [blob, maxPages])

  return (
    <>
      <div ref={ref} />
      {carregando && !erro && <Centro><Loader2 size={18} className="spin" /></Centro>}
      {erro && <Centro><FileText size={22} /></Centro>}
    </>
  )
}

function Centro({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', padding: 16, color: 'var(--text-secondary)' }}>
      {children}
    </div>
  )
}

/** Miniatura clicável: a imagem em si, ou a primeira página do PDF. */
export function RefundFileThumb({ file, onOpen, onRemove }: {
  file: CrmRefundFile
  onOpen: () => void
  onRemove?: () => void
}) {
  const { blob, url, erro } = useRefundBlob(file)
  return (
    <div style={{ position: 'relative', width: 104 }}>
      <button
        type="button"
        onClick={onOpen}
        title={file.name}
        aria-label={`Abrir ${file.name}`}
        style={{
          width: 104, height: 104, padding: 0, overflow: 'hidden', cursor: 'pointer',
          borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)',
          display: 'block',
        }}
      >
        {erro ? (
          <Centro><ImageOff size={20} /></Centro>
        ) : !blob ? (
          <Centro><Loader2 size={18} className="spin" /></Centro>
        ) : isPdf(file) ? (
          <PdfPages blob={blob} maxPages={1} />
        ) : (
          <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        )}
      </button>
      <div className="text-muted" style={{ fontSize: 11, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {isPdf(file) && <span style={{ fontWeight: 600 }}>PDF · </span>}{file.name}
      </div>
      {onRemove && (
        <button
          type="button"
          className="icon-btn"
          onClick={onRemove}
          aria-label={`Remover anexo ${file.name}`}
          style={{ position: 'absolute', top: 4, right: 4, background: 'var(--bg)', borderRadius: 999 }}
        >
          <X size={13} />
        </button>
      )}
    </div>
  )
}

/** Grade de miniaturas. Clicar abre o visualizador por cima da tela atual. */
export function RefundFileGrid({ files, onRemove }: {
  files: CrmRefundFile[]
  onRemove?: (f: CrmRefundFile) => void
}) {
  const [abertoId, setAbertoId] = useState<string | null>(null)
  const indice = files.findIndex((f) => f.id === abertoId)
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {files.map((f) => (
          <RefundFileThumb
            key={f.id}
            file={f}
            onOpen={() => setAbertoId(f.id)}
            onRemove={onRemove && (() => onRemove(f))}
          />
        ))}
      </div>
      {indice >= 0 && (
        <RefundFileViewer
          files={files}
          index={indice}
          onIndex={(i) => setAbertoId(files[i].id)}
          onClose={() => setAbertoId(null)}
        />
      )}
    </>
  )
}

/**
 * O anexo em tela cheia, dentro do CRM: imagem inteira ou todas as páginas do
 * PDF. Com mais de um anexo vira carrossel: setas na barra, ← → no teclado e
 * deslizar o dedo no celular. Os vizinhos já começam a baixar para a troca
 * ser imediata.
 */
export function RefundFileViewer({ files, index, onIndex, onClose }: {
  files: CrmRefundFile[]
  index: number
  onIndex: (i: number) => void
  onClose: () => void
}) {
  const file = files[index]
  const total = files.length
  const { blob, url, erro } = useRefundBlob(file)
  const toque = useRef<{ x: number; y: number } | null>(null)

  const anterior = index > 0 ? () => onIndex(index - 1) : undefined
  const proximo = index < total - 1 ? () => onIndex(index + 1) : undefined

  useEffect(() => {
    if (files[index - 1]) void loadBlob(files[index - 1]).catch(() => {})
    if (files[index + 1]) void loadBlob(files[index + 1]).catch(() => {})
  }, [files, index])

  useEffect(() => {
    if (total < 2) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable="true"]')) return
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
      else if (e.key === 'ArrowRight' && index < total - 1) onIndex(index + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, total, onIndex])

  // Volta ao topo ao trocar: senão o próximo abre na rolagem do anterior.
  const topo = useRef<HTMLDivElement>(null)
  useEffect(() => {
    topo.current?.scrollIntoView({ block: 'start' })
  }, [file.id])

  return (
    <Modal title={file.name} onClose={onClose}>
      <div
        ref={topo}
        style={{ display: 'grid', gap: 12 }}
        onTouchStart={(e) => {
          const t = e.touches[0]
          toque.current = e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null
        }}
        onTouchEnd={(e) => {
          const ini = toque.current
          toque.current = null
          if (!ini) return
          const t = e.changedTouches[0]
          const dx = t.clientX - ini.x
          const dy = t.clientY - ini.y
          // Só gesto claramente horizontal: rolar o PDF não pode trocar de anexo.
          if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return
          if (dx < 0) proximo?.()
          else anterior?.()
        }}
      >
        <div
          className="flex"
          style={{
            justifyContent: 'space-between', alignItems: 'center', gap: 8,
            position: 'sticky', top: 0, zIndex: 1, background: 'var(--bg)', padding: '6px 0',
          }}
        >
          <span className="text-muted" style={{ fontSize: 12 }}>
            {isPdf(file) ? 'PDF' : 'Imagem'}
            {file.original_bytes ? ` · ${formatBytes(file.original_bytes)}` : ''}
          </span>
          <div className="flex" style={{ alignItems: 'center', gap: 6 }}>
            {total > 1 && (
              <>
                <button type="button" className="btn btn-ghost btn-sm" onClick={anterior} disabled={!anterior} aria-label="Anexo anterior">
                  <ChevronLeft size={15} />
                </button>
                <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', minWidth: 36, textAlign: 'center' }}>
                  {index + 1} / {total}
                </span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={proximo} disabled={!proximo} aria-label="Próximo anexo">
                  <ChevronRight size={15} />
                </button>
              </>
            )}
            {url && (
              <a className="btn btn-ghost btn-sm" href={url} download={file.name}>
                <Download size={13} /> Baixar
              </a>
            )}
          </div>
        </div>
        {erro ? (
          <p style={{ color: 'var(--danger)', fontSize: 14 }}>Não foi possível abrir o anexo: {erro}</p>
        ) : !blob ? (
          <Centro><Loader2 size={20} className="spin" /></Centro>
        ) : isPdf(file) ? (
          <PdfPages key={file.id} blob={blob} />
        ) : (
          <img key={file.id} src={url} alt={file.name} style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 8 }} />
        )}
      </div>
    </Modal>
  )
}
