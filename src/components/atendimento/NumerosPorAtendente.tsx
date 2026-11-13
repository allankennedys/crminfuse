import { useEffect, useState } from 'react'
import { Smartphone } from 'lucide-react'
import { toast } from '@/store/toastStore'
import { atendimentoService, sessionLabel } from '@/services/atendimentoService'
import type { WaAttendant, WaSession } from '@/types'

/**
 * A quais números cada atendente tem acesso (143). "Todos os números" é o
 * padrão; escolhendo, o atendente só vê as conversas, recebe distribuição e
 * inicia conversa pelos números marcados. Cada mudança salva na hora.
 */
export function NumerosPorAtendenteCard({ attendants }: {
  attendants: WaAttendant[]
}) {
  const [sessions, setSessions] = useState<WaSession[]>([])
  const [access, setAccess] = useState<Map<string, string[]> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    atendimentoService.userSessions().then(setAccess)
    atendimentoService.allSessions().then(setSessions)
  }, [])

  async function save(userId: string, ids: string[] | null) {
    setBusy(userId)
    try {
      await atendimentoService.setUserSessions(userId, ids)
      setAccess((cur) => {
        const next = new Map(cur ?? [])
        if (ids === null) next.delete(userId)
        else next.set(userId, ids)
        return next
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar o acesso')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="card">
      <h3 className="card-title"><Smartphone size={15} /> Números de cada atendente</h3>
      <p className="text-muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
        Escolha por quais números cada atendente atende. Ele só vê as conversas desses números, só recebe
        distribuição automática deles e só inicia conversa por eles. Administradores veem todos.
      </p>
      {sessions.length === 0 ? (
        <p className="text-muted" style={{ fontSize: 13 }}>Nenhum número cadastrado ainda.</p>
      ) : access === null ? (
        <div className="spinner" />
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          {attendants.map((a) => {
            const lista = access.get(a.id)
            const restrito = lista !== undefined
            const admin = a.role === 'admin'
            return (
              <div key={a.id} className="at-num-row">
                <div className="flex" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong style={{ minWidth: 140 }}>{a.name}</strong>
                  {admin ? (
                    <span className="text-muted" style={{ fontSize: 12.5 }}>Todos os números (administrador)</span>
                  ) : (
                    <select
                      className="input"
                      style={{ width: 'auto' }}
                      disabled={busy === a.id}
                      value={restrito ? 'escolhidos' : 'todos'}
                      aria-label={`Acesso de ${a.name}`}
                      // Começa com todos marcados (igual a antes); o admin desmarca o que não vale.
                      onChange={(e) => save(a.id, e.target.value === 'todos' ? null : sessions.map((s) => s.id))}
                    >
                      <option value="todos">Todos os números</option>
                      <option value="escolhidos">Só os escolhidos</option>
                    </select>
                  )}
                </div>
                {!admin && restrito && (
                  <div className="at-num-checks">
                    {sessions.map((s) => (
                      <label key={s.id} className="checkbox-row">
                        <input
                          type="checkbox"
                          disabled={busy === a.id}
                          checked={lista.includes(s.id)}
                          onChange={(e) => save(a.id, e.target.checked ? [...lista, s.id] : lista.filter((x) => x !== s.id))}
                        />
                        <span>{sessionLabel(s)}</span>
                      </label>
                    ))}
                    {lista.length === 0 && (
                      <span className="text-muted" style={{ fontSize: 12 }}>
                        Nenhum número marcado: este atendente não vê conversa nenhuma.
                      </span>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
