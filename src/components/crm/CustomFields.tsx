import { createContext, useEffect, useState } from 'react'
import { ListPlus, Pencil, Trash2 } from 'lucide-react'
import { DateInput } from '@/components/ui'
import { confirmDialog } from '@/store/confirmStore'
import { toast } from '@/store/toastStore'
import { useAuthStore } from '@/store/authStore'
import { crmService } from '@/services/crmService'
import type { CrmCustomField } from '@/types'

const KIND_LABEL: Record<CrmCustomField['kind'], string> = {
  texto: 'Texto', numero: 'Número', data: 'Data', lista: 'Lista de opções',
}

/** Campos que aparecem no cartão do funil (141); o funil fornece, o cartão lê. */
export const CardFieldsContext = createContext<CrmCustomField[]>([])

/** Número digitado com vírgula ou ponto → "1234.5" (o formato guardado); '' se não for número. */
function numeroParaGuardar(raw: string): string {
  const t = raw.trim().replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')
  return /^-?\d+(\.\d+)?$/.test(t) ? t : ''
}

/** Valor guardado → como mostrar (data em dd/mm/aaaa, número com vírgula). */
export function formatCustomValue(f: CrmCustomField, v: string | undefined): string {
  if (!v) return ''
  if (f.kind === 'data') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
    return m ? `${m[3]}/${m[2]}/${m[1]}` : v
  }
  if (f.kind === 'numero') return v.replace('.', ',')
  return v
}

/**
 * Campos personalizados do contato (140): um input por campo, do tipo certo.
 * Controlado pelo pai: `values` é { id do campo: valor em texto }.
 */
export function CustomFieldsEditor({ fields, values, onChange, idPrefix = 'cf' }: {
  fields: CrmCustomField[]
  values: Record<string, string>
  onChange: (next: Record<string, string>) => void
  idPrefix?: string
}) {
  const set = (id: string, v: string) => {
    const next = { ...values }
    if (v) next[id] = v
    else delete next[id]
    onChange(next)
  }
  return (
    <>
      {fields.map((f) => {
        const id = `${idPrefix}-${f.id}`
        const v = values[f.id] ?? ''
        return (
          <div className="field" key={f.id}>
            <label htmlFor={id}>{f.name}</label>
            {f.kind === 'data' ? (
              <DateInput id={id} value={v} onChange={(iso) => set(f.id, iso)} />
            ) : f.kind === 'lista' ? (
              <select id={id} className="input" value={v} onChange={(e) => set(f.id, e.target.value)}>
                <option value="">—</option>
                {/* Valor antigo que saiu da lista continua visível até ser trocado. */}
                {v && !f.options.includes(v) && <option value={v}>{v}</option>}
                {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.kind === 'numero' ? (
              <NumeroInput id={id} value={v} onChange={(x) => set(f.id, x)} />
            ) : (
              <input id={id} className="input" maxLength={200} value={v} onChange={(e) => set(f.id, e.target.value)} />
            )}
          </div>
        )
      })}
    </>
  )
}

function NumeroInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value.replace('.', ','))
  useEffect(() => {
    setDraft((cur) => (numeroParaGuardar(cur) === value ? cur : value.replace('.', ',')))
  }, [value])
  return (
    <input
      id={id}
      className="input"
      inputMode="decimal"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value)
        const n = numeroParaGuardar(e.target.value)
        if (n || !e.target.value.trim()) onChange(n)
      }}
      onBlur={() => setDraft(value.replace('.', ','))}
    />
  )
}

/** Cadastro dos campos personalizados (Configurações → Organização). */
export function CustomFieldsSettings() {
  const profile = useAuthStore((s) => s.profile)
  const [fields, setFields] = useState<CrmCustomField[] | null>(null)
  const [editing, setEditing] = useState<Partial<CrmCustomField> | null>(null)
  const [optionsText, setOptionsText] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => { crmService.listCustomFields().then(setFields) }
  useEffect(load, [])

  const start = (f?: CrmCustomField) => {
    setEditing(f ? { ...f } : { name: '', kind: 'texto', options: [] })
    setOptionsText((f?.options ?? []).join('\n'))
  }

  async function save() {
    if (!editing || !profile) return
    const name = (editing.name ?? '').trim()
    if (!name) return toast.error('Dê um nome ao campo.')
    const options = [...new Set(optionsText.split('\n').map((o) => o.trim()).filter(Boolean))]
    if (editing.kind === 'lista' && options.length === 0) return toast.error('Informe ao menos uma opção.')
    setBusy(true)
    try {
      await crmService.saveCustomField(
        profile.organization_id,
        { id: editing.id, name, kind: editing.kind ?? 'texto', options, show_on_card: editing.show_on_card },
        fields?.length ?? 0,
      )
      setEditing(null)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar o campo')
    } finally {
      setBusy(false)
    }
  }

  async function remove(f: CrmCustomField) {
    if (!(await confirmDialog({
      title: 'Apagar campo',
      message: `Apagar "${f.name}"? O valor dele some de todos os contatos. A ação não pode ser desfeita.`,
      confirmLabel: 'Apagar', danger: true,
    }))) return
    try { await crmService.deleteCustomField(f.id); load() }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Falha ao apagar') }
  }

  return (
    <section className="card">
      <h3 className="card-title"><ListPlus size={15} /> Campos personalizados</h3>
      <p className="text-muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
        Informações extras que você quer guardar em cada contato (cidade, interesse, plano…). Aparecem no
        cadastro do contato, no painel do cliente do atendimento e na exportação.
      </p>
      {fields === null ? <div className="spinner" /> : fields.length === 0 ? (
        <p className="text-muted" style={{ fontSize: 13, marginBottom: 12 }}>Nenhum campo criado.</p>
      ) : (
        <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
          {fields.map((f) => (
            <div key={f.id} className="flex" style={{ gap: 10, alignItems: 'center' }}>
              <strong style={{ flex: 1, minWidth: 0 }}>{f.name}</strong>
              <span className="text-muted" style={{ fontSize: 12 }}>
                {KIND_LABEL[f.kind]}{f.kind === 'lista' ? ` (${f.options.length})` : ''}{f.show_on_card ? ' · no cartão' : ''}
              </span>
              <button className="icon-btn" onClick={() => start(f)} aria-label={`Editar ${f.name}`}><Pencil size={14} /></button>
              <button className="icon-btn" onClick={() => remove(f)} aria-label={`Apagar ${f.name}`}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}

      {editing ? (
        <div className="at-client-form">
          <div className="field">
            <label htmlFor="cf-nome">Nome do campo</label>
            <input id="cf-nome" className="input" maxLength={60} value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus />
          </div>
          <div className="field">
            <label htmlFor="cf-tipo">Tipo</label>
            <select
              id="cf-tipo"
              className="input"
              value={editing.kind ?? 'texto'}
              // O tipo não muda depois de criado: valores já guardados deixariam de fazer sentido.
              disabled={Boolean(editing.id)}
              onChange={(e) => setEditing({ ...editing, kind: e.target.value as CrmCustomField['kind'] })}
            >
              {(Object.keys(KIND_LABEL) as CrmCustomField['kind'][]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </div>
          {editing.kind === 'lista' && (
            <div className="field">
              <label htmlFor="cf-opcoes">Opções (uma por linha)</label>
              <textarea id="cf-opcoes" className="input" rows={4} value={optionsText} onChange={(e) => setOptionsText(e.target.value)} />
            </div>
          )}
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={Boolean(editing.show_on_card)}
              onChange={(e) => setEditing({ ...editing, show_on_card: e.target.checked })}
            />
            <span>Mostrar no cartão do funil</span>
          </label>
          <div className="flex" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={() => setEditing(null)} disabled={busy}>Cancelar</button>
            <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? <span className="spinner" /> : 'Salvar'}</button>
          </div>
        </div>
      ) : (
        <button className="btn btn-ghost btn-sm" onClick={() => start()}>Novo campo</button>
      )}
    </section>
  )
}
