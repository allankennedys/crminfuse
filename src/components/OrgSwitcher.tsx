import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { toast } from '@/store/toastStore'

/**
 * Troca de empresa, ao lado do nome. Só aparece para quem tem mais de uma.
 * Trocar recarrega o app: tudo (telas, tempo real, permissões) vem da empresa nova.
 */
export function OrgSwitcher() {
  const organizations = useAuthStore((s) => s.organizations)
  const trocar = useAuthStore((s) => s.trocarOrganizacao)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const fora = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', fora)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', fora); document.removeEventListener('keydown', esc) }
  }, [open])

  if (organizations.length < 2) return null

  async function escolher(id: string, atual: boolean) {
    if (atual || busy) { setOpen(false); return }
    setBusy(true)
    try { await trocar(id) }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Falha ao trocar de empresa'); setBusy(false) }
  }

  return (
    <div className="org-switch" ref={ref}>
      <button type="button" className="icon-btn" aria-label="Trocar de empresa" aria-expanded={open} title="Trocar de empresa" onClick={() => setOpen((v) => !v)}>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="org-switch-menu" role="menu">
          {organizations.map((o) => (
            <button key={o.organization_id} type="button" role="menuitem" className="org-switch-item" disabled={busy} onClick={() => escolher(o.organization_id, o.is_current)}>
              <span className="org-switch-name">{o.name}</span>
              <span className="text-muted org-switch-role">{o.role === 'admin' ? 'Administrador' : 'Atendente'}</span>
              {o.is_current && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
