import { createPortal } from 'react-dom'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'
import { useToastStore, type ToastType } from '@/store/toastStore'

const ICON: Record<ToastType, typeof Info> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  if (toasts.length === 0) return null

  return createPortal(
    <div className="toast-container">
      {toasts.map((t) => {
        const Icon = ICON[t.type]
        return (
          <div key={t.id} className={`toast toast-${t.type}`} role="status">
            <Icon className="toast-icon" />
            <span className="toast-msg">{t.message}</span>
            <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="Fechar">
              <X />
            </button>
          </div>
        )
      })}
    </div>,
    document.body,
  )
}
