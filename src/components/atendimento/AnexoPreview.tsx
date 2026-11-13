import { useEffect, useMemo, useState } from 'react'
import { FileText, Headphones, Maximize2, Play, X as XIcon } from 'lucide-react'
import { Modal } from '@/components/ui'
import { formatBytes } from './format'

type Tipo = 'imagem' | 'video' | 'audio' | 'pdf' | 'documento'

const tipoDe = (f: File): Tipo =>
  f.type.startsWith('image/') ? 'imagem'
    : f.type.startsWith('video/') ? 'video'
      : f.type.startsWith('audio/') ? 'audio'
        : (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) ? 'pdf'
          : 'documento'

/** URL temporária do arquivo escolhido, liberada ao trocar ou sair. */
function useObjectUrl(file: File): string {
  const url = useMemo(() => URL.createObjectURL(file), [file])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  return url
}

/**
 * O anexo escolhido, antes de enviar: miniatura (foto e vídeo), ícone
 * (documento e áudio), nome e tamanho. Clicar abre a prévia grande, para
 * conferir o que vai ao cliente enquanto se escreve a legenda.
 */
export function AnexoPreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useObjectUrl(file)
  const tipo = tipoDe(file)
  const [aberto, setAberto] = useState(false)
  const [erroMiniatura, setErroMiniatura] = useState(false)

  const podeVer = tipo !== 'documento'

  return (
    <>
      <div className="at-attach-card">
        <button
          type="button"
          className="at-attach-thumb"
          onClick={() => podeVer && setAberto(true)}
          disabled={!podeVer}
          aria-label={podeVer ? 'Ver prévia do anexo' : undefined}
          title={podeVer ? 'Ver prévia' : undefined}
        >
          {tipo === 'imagem' && !erroMiniatura ? (
            <img src={url} alt="" onError={() => setErroMiniatura(true)} />
          ) : tipo === 'video' && !erroMiniatura ? (
            <>
              <video src={`${url}#t=0.1`} preload="metadata" muted playsInline onError={() => setErroMiniatura(true)} />
              <span className="at-attach-play" aria-hidden="true"><Play size={16} fill="currentColor" /></span>
            </>
          ) : tipo === 'audio' ? (
            <Headphones size={22} />
          ) : (
            <FileText size={22} />
          )}
        </button>
        <div className="at-attach-info">
          <span className="at-attach-name">{file.name}</span>
          <span className="text-muted">
            {tipo === 'pdf' ? 'PDF · ' : ''}{formatBytes(file.size)}
          </span>
        </div>
        {podeVer && (
          <button type="button" className="icon-btn" onClick={() => setAberto(true)} aria-label="Ampliar prévia" title="Ampliar">
            <Maximize2 size={14} />
          </button>
        )}
        <button type="button" className="icon-btn" onClick={onRemove} aria-label="Remover anexo" title="Remover">
          <XIcon size={15} />
        </button>
      </div>

      {aberto && (
        <Modal title={file.name} onClose={() => setAberto(false)} variant="dialog" wide>
          <div className="at-attach-full">
            {tipo === 'imagem' && <img src={url} alt={file.name} />}
            {tipo === 'video' && <video src={url} controls autoPlay playsInline />}
            {tipo === 'audio' && <audio src={url} controls autoPlay />}
            {tipo === 'pdf' && <iframe src={url} title={file.name} />}
          </div>
        </Modal>
      )}
    </>
  )
}
