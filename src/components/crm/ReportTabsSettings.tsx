import { useEffect, useState } from 'react'
import { BarChart3 } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { toast } from '@/store/toastStore'
import { crmService } from '@/services/crmService'
import { REPORT_TABS } from './CrmReports'

/**
 * Configurações → Organização → Relatórios (146): quais abas aparecem na
 * tela de Relatórios. Desligar só esconde a aba; os dados continuam no banco e
 * voltam ao religar. Pelo menos uma aba fica sempre ligada.
 */
export function ReportTabsSettings() {
  const profile = useAuthStore((s) => s.profile)
  const [off, setOff] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { crmService.getReportTabsOff().then(setOff).catch(() => setOff([])) }, [])

  async function alternar(id: string) {
    if (!profile || off === null) return
    const desligando = !off.includes(id)
    const next = desligando ? [...off, id] : off.filter((x) => x !== id)
    if (REPORT_TABS.every((t) => next.includes(t.id))) {
      toast.error('Deixe pelo menos uma aba ligada.')
      return
    }
    setBusy(true)
    try {
      await crmService.saveReportTabsOff(profile.organization_id, next)
      setOff(next)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h3 className="card-title"><BarChart3 size={15} /> Abas dos relatórios</h3>
      <p className="text-muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
        Escolha quais abas aparecem em Relatórios. Desligar só esconde: nada é apagado, e ao ligar de novo a aba volta com os mesmos dados.
      </p>
      {off === null ? <div className="spinner" /> : (
        <div style={{ display: 'grid', gap: 10 }}>
          {REPORT_TABS.map((t) => (
            <label key={t.id} className="at-toggle">
              <input type="checkbox" checked={!off.includes(t.id)} disabled={busy} onChange={() => { void alternar(t.id) }} />
              <span>
                <strong>{t.label}</strong>
                <span className="text-muted">{t.sub}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </section>
  )
}
