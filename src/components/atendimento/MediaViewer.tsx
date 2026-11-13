import { useCallback, useEffect, useRef, useState, type TouchEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileText, X as XIcon } from 'lucide-react'
import type { WaMessage } from '@/types'
import { formatDayLabel, formatTime } from './format'

export type MediaKind = 'image' | 'video' | 'pdf'

/** Uma mídia que abre no visualizador. */
export type MediaItem = {
  id: string
  kind: MediaKind
  url: string
  name: string | null
  caption: string | null
  at: string
  author: string
}

/**
 * O que abre no visualizador: foto, vídeo e PDF. Arquivo mandado "como
 * documento" também conta pelo tipo (foto sem compressão, vídeo, PDF). O
 * resto (planilha, zip...) continua só baixando. Figurinha não abre.
 */
export function mediaKind(m: Pick<WaMessage, 'type' | 'media_mime' | 'media_name'>): MediaKind | null {
  const mime = (m.media_mime ?? '').toLowerCase()
  if (m.type === 'image') return 'image'
  if (m.type === 'video') return 'video'
  if (m.type !== 'document') return null
  if (mime === 'application/pdf' || /\.pdf$/i.test(m.media_name ?? '')) return 'pdf'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  return null
}

/** Link assinado que baixa em vez de abrir (o Storage aceita ?download=). */
function downloadUrl(item: MediaItem) {
  const nome = item.name || (item.kind === 'pdf' ? 'documento.pdf' : item.kind === 'video' ? 'video.mp4' : 'imagem.jpg')
  return `${item.url}${item.url.includes('?') ? '&' : '?'}download=${encodeURIComponent(nome)}`
}

/**
 * Visualizador em tela cheia por cima da conversa. Passa entre as mídias da
 * conversa com as setas da tela, as do teclado (← →) ou arrastando para o
 * lado no celular; Esc fecha. Foto: clique amplia. PDF: no leitor do próprio
 * navegador.
 */
export function MediaViewer({ items, startId, onClose }: {
  items: MediaItem[]
  startId: string
  onClose: () => void
}) {
  const [currentId, setCurrentId] = useState(startId)
  const [zoom, setZoom] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const touchRef = useRef<{ x: number; y: number } | null>(null)

  const index = items.findIndex((i) => i.id === currentId)
  const item = index >= 0 ? items[index] : null
  const temAnterior = index > 0
  const temProxima = index >= 0 && index < items.length - 1

  const ir = useCallback((delta: number) => {
    const alvo = items[index + delta]
    if (!alvo) return
    setCurrentId(alvo.id)
    setZoom(false)
  }, [items, index])

  // A mídia aberta sumiu da lista (ex.: link expirou e foi trocado): fecha.
  useEffect(() => { if (!item) onClose() }, [item, onClose])

  // Foco: entra no visualizador ao abrir e volta para onde estava ao fechar.
  useEffect(() => {
    const antes = document.activeElement as HTMLElement | null
    boxRef.current?.focus()
    return () => { antes?.focus?.() }
  }, [])

  // Teclado. As setas não trocam de mídia quando o foco está no vídeo —
  // lá elas avançam/voltam o próprio vídeo.
  const irRef = useRef(ir)
  const closeRef = useRef(onClose)
  irRef.current = ir
  closeRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return }
      if (e.target instanceof HTMLVideoElement) return
      if (e.key === 'ArrowLeft') { e.preventDefault(); irRef.current(-1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); irRef.current(1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0]
    touchRef.current = { x: t.clientX, y: t.clientY }
  }
  const onTouchEnd = (e: TouchEvent) => {
    const ini = touchRef.current
    touchRef.current = null
    if (!ini || zoom) return
    const t = e.changedTouches[0]
    const dx = t.clientX - ini.x
    const dy = t.clientY - ini.y
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) ir(dx < 0 ? 1 : -1)
  }

  if (!item) return null

  return createPortal(
    <div
      ref={boxRef}
      className="mv"
      role="dialog"
      aria-modal="true"
      aria-label={`${item.kind === 'pdf' ? 'Documento' : item.kind === 'video' ? 'Vídeo' : 'Imagem'} ${index + 1} de ${items.length}`}
      tabIndex={-1}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="mv-top">
        <div className="mv-info">
          <strong>{item.author}</strong>
          <span>
            {formatDayLabel(item.at)} · {formatTime(item.at)}
            {item.name && item.kind === 'pdf' ? ` · ${item.name}` : ''}
          </span>
        </div>
        {items.length > 1 && <span className="mv-count">{index + 1} de {items.length}</span>}
        <div className="mv-actions">
          {item.kind === 'pdf' && (
            <a className="mv-btn" href={item.url} target="_blank" rel="noreferrer" title="Abrir em outra aba" aria-label="Abrir em outra aba">
              <ExternalLink size={18} />
            </a>
          )}
          <a className="mv-btn" href={downloadUrl(item)} title="Baixar" aria-label="Baixar">
            <Download size={18} />
          </a>
          <button type="button" className="mv-btn" onClick={onClose} title="Fechar (Esc)" aria-label="Fechar">
            <XIcon size={20} />
          </button>
        </div>
      </div>

      <div
        className={`mv-stage${zoom ? ' mv-zoom' : ''}`}
        onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      >
        {item.kind === 'image' ? (
          <img
            key={item.id}
            src={item.url}
            alt={item.caption || item.name || 'Imagem'}
            className="mv-img"
            onClick={() => setZoom((z) => !z)}
            title={zoom ? 'Clique para ajustar à tela' : 'Clique para ampliar'}
          />
        ) : item.kind === 'video' ? (
          <video key={item.id} src={item.url} className="mv-video" controls autoPlay playsInline />
        ) : (
          <PdfFrame key={item.id} item={item} />
        )}
      </div>

      {/* Fora do palco: com a foto ampliada o palco rola, e as setas ficam paradas. */}
      {temAnterior && (
        <button type="button" className="mv-nav mv-prev" onClick={() => ir(-1)} title="Anterior (←)" aria-label="Anterior">
          <ChevronLeft size={26} />
        </button>
      )}
      {temProxima && (
        <button type="button" className="mv-nav mv-next" onClick={() => ir(1)} title="Próxima (→)" aria-label="Próxima">
          <ChevronRight size={26} />
        </button>
      )}

      {item.caption && <div className="mv-caption">{item.caption}</div>}
    </div>,
    document.body,
  )
}

/**
 * PDF no leitor do navegador. Baixa o arquivo e mostra a partir de um blob
 * local: assim o PDF abre mesmo que o servidor do arquivo não permita ser
 * exibido dentro de outra página, e com o tipo certo.
 */
function PdfFrame({ item }: { item: MediaItem }) {
  const [src, setSrc] = useState<string | null>(null)
  const [erro, setErro] = useState(false)

  useEffect(() => {
    let vivo = true
    let local: string | null = null
    fetch(item.url)
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.blob() })
      .then((b) => {
        if (!vivo) return
        local = URL.createObjectURL(new Blob([b], { type: 'application/pdf' }))
        setSrc(local)
      })
      .catch(() => { if (vivo) setErro(true) })
    return () => {
      vivo = false
      if (local) URL.revokeObjectURL(local)
    }
  }, [item.url])

  if (erro) {
    return (
      <div className="mv-pdf-msg">
        <FileText size={36} />
        <p>Não foi possível mostrar este PDF aqui.</p>
        <a className="btn btn-primary" href={item.url} target="_blank" rel="noreferrer">
          <ExternalLink size={15} /> Abrir em outra aba
        </a>
      </div>
    )
  }
  if (!src) return <div className="mv-pdf-msg"><span className="spinner" /> Carregando PDF…</div>
  return <iframe className="mv-pdf" src={src} title={item.name || 'Documento PDF'} />
}
