import { useCallback, useEffect, useMemo, useState } from 'react'
import { AutoMessagesCard, QuickRepliesCard } from './AtendimentoAutomaticas'
import { NumerosPorAtendenteCard } from './NumerosPorAtendente'
import { ArrowDown, ArrowUp, CheckCircle2, Eye, Gauge, Megaphone, Plus, Shuffle, Tag, Trash2, Workflow, X as XIcon } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { Loader } from '@/components/ui'
import { toast } from '@/store/toastStore'
import { confirmDialog } from '@/store/confirmStore'
import { atendimentoService, sessionLabel } from '@/services/atendimentoService'
import type { WaAgentLimit, WaAssignMode, WaAttendant, WaRoutingRule, WaSession, WaSettings, WaSourceRule } from '@/types'

const MODES: { id: WaAssignMode; label: string; hint: string }[] = [
  { id: 'manual', label: 'Manual', hint: 'A conversa fica na Fila até alguém atribuir.' },
  { id: 'aleatoria', label: 'Aleatória', hint: 'Sorteia um dos atendentes participantes.' },
  { id: 'rodizio', label: 'Rodízio', hint: 'Um de cada vez: vai para quem recebeu automaticamente há mais tempo.' },
  { id: 'fixo', label: 'Sempre para a mesma pessoa', hint: 'Toda conversa nova vai para o atendente escolhido.' },
]

/**
 * Configurações → Atendimento (119). Quem pode: atendimento.configurar.
 * O banco recusa de novo (RLS de wa_settings e wa_routing_rules).
 */
export function AtendimentoSettings() {
  const profile = useAuthStore((s) => s.profile)
  const [settings, setSettings] = useState<WaSettings | null>(null)
  const [saved, setSaved] = useState<string>('')
  const [attendants, setAttendants] = useState<WaAttendant[]>([])
  const [sessions, setSessions] = useState<WaSession[]>([])
  const [rules, setRules] = useState<WaRoutingRule[] | null>(null)
  const [limits, setLimits] = useState<Map<string, number | null>>(new Map())
  const [newReason, setNewReason] = useState('')
  const [sources, setSources] = useState<WaSourceRule[]>([])
  const [phrase, setPhrase] = useState('')
  const [origemNova, setOrigemNova] = useState('')
  const [saving, setSaving] = useState(false)

  // Formulário de regra nova
  const [kind, setKind] = useState<'palavra' | 'numero'>('palavra')
  const [keywords, setKeywords] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [target, setTarget] = useState('')
  const [adding, setAdding] = useState(false)

  const loadSources = useCallback(() => {
    atendimentoService.listSourceRules().then(setSources).catch(() => setSources([]))
  }, [])

  const loadRules = useCallback(() => {
    atendimentoService.listRules().then(setRules).catch((err) => {
      toast.error(err instanceof Error ? err.message : 'Falha ao carregar as regras')
      setRules([])
    })
  }, [])

  useEffect(() => {
    if (!profile) return
    atendimentoService.getSettings(profile.organization_id).then((s) => {
      setSettings(s)
      setSaved(JSON.stringify(s))
    })
    atendimentoService.attendants().then(setAttendants).catch(() => setAttendants([]))
    atendimentoService.sessions().then(setSessions).catch(() => setSessions([]))
    atendimentoService.listAgentLimits()
      .then((rows: WaAgentLimit[]) => setLimits(new Map(rows.map((r) => [r.user_id, r.max_open]))))
      .catch(() => setLimits(new Map()))
    loadRules()
    loadSources()
  }, [profile, loadRules])

  const names = useMemo(() => new Map(attendants.map((a) => [a.id, a.name])), [attendants])
  const sessionsById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])

  if (!settings || rules === null) return <Loader />

  const dirty = JSON.stringify(settings) !== saved
  const set = (patch: Partial<WaSettings>) => setSettings((cur) => (cur ? { ...cur, ...patch } : cur))

  async function save() {
    if (!settings || !profile) return
    if (settings.assign_mode === 'fixo' && !settings.fixed_user) {
      toast.error('Escolha para quem vão as conversas.')
      return
    }
    setSaving(true)
    try {
      await atendimentoService.saveSettings(settings, profile.id)
      setSaved(JSON.stringify(settings))
      // Limite maior ou distribuição ligada agora: a fila que estava parada anda.
      const n = await atendimentoService.dispatchNow().catch(() => 0)
      toast.success(n > 0
        ? `Configurações salvas. ${n} conversa(s) da fila distribuída(s).`
        : 'Configurações do atendimento salvas')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar')
    } finally {
      setSaving(false)
    }
  }

  const togglePool = (id: string) => {
    const pool = settings.pool.includes(id) ? settings.pool.filter((x) => x !== id) : [...settings.pool, id]
    set({ pool })
  }

  async function addRule() {
    if (!profile || !rules) return
    const words = keywords.split(',').map((w) => w.trim()).filter(Boolean)
    if (kind === 'palavra' && words.length === 0) return toast.error('Digite pelo menos uma palavra.')
    if (kind === 'numero' && !sessionId) return toast.error('Escolha o número.')
    if (!target) return toast.error('Escolha o atendente.')
    setAdding(true)
    try {
      await atendimentoService.addRule({
        organization_id: profile.organization_id,
        position: rules.length ? Math.max(...rules.map((r) => r.position)) + 1 : 0,
        kind,
        session_id: kind === 'numero' ? sessionId : null,
        keywords: kind === 'palavra' ? words : [],
        target_user: target,
      })
      setKeywords('')
      setSessionId('')
      loadRules()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao criar a regra')
    } finally {
      setAdding(false)
    }
  }

  async function move(index: number, dir: -1 | 1) {
    if (!rules) return
    const a = rules[index], b = rules[index + dir]
    if (!a || !b) return
    try {
      // Posições explícitas pela ordem atual: corrige empates antigos de graça.
      await Promise.all(rules.map((r, i) => {
        const pos = i === index ? index + dir : i === index + dir ? index : i
        return r.position === pos ? null : atendimentoService.updateRule(r.id, { position: pos })
      }))
      loadRules()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao reordenar')
    }
  }

  async function toggleRule(r: WaRoutingRule) {
    try {
      await atendimentoService.updateRule(r.id, { active: !r.active })
      loadRules()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao alterar a regra')
    }
  }

  async function removeRule(r: WaRoutingRule) {
    if (!(await confirmDialog({ message: 'Apagar esta regra?', confirmLabel: 'Apagar', danger: true }))) return
    try {
      await atendimentoService.deleteRule(r.id)
      loadRules()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao apagar a regra')
    }
  }

  const usaPool = settings.assign_mode === 'aleatoria' || settings.assign_mode === 'rodizio'

  async function addSource() {
    if (!profile) return
    const p = phrase.trim(), o = origemNova.trim()
    if (p.length < 2 || o.length < 2) return toast.error('Preencha a frase e a origem (mínimo 2 letras).')
    try {
      await atendimentoService.addSourceRule({
        organization_id: profile.organization_id,
        position: sources.length ? Math.max(...sources.map((r) => r.position)) + 1 : 0,
        phrase: p,
        origem: o,
      })
      setPhrase('')
      setOrigemNova('')
      loadSources()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao criar a regra de origem')
    }
  }

  async function changeLimit(userId: string, raw: string) {
    if (!profile) return
    const value: 'padrao' | number | null = raw === 'padrao' ? 'padrao' : raw === 'livre' ? null : Math.max(1, Number(raw) || 1)
    try {
      await atendimentoService.setAgentLimit(profile.organization_id, userId, value)
      setLimits((cur) => {
        const next = new Map(cur)
        if (value === 'padrao') next.delete(userId)
        else next.set(userId, value)
        return next
      })
      atendimentoService.dispatchNow().catch(() => {})
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar o limite')
    }
  }

  const addReason = () => {
    const r = newReason.trim()
    if (!r || settings.conclusion_reasons.includes(r)) return
    set({ conclusion_reasons: [...settings.conclusion_reasons, r] })
    setNewReason('')
  }

  return (
    <>
      <section className="card">
        <h3 className="card-title"><Eye size={15} /> Quem vê o quê</h3>
        <label className="at-toggle">
          <input
            type="checkbox"
            checked={settings.restrict_to_assigned}
            onChange={(e) => set({ restrict_to_assigned: e.target.checked })}
          />
          <span>
            <strong>Cada atendente vê só as conversas atribuídas a ele</strong>
            <span className="text-muted">
              Desligado, todos os atendentes veem todas as conversas e podem assumir as da Fila.
              Quem tem a permissão "Ver todas" sempre vê tudo.
            </span>
          </span>
        </label>
        <label className="at-toggle">
          <input
            type="checkbox"
            checked={settings.allow_edit_messages}
            onChange={(e) => set({ allow_edit_messages: e.target.checked })}
          />
          <span>
            <strong>Atendentes podem editar as mensagens que enviaram</strong>
            <span className="text-muted">
              O cliente vê a mensagem "editada". O WhatsApp só permite editar até 15 minutos depois de enviar.
              Quem configura o atendimento sempre pode.
            </span>
          </span>
        </label>
        <label className="at-toggle">
          <input
            type="checkbox"
            checked={settings.allow_delete_messages}
            onChange={(e) => set({ allow_delete_messages: e.target.checked })}
          />
          <span>
            <strong>Atendentes podem apagar para todos as mensagens que enviaram</strong>
            <span className="text-muted">
              A mensagem some para o cliente e fica marcada como apagada na conversa. Quem configura o atendimento sempre pode.
            </span>
          </span>
        </label>
        <label className="at-toggle">
          <input
            type="checkbox"
            checked={settings.auto_conclude_hours !== null}
            onChange={(e) => set({ auto_conclude_hours: e.target.checked ? 24 : null })}
          />
          <span>
            <strong>Concluir sozinho o atendimento sem interação</strong>
            <span className="text-muted">
              O atendimento em aberto, com atendente, sem nenhuma mensagem (do cliente ou da equipe) pelo tempo abaixo
              é concluído automaticamente, com o motivo "Sem interação". Conversas na Fila não são concluídas.
              Se o cliente escrever de novo, a conversa reabre.
            </span>
          </span>
        </label>
        {settings.auto_conclude_hours !== null && (
          <div className="flex" style={{ alignItems: 'center', gap: 8, margin: '4px 0 0 28px' }}>
            <span>Concluir após</span>
            <input
              className="input"
              type="number"
              min={1}
              max={8760}
              style={{ width: 90 }}
              value={settings.auto_conclude_hours}
              onChange={(e) => set({ auto_conclude_hours: Math.min(8760, Math.max(1, Math.round(Number(e.target.value)) || 1)) })}
              aria-label="Horas sem interação"
            />
            <span>horas sem interação</span>
          </div>
        )}
        <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
            {saving ? <span className="spinner" /> : 'Salvar'}
          </button>
        </div>
      </section>

      <AutoMessagesCard settings={settings} set={set} dirty={dirty} saving={saving} save={save} />
      <QuickRepliesCard />
      <NumerosPorAtendenteCard attendants={attendants} />

      <section className="card">
        <h3 className="card-title"><Shuffle size={15} /> Distribuição de conversas novas</h3>
        <p className="text-muted" style={{ fontSize: 12, marginBottom: 12 }}>
          Vale quando o cliente escreve e a conversa está sem atendente. As regras abaixo vêm antes.
        </p>
        <div className="at-modes">
          {MODES.map((m) => (
            <label key={m.id} className={`at-mode${settings.assign_mode === m.id ? ' active' : ''}`}>
              <input
                type="radio"
                name="assign_mode"
                checked={settings.assign_mode === m.id}
                onChange={() => set({ assign_mode: m.id })}
              />
              <span>
                <strong>{m.label}</strong>
                <span className="text-muted">{m.hint}</span>
              </span>
            </label>
          ))}
        </div>

        {settings.assign_mode === 'fixo' && (
          <div className="field" style={{ marginTop: 14, maxWidth: 360 }}>
            <label>Atendente</label>
            <select className="input" value={settings.fixed_user ?? ''} onChange={(e) => set({ fixed_user: e.target.value || null })}>
              <option value="">Escolha…</option>
              {attendants.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        )}

        {usaPool && (
          <div className="field" style={{ marginTop: 14 }}>
            <label>Participam {settings.pool.length === 0 && <span className="text-muted">(nenhum marcado = todos)</span>}</label>
            <div className="at-pool">
              {attendants.map((a) => (
                <label key={a.id} className="at-pool-item">
                  <input type="checkbox" checked={settings.pool.includes(a.id)} onChange={() => togglePool(a.id)} />
                  {a.name}
                </label>
              ))}
              {attendants.length === 0 && <span className="text-muted">Nenhum usuário com atendimento ainda.</span>}
            </div>
          </div>
        )}

        <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
            {saving ? <span className="spinner" /> : 'Salvar'}
          </button>
        </div>
      </section>

      <section className="card">
        <h3 className="card-title"><Gauge size={15} /> Atendimentos simultâneos</h3>
        <p className="text-muted" style={{ fontSize: 12, marginBottom: 12 }}>
          Quantos atendimentos em andamento cada pessoa pode ter. Quem chegou no limite não recebe
          conversa nova da distribuição; quando conclui ou transfere um, a fila anda sozinha.
          Quem tem a permissão "Atribuir qualquer uma" pode passar do limite atribuindo à mão.
        </p>
        <div className="at-limit-default">
          <label className="at-toggle" style={{ marginBottom: 0 }}>
            <input
              type="checkbox"
              checked={settings.max_open_per_agent === null}
              onChange={(e) => set({ max_open_per_agent: e.target.checked ? null : 5 })}
            />
            <span><strong>Livre</strong><span className="text-muted">sem limite por pessoa</span></span>
          </label>
          {settings.max_open_per_agent !== null && (
            <label className="at-limit-input">
              Até
              <input
                className="input"
                type="number"
                min={1}
                max={999}
                value={settings.max_open_per_agent}
                onChange={(e) => set({ max_open_per_agent: Math.max(1, Number(e.target.value) || 1) })}
              />
              por pessoa
            </label>
          )}
        </div>

        {attendants.length > 0 && (
          <div className="at-limits">
            <div className="text-muted" style={{ fontSize: 12, margin: '14px 0 6px' }}>Exceções por pessoa (salvam na hora)</div>
            {attendants.map((a) => {
              const has = limits.has(a.id)
              const v = limits.get(a.id)
              const sel = !has ? 'padrao' : v === null ? 'livre' : 'numero'
              return (
                <div key={a.id} className="at-limit-row">
                  <span>{a.name}</span>
                  <select
                    className="input"
                    value={sel}
                    onChange={(e) => changeLimit(a.id, e.target.value === 'numero' ? String(settings.max_open_per_agent ?? 5) : e.target.value)}
                    aria-label={`Limite de ${a.name}`}
                  >
                    <option value="padrao">
                      Padrão ({settings.max_open_per_agent === null ? 'livre' : `até ${settings.max_open_per_agent}`})
                    </option>
                    <option value="livre">Livre</option>
                    <option value="numero">Limite próprio</option>
                  </select>
                  {sel === 'numero' && (
                    <input
                      className="input at-limit-num"
                      type="number"
                      min={1}
                      max={999}
                      defaultValue={v ?? 1}
                      onBlur={(e) => changeLimit(a.id, e.target.value)}
                      aria-label={`Quantos atendimentos para ${a.name}`}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="card">
        <h3 className="card-title"><CheckCircle2 size={15} /> Motivos de conclusão</h3>
        <p className="text-muted" style={{ fontSize: 12, marginBottom: 12 }}>
          Aparecem ao concluir um atendimento e no relatório. Sem nenhum, conclui sem perguntar o motivo.
        </p>
        <div className="at-reasons">
          {settings.conclusion_reasons.map((r) => (
            <span key={r} className="at-reason">
              {r}
              <button
                className="icon-btn"
                onClick={() => set({ conclusion_reasons: settings.conclusion_reasons.filter((x) => x !== r) })}
                aria-label={`Remover ${r}`}
              >
                <XIcon size={12} />
              </button>
            </span>
          ))}
        </div>
        <div className="flex" style={{ marginTop: 10, maxWidth: 420 }}>
          <input
            className="input"
            value={newReason}
            maxLength={60}
            onChange={(e) => setNewReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addReason() } }}
            placeholder="Novo motivo"
          />
          <button className="btn btn-ghost" onClick={addReason}><Plus size={14} /> Adicionar</button>
        </div>
        <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn btn-primary" onClick={save} disabled={saving || !dirty}>
            {saving ? <span className="spinner" /> : 'Salvar'}
          </button>
        </div>
      </section>

      <section className="card">
        <h3 className="card-title"><Workflow size={15} /> Regras de distribuição</h3>
        <p className="text-muted" style={{ fontSize: 12, marginBottom: 12 }}>
          Testadas de cima para baixo antes da distribuição acima; a primeira que servir decide.
          Regra de atendente inativo é pulada.
        </p>

        {rules.length > 0 && (
          <div className="at-rules">
            {rules.map((r, i) => (
              <div key={r.id} className={`at-rule${r.active ? '' : ' off'}`}>
                <div className="at-rule-order">
                  <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Subir"><ArrowUp size={13} /></button>
                  <button className="icon-btn" disabled={i === rules.length - 1} onClick={() => move(i, 1)} aria-label="Descer"><ArrowDown size={13} /></button>
                </div>
                <div className="at-rule-text">
                  {r.kind === 'numero'
                    ? <>Chegou pelo número <strong>{r.session_id ? sessionLabel(sessionsById.get(r.session_id)) : '—'}</strong></>
                    : <>Mensagem contém <strong>{r.keywords.join(', ')}</strong></>}
                  {' → '}<strong>{names.get(r.target_user) ?? 'usuário sem atendimento'}</strong>
                </div>
                <label className="at-rule-active" title="Ativa">
                  <input type="checkbox" checked={r.active} onChange={() => toggleRule(r)} /> Ativa
                </label>
                <button className="icon-btn btn-danger-ghost" onClick={() => removeRule(r)} aria-label="Apagar regra"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        )}

        <div className="at-rule-form">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as 'palavra' | 'numero')} aria-label="Tipo de regra">
            <option value="palavra">Mensagem contém</option>
            <option value="numero">Chegou pelo número</option>
          </select>
          {kind === 'palavra' ? (
            <input
              className="input"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="orçamento, preço, valor"
              aria-label="Palavras, separadas por vírgula"
            />
          ) : (
            <select className="input" value={sessionId} onChange={(e) => setSessionId(e.target.value)} aria-label="Número">
              <option value="">Escolha o número…</option>
              {sessions.filter((s) => s.chat_enabled).map((s) => <option key={s.id} value={s.id}>{sessionLabel(s)}</option>)}
            </select>
          )}
          <select className="input" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Vai para">
            <option value="">Vai para…</option>
            {attendants.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button className="btn btn-ghost" onClick={addRule} disabled={adding}>
            <Plus size={14} /> Adicionar
          </button>
        </div>
      </section>

      <section className="card">
        <h3 className="card-title"><Tag size={15} /> Origem do contato</h3>
        <div className="at-client-ad" style={{ marginBottom: 14 }}>
          <Megaphone size={14} />
          <div>
            <strong>Anúncio é reconhecido sozinho</strong>
            <span className="text-muted">
              Quem chega clicando num anúncio do Instagram ou do Facebook ganha a origem
              "Anúncio Instagram" ou "Anúncio Facebook", e as vendas lançadas para ele vão para a Meta.
            </span>
          </div>
        </div>
        <p className="text-muted" style={{ fontSize: 12, marginBottom: 12 }}>
          Para as outras fontes, cadastre frases: se a mensagem do cliente contém a frase, a origem
          dele é preenchida. Vale para quem ainda não tem origem; sem diferença de maiúscula ou acento.
        </p>

        {sources.length > 0 && (
          <div className="at-rules">
            {sources.map((r) => (
              <div key={r.id} className={`at-rule${r.active ? '' : ' off'}`}>
                <div className="at-rule-text">
                  Mensagem contém <strong>“{r.phrase}”</strong> → origem <strong>{r.origem}</strong>
                </div>
                <label className="at-rule-active" title="Ativa">
                  <input
                    type="checkbox"
                    checked={r.active}
                    onChange={() => atendimentoService.updateSourceRule(r.id, { active: !r.active }).then(loadSources)
                      .catch((err) => toast.error(err instanceof Error ? err.message : 'Falha ao alterar'))}
                  /> Ativa
                </label>
                <button
                  className="icon-btn btn-danger-ghost"
                  aria-label="Apagar regra de origem"
                  onClick={async () => {
                    if (!(await confirmDialog({ message: 'Apagar esta regra de origem?', confirmLabel: 'Apagar', danger: true }))) return
                    atendimentoService.deleteSourceRule(r.id).then(loadSources)
                      .catch((err) => toast.error(err instanceof Error ? err.message : 'Falha ao apagar'))
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="at-source-form">
          <input
            className="input"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder="Frase. Ex.: vi no Instagram"
            aria-label="Frase"
          />
          <input
            className="input"
            value={origemNova}
            onChange={(e) => setOrigemNova(e.target.value)}
            placeholder="Origem. Ex.: Instagram"
            aria-label="Origem"
          />
          <button className="btn btn-ghost" onClick={addSource}><Plus size={14} /> Adicionar</button>
        </div>
      </section>
    </>
  )
}
