import { useCallback, useEffect, useState } from 'react'
import { Bell, CheckCircle2, Clock, Trash2 } from 'lucide-react'
import { DateInput, Modal } from '@/components/ui'
import { toast } from '@/store/toastStore'
import { atendimentoService, formatPhone } from '@/services/atendimentoService'
import { formatSP, nowSPDatetimeLocal, spWallTimeToUtcISO } from '@/lib/datetime'
import { HoraInput } from './AtendimentoAutomaticas'
import type { WaTask } from '@/types'

/** Avisa o resto da tela (contador do cabeçalho) que os lembretes mudaram. */
const MUDOU = 'at-tasks-changed'
const avisaMudanca = () => window.dispatchEvent(new Event(MUDOU))

/** "AAAA-MM-DDTHH:mm" de São Paulo somado a n minutos (conta em UTC: sem surpresa de fuso). */
function somaMin(wall: string, n: number): string {
  const [d, t] = wall.split('T')
  const [y, mo, da] = d.split('-').map(Number)
  const [h, mi] = t.split(':').map(Number)
  const x = new Date(Date.UTC(y, mo - 1, da, h, mi + n))
  const p = (v: number) => String(v).padStart(2, '0')
  return `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())}T${p(x.getUTCHours())}:${p(x.getUTCMinutes())}`
}

const vencido = (t: WaTask) => !t.done_at && new Date(t.due_at).getTime() <= Date.now()

/** Lembretes de retorno desta conversa, no painel do cliente. */
export function LembretesSection({ conversationId }: { conversationId: string }) {
  const [tasks, setTasks] = useState<WaTask[] | null>(null)
  const [title, setTitle] = useState('')
  const [day, setDay] = useState(() => nowSPDatetimeLocal().slice(0, 10))
  const [time, setTime] = useState('09:00')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    atendimentoService.listTasks(conversationId).then(setTasks).catch(() => setTasks([]))
  }, [conversationId])
  useEffect(load, [load])

  const preset = (min: number) => {
    const w = somaMin(nowSPDatetimeLocal(), min)
    setDay(w.slice(0, 10))
    setTime(w.slice(11, 16))
  }
  const amanha9 = () => {
    setDay(somaMin(`${nowSPDatetimeLocal().slice(0, 10)}T00:00`, 24 * 60).slice(0, 10))
    setTime('09:00')
  }

  async function add() {
    if (!title.trim()) return toast.error('Escreva o lembrete.')
    if (!day || !/^\d{2}:\d{2}$/.test(time)) return toast.error('Informe a data e a hora (hh:mm).')
    setBusy(true)
    try {
      await atendimentoService.createTask(conversationId, title.trim(), spWallTimeToUtcISO(`${day}T${time}`))
      setTitle('')
      load()
      avisaMudanca()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao criar o lembrete')
    } finally {
      setBusy(false)
    }
  }

  async function done(t: WaTask) {
    try { await atendimentoService.doneTask(t.id, !t.done_at); load(); avisaMudanca() }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Falha ao atualizar') }
  }
  async function remove(t: WaTask) {
    try { await atendimentoService.deleteTask(t.id); load(); avisaMudanca() }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Falha ao apagar') }
  }

  const abertos = (tasks ?? []).filter((t) => !t.done_at)
  const feitos = (tasks ?? []).filter((t) => t.done_at).slice(-3)

  return (
    <section className="at-client-tasks">
      <div className="at-client-sec-title"><Clock size={13} /> Lembretes</div>
      {[...abertos, ...feitos].map((t) => (
        <div key={t.id} className={`at-task${t.done_at ? ' done' : vencido(t) ? ' late' : ''}`}>
          <button className="icon-btn" onClick={() => done(t)} aria-label={t.done_at ? 'Reabrir lembrete' : 'Concluir lembrete'} title={t.done_at ? 'Reabrir' : 'Concluir'}>
            <CheckCircle2 size={16} />
          </button>
          <span className="at-task-main">
            <span className="at-task-title">{t.title}</span>
            <span className="text-muted">{formatSP(t.due_at)}</span>
          </span>
          <button className="icon-btn" onClick={() => remove(t)} aria-label="Apagar lembrete"><Trash2 size={13} /></button>
        </div>
      ))}
      <div className="at-task-form">
        <input className="input" placeholder="Ex.: ligar para fechar proposta" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Lembrete" />
        <div className="at-task-when">
          <DateInput value={day} onChange={(v) => v && setDay(v)} ariaLabel="Data do lembrete" />
          <HoraInput label="Hora do lembrete" value={time} onChange={setTime} />
        </div>
        <div className="at-task-presets">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => preset(60)}>Em 1 h</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={amanha9}>Amanhã 9h</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => preset(3 * 24 * 60)}>Em 3 dias</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={add} disabled={busy}>Adicionar</button>
        </div>
      </div>
    </section>
  )
}

/** Botão do cabeçalho: meus lembretes em aberto; o número é o dos vencidos. */
export function MeusLembretes({ userId, onOpenConversation }: {
  userId: string
  onOpenConversation: (conversationId: string) => void
}) {
  const [tasks, setTasks] = useState<WaTask[]>([])
  const [aberto, setAberto] = useState(false)

  const load = useCallback(() => {
    if (!userId) return
    atendimentoService.myTasks(userId).then(setTasks).catch(() => setTasks([]))
  }, [userId])

  useEffect(() => {
    load()
    const i = setInterval(load, 60_000)
    window.addEventListener(MUDOU, load)
    return () => { clearInterval(i); window.removeEventListener(MUDOU, load) }
  }, [load])

  const atrasados = tasks.filter(vencido).length

  return (
    <>
      <button className="btn btn-ghost btn-sm" onClick={() => { load(); setAberto(true) }} title="Meus lembretes">
        <Bell size={14} /> Lembretes
        {atrasados > 0 && <span className="at-seg-count">{atrasados}</span>}
      </button>
      {aberto && (
        <Modal title="Meus lembretes" onClose={() => setAberto(false)} variant="dialog">
          {tasks.length === 0 ? (
            <p className="text-muted">Nenhum lembrete em aberto. Crie pelo painel do cliente, dentro da conversa.</p>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {tasks.map((t) => {
                const c = t.wa_conversations
                const quem = c?.crm_contacts?.name || c?.push_name || formatPhone(c?.phone ?? null) || 'Conversa'
                return (
                  <div key={t.id} className={`at-task${vencido(t) ? ' late' : ''}`}>
                    <span className="at-task-main">
                      <span className="at-task-title">{t.title}</span>
                      <span className="text-muted">{quem} · {formatSP(t.due_at)}</span>
                    </span>
                    <button className="btn btn-ghost btn-sm" onClick={() => { setAberto(false); onOpenConversation(t.conversation_id) }}>Abrir</button>
                    <button
                      className="icon-btn"
                      aria-label="Concluir lembrete"
                      onClick={async () => { await atendimentoService.doneTask(t.id).catch(() => {}); load() }}
                    >
                      <CheckCircle2 size={16} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </Modal>
      )}
    </>
  )
}
