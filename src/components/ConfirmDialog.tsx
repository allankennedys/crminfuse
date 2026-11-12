import { useConfirmStore } from '@/store/confirmStore'
import { Modal } from './ui'

export function ConfirmDialog() {
  const current = useConfirmStore((s) => s.current)
  const respond = useConfirmStore((s) => s.respond)

  if (!current) return null

  return (
    <Modal title={current.title ?? 'Confirmar'} onClose={() => respond(false)}>
      {/* pre-line para a mensagem poder ter parágrafo. Nenhuma das mensagens
          existentes usa \n, então nada muda de aparência — só passa a existir
          a opção de separar "o que vai acontecer" de "quando usar isto". */}
      <p style={{
        fontSize: 14,
        color: 'var(--text-secondary)',
        lineHeight: 1.55,
        whiteSpace: 'pre-line',
      }}>
        {current.message}
      </p>
      <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 22 }}>
        <button className="btn btn-ghost" onClick={() => respond(false)}>
          {current.cancelLabel ?? 'Cancelar'}
        </button>
        <button
          className={`btn ${current.danger ? 'btn-danger' : 'btn-primary'}`}
          onClick={() => respond(true)}
          autoFocus
        >
          {current.confirmLabel ?? 'Confirmar'}
        </button>
      </div>
    </Modal>
  )
}
