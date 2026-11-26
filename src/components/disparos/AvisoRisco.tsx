import { ShieldAlert } from 'lucide-react'
import { Modal } from '@/components/ui'

const CHAVE = 'infuse-aviso-envio-em-massa'
const VALIDADE_MS = 30 * 86_400_000

/** Já deu ciente nos últimos 30 dias neste navegador? */
export function avisoJaLido(): boolean {
  try { return Date.now() - Number(localStorage.getItem(CHAVE) ?? 0) < VALIDADE_MS } catch { return false }
}

export function AvisoRisco({ onCiente, onClose }: { onCiente: () => void; onClose: () => void }) {
  function ciente() {
    try { localStorage.setItem(CHAVE, String(Date.now())) } catch { /* sem armazenamento */ }
    onCiente()
  }
  return (
    <Modal title="Antes de enviar em massa" onClose={onClose} variant="dialog" small>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <ShieldAlert size={20} style={{ flexShrink: 0, marginTop: 2 }} />
        <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>
          <p>
            O envio em massa pode causar <strong>restrições ou banimento do número</strong> por parte do
            WhatsApp, caso ele considere as mensagens impróprias ou spam.
          </p>
          <p style={{ marginTop: 8 }}>
            Envie só para quem espera receber o seu contato, evite mensagens repetidas e mantenha o ritmo
            mais lento. <strong>A Infuse não se responsabiliza</strong> por restrições, suspensões ou
            banimentos aplicados pelo WhatsApp.
          </p>
        </div>
      </div>
      <div className="flex" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={ciente}>Estou ciente, continuar</button>
      </div>
    </Modal>
  )
}
