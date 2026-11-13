import { useEffect, useState } from 'react'
import { Clock, MessageSquareText, Trash2, Zap } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { toast } from '@/store/toastStore'
import { atendimentoService } from '@/services/atendimentoService'
import type { WaQuickReply, WaSettings } from '@/types'

const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

/** "0930" / "9:30" / "09:30" → "09:30"; vazio se não for hora válida. */
function normalizaHora(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 4)
  if (d.length < 3) return ''
  const h = d.length === 3 ? d.slice(0, 1) : d.slice(0, 2)
  const m = d.slice(-2)
  if (Number(h) > 23 || Number(m) > 59) return ''
  return `${h.padStart(2, '0')}:${m}`
}

export function HoraInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <input
      className="input"
      style={{ width: 84 }}
      inputMode="numeric"
      maxLength={5}
      placeholder="hh:mm"
      aria-label={label}
      value={draft}
      onChange={(e) => {
        const d = e.target.value.replace(/\D/g, '').slice(0, 4)
        setDraft(d.length > 2 ? `${d.slice(0, 2)}:${d.slice(2)}` : d)
      }}
      onBlur={() => {
        const ok = normalizaHora(draft)
        if (ok) onChange(ok)
        else setDraft(value)
      }}
    />
  )
}

/** Saudação e mensagem de fora do horário (139). Salva junto com as outras configurações. */
export function AutoMessagesCard({ settings, set, dirty, saving, save }: {
  settings: WaSettings
  set: (patch: Partial<WaSettings>) => void
  dirty: boolean
  saving: boolean
  save: () => void
}) {
  const h = settings.business_hours
  const toggleDia = (d: number) => {
    const days = h.days.includes(d) ? h.days.filter((x) => x !== d) : [...h.days, d].sort()
    set({ business_hours: { ...h, days } })
  }

  return (
    <section className="card">
      <h3 className="card-title"><MessageSquareText size={15} /> Mensagens automáticas</h3>

      <label className="at-toggle">
        <input type="checkbox" checked={settings.auto_greeting_on} onChange={(e) => set({ auto_greeting_on: e.target.checked })} />
        <span>
          <strong>Saudação ao primeiro contato</strong>
          <span className="text-muted">
            Enviada quando o cliente escreve e não tinha falado nas últimas 12 horas. Use {'{nome}'} para o primeiro nome do cliente.
          </span>
        </span>
      </label>
      {settings.auto_greeting_on && (
        <textarea
          className="input"
          rows={3}
          maxLength={1000}
          style={{ margin: '4px 0 12px 28px', width: 'calc(100% - 28px)' }}
          placeholder="Ex.: Olá {nome}! Já vamos te atender."
          value={settings.auto_greeting_text ?? ''}
          onChange={(e) => set({ auto_greeting_text: e.target.value })}
          aria-label="Texto da saudação"
        />
      )}

      <label className="at-toggle">
        <input type="checkbox" checked={settings.auto_away_on} onChange={(e) => set({ auto_away_on: e.target.checked })} />
        <span>
          <strong>Mensagem fora do horário de atendimento</strong>
          <span className="text-muted">
            Enviada quando o cliente escreve fora do horário abaixo (no máximo uma vez a cada 6 horas por conversa). Substitui a saudação nesse caso.
          </span>
        </span>
      </label>
      {settings.auto_away_on && (
        <textarea
          className="input"
          rows={3}
          maxLength={1000}
          style={{ margin: '4px 0 12px 28px', width: 'calc(100% - 28px)' }}
          placeholder="Ex.: Estamos fora do horário. Voltamos amanhã às 9h."
          value={settings.auto_away_text ?? ''}
          onChange={(e) => set({ auto_away_text: e.target.value })}
          aria-label="Texto de fora do horário"
        />
      )}

      {settings.auto_away_on && (
        <div style={{ margin: '0 0 12px 28px' }}>
          <div className="text-secondary" style={{ fontSize: 12.5, marginBottom: 6 }}>
            <Clock size={12} /> Horário de atendimento (Brasília)
          </div>
          <div className="flex" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {DIAS.map((nome, d) => (
              <button
                key={nome}
                type="button"
                className={`btn btn-sm ${h.days.includes(d) ? 'btn-primary' : 'btn-ghost'}`}
                aria-pressed={h.days.includes(d)}
                onClick={() => toggleDia(d)}
              >
                {nome}
              </button>
            ))}
          </div>
          <div className="flex" style={{ alignItems: 'center', gap: 8 }}>
            <span>Das</span>
            <HoraInput label="Início" value={h.start} onChange={(v) => set({ business_hours: { ...h, start: v } })} />
            <span>às</span>
            <HoraInput label="Fim" value={h.end} onChange={(v) => set({ business_hours: { ...h, end: v } })} />
          </div>
        </div>
      )}

      <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
          {saving ? <span className="spinner" /> : 'Salvar'}
        </button>
      </div>
    </section>
  )
}

/** Respostas rápidas (138): o atendente chama com "/atalho" no campo de mensagem. */
export function QuickRepliesCard() {
  const profile = useAuthStore((s) => s.profile)
  const [rows, setRows] = useState<WaQuickReply[]>([])
  const [shortcut, setShortcut] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => { atendimentoService.listQuickReplies().then(setRows) }
  useEffect(load, [])

  async function add() {
    if (!profile) return
    const s = shortcut.trim().toLowerCase().replace(/^\//, '')
    if (!/^[a-z0-9_-]{1,30}$/.test(s)) return toast.error('Atalho: só letras sem acento, números, - e _ (até 30).')
    if (!body.trim()) return toast.error('Escreva o texto da resposta.')
    setBusy(true)
    try {
      await atendimentoService.saveQuickReply(profile.organization_id, s, body.trim(), profile.id)
      setShortcut('')
      setBody('')
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar a resposta')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    try {
      await atendimentoService.deleteQuickReply(id)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao apagar')
    }
  }

  return (
    <section className="card">
      <h3 className="card-title"><Zap size={15} /> Respostas rápidas</h3>
      <p className="text-muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
        Textos prontos. No campo de mensagem, o atendente digita "/" e o atalho. Use {'{nome}'} para o primeiro nome do cliente.
      </p>
      {rows.length === 0 ? (
        <p className="text-muted" style={{ fontSize: 13, marginBottom: 12 }}>Nenhuma resposta cadastrada.</p>
      ) : (
        <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
          {rows.map((r) => (
            <div key={r.id} className="flex" style={{ gap: 10, alignItems: 'flex-start' }}>
              <strong style={{ color: 'var(--primary-text)', flexShrink: 0 }}>/{r.shortcut}</strong>
              <span style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13 }}>{r.body}</span>
              <button className="icon-btn" onClick={() => remove(r.id)} aria-label={`Apagar /${r.shortcut}`}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <input className="input" style={{ width: 150 }} placeholder="/atalho" maxLength={31} value={shortcut} onChange={(e) => setShortcut(e.target.value)} aria-label="Atalho" />
        <textarea className="input" style={{ flex: 1, minWidth: 220 }} rows={2} maxLength={4000} placeholder="Texto da resposta" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Texto" />
        <button className="btn btn-primary" onClick={add} disabled={busy}>Adicionar</button>
      </div>
    </section>
  )
}
