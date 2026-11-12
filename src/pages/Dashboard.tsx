import { useCallback, useEffect, useState } from 'react'
import {
  AreaChart, Area, BarChart, Bar, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import { supabase } from '@/lib/supabase'
import { useRealtime } from '@/hooks/useRealtime'
import { Loader } from '@/components/ui'
import { format } from 'date-fns'
import { ptBR } from 'date-fns/locale'

// ---- Tipos dos relatórios (espelham as funções SQL em 007_dashboard_reports) ----
interface DailyRow { day: string; sent: number; failed: number }
interface HourlyRow { hour: number; sent: number }
interface GroupRow { group_id: string; name: string; sent: number; failed: number }
interface SessionRow {
  session_id: string; instance_name: string; phone_number: string | null
  status: string; rate_limit_per_min: number; sent: number; failed: number
}
interface FailureRow { reason: string; total: number }

interface Stats {
  sentPeriod: number
  failedPeriod: number
  successRate: number | null
  avgPerDay: number
  queued: number
  activeSessions: number
  totalSessions: number
  reach: number
  daily: DailyRow[]
  hourly: HourlyRow[]
  topGroups: GroupRow[]
  sessions: SessionRow[]
  failures: FailureRow[]
}

const tooltipStyle = {
  background: '#0b0e12',
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: 10,
  fontSize: 12,
} as const
const tooltipLabel = { color: '#a1a1aa' }

/** Chama uma função SQL de relatório; degrada para [] se a migration ainda não foi aplicada. */
async function rpc<T>(fn: string, days: number, extra: Record<string, unknown> = {}): Promise<T[]> {
  const { data, error } = await supabase.rpc(fn, { days, ...extra })
  if (error) {
    console.error(`report ${fn}:`, error.message)
    return []
  }
  return (data ?? []) as T[]
}

function pct(sent: number, failed: number): number | null {
  const total = sent + failed
  return total > 0 ? Math.round((sent / total) * 1000) / 10 : null
}

async function loadStats(days: number): Promise<Stats> {
  const [
    daily, hourly, topGroups, sessions, failures,
    queued, connectedSessions, allSessions, reachRes,
  ] = await Promise.all([
    rpc<DailyRow>('report_daily', days),
    rpc<HourlyRow>('report_hourly', days),
    rpc<GroupRow>('report_top_groups', days, { lim: 8 }),
    rpc<SessionRow>('report_by_session', days),
    rpc<FailureRow>('report_failure_reasons', days, { lim: 6 }),
    supabase.from('message_queue').select('id', { count: 'exact', head: true })
      .in('status', ['pending', 'processing']),
    supabase.from('whatsapp_sessions').select('id', { count: 'exact', head: true })
      .eq('status', 'connected'),
    supabase.from('whatsapp_sessions').select('id', { count: 'exact', head: true }),
    // Alcance = contatos ÚNICOS nos grupos ativos (distinct jid, no banco).
    supabase.rpc('report_reach'),
  ])

  const reach = Number(reachRes.data ?? 0)

  const sentPeriod = daily.reduce((s, r) => s + Number(r.sent), 0)
  const failedPeriod = daily.reduce((s, r) => s + Number(r.failed), 0)

  return {
    sentPeriod,
    failedPeriod,
    successRate: pct(sentPeriod, failedPeriod),
    avgPerDay: days > 0 ? Math.round(sentPeriod / days) : 0,
    queued: queued.count ?? 0,
    activeSessions: connectedSessions.count ?? 0,
    totalSessions: allSessions.count ?? 0,
    reach,
    daily: daily.map((r) => ({ ...r, sent: Number(r.sent), failed: Number(r.failed) })),
    hourly: hourly.map((r) => ({ hour: Number(r.hour), sent: Number(r.sent) })),
    topGroups: topGroups.map((r) => ({ ...r, sent: Number(r.sent), failed: Number(r.failed) })),
    sessions: sessions.map((r) => ({ ...r, sent: Number(r.sent), failed: Number(r.failed) })),
    failures: failures.map((r) => ({ ...r, total: Number(r.total) })),
  }
}

const PERIODS = [
  { days: 7, label: '7 dias' },
  { days: 30, label: '30 dias' },
] as const

export function DashboardPage() {
  const [days, setDays] = useState<number>(7)
  const [stats, setStats] = useState<Stats | null>(null)

  const refresh = useCallback(() => {
    loadStats(days).then(setStats).catch(console.error)
  }, [days])

  useEffect(refresh, [refresh])
  useRealtime('message_logs', refresh)
  useRealtime('message_queue', refresh)
  useRealtime('whatsapp_sessions', refresh)

  if (!stats) return <Loader />

  const chartDays = stats.daily.map((r) => ({ ...r, label: r.day.slice(8, 10) + '/' + r.day.slice(5, 7) }))
  const hourlyData = stats.hourly.map((r) => ({ ...r, label: String(r.hour).padStart(2, '0') + 'h' }))
  const peakHour = stats.hourly.reduce<HourlyRow | null>((best, r) => (!best || r.sent > best.sent ? r : best), null)

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Visão geral</h1>
          <p>{format(new Date(), "EEEE, d 'de' MMMM", { locale: ptBR })} · atualização em tempo real</p>
        </div>
        <div className="flex" style={{ gap: 6 }}>
          {PERIODS.map((p) => (
            <button
              key={p.days}
              className={`btn btn-sm ${days === p.days ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setDays(p.days)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* ---------- KPIs ---------- */}
      <div className="stats-grid">
        <div className="card glow">
          <div className="card-title">Enviadas ({days}d)</div>
          <div className="stat-value green">{stats.sentPeriod.toLocaleString('pt-BR')}</div>
          <div className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>~{stats.avgPerDay.toLocaleString('pt-BR')}/dia</div>
        </div>
        <div className="card">
          <div className="card-title">Taxa de sucesso</div>
          <div className={`stat-value${stats.successRate !== null && stats.successRate < 90 ? ' red' : ' green'}`}>
            {stats.successRate === null ? '—' : `${stats.successRate}%`}
          </div>
          <div className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>envios aceitos pelo WhatsApp</div>
        </div>
        <div className="card">
          <div className="card-title">Falhas ({days}d)</div>
          <div className={`stat-value${stats.failedPeriod > 0 ? ' red' : ''}`}>{stats.failedPeriod.toLocaleString('pt-BR')}</div>
        </div>
        <div className="card">
          <div className="card-title">Aguardando na fila</div>
          <div className="stat-value">{stats.queued.toLocaleString('pt-BR')}</div>
        </div>
        <div className="card">
          <div className="card-title">Sessões ativas</div>
          <div className="stat-value">{stats.activeSessions}<span className="text-muted" style={{ fontSize: 16, fontWeight: 600 }}> / {stats.totalSessions}</span></div>
        </div>
        <div className="card">
          <div className="card-title">Alcance (contatos)</div>
          <div className="stat-value">{stats.reach.toLocaleString('pt-BR')}</div>
          <div className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>contatos únicos nos grupos ativos</div>
        </div>
        <div className="card">
          <div className="card-title">Horário de pico</div>
          <div className="stat-value">{peakHour && peakHour.sent > 0 ? `${String(peakHour.hour).padStart(2, '0')}h` : '—'}</div>
          <div className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>maior volume de envios</div>
        </div>
      </div>

      {/* ---------- Envios x falhas + Horários ---------- */}
      <div className="grid-2 mb-16">
        <div className="card">
          <div className="card-title" style={{ marginBottom: 18 }}>Envios e falhas — últimos {days} dias</div>
          <div style={{ width: '100%', height: 260 }}>
            <ResponsiveContainer>
              <AreaChart data={chartDays} margin={{ top: 5, right: 5, bottom: 0, left: -20 }}>
                <defs>
                  <linearGradient id="greenFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#4da3ff" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#4da3ff" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="redFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ff4d6a" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#ff4d6a" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="label" stroke="#52525b" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke="#52525b" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} labelStyle={tooltipLabel} />
                <Area type="monotone" dataKey="sent" name="Enviadas" stroke="#4da3ff" strokeWidth={2} fill="url(#greenFill)" />
                <Area type="monotone" dataKey="failed" name="Falhas" stroke="#ff4d6a" strokeWidth={2} fill="url(#redFill)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card">
          <div className="card-title" style={{ marginBottom: 18 }}>Envios por horário do dia</div>
          <div style={{ width: '100%', height: 260 }}>
            <ResponsiveContainer>
              <BarChart data={hourlyData} margin={{ top: 5, right: 5, bottom: 0, left: -20 }}>
                <XAxis dataKey="label" stroke="#52525b" fontSize={10} tickLine={false} axisLine={false} interval={2} />
                <YAxis stroke="#52525b" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} labelStyle={tooltipLabel} itemStyle={{ color: '#4da3ff' }} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Bar dataKey="sent" name="Enviadas" radius={[3, 3, 0, 0]}>
                  {hourlyData.map((r) => (
                    <Cell key={r.hour} fill={peakHour && r.hour === peakHour.hour && r.sent > 0 ? '#4da3ff' : 'rgba(77, 163, 255,0.35)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* ---------- Top grupos ---------- */}
      <div className="mb-16">
        <div className="card">
          <div className="card-title" style={{ marginBottom: 14 }}>Grupos que mais receberam</div>
          {stats.topGroups.length === 0 ? (
            <p className="text-muted" style={{ fontSize: 13 }}>Nenhum envio no período.</p>
          ) : (
            <div className="table-wrap" style={{ border: 'none', background: 'transparent' }}>
              <table>
                <thead>
                  <tr><th>Grupo</th><th style={{ textAlign: 'right' }}>Enviadas</th><th style={{ textAlign: 'right' }}>Falhas</th><th style={{ textAlign: 'right' }}>Sucesso</th></tr>
                </thead>
                <tbody>
                  {stats.topGroups.map((g) => {
                    const rate = pct(g.sent, g.failed)
                    return (
                      <tr key={g.group_id}>
                        <td style={{ color: 'var(--text)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</td>
                        <td style={{ textAlign: 'right' }} className="mono">{g.sent.toLocaleString('pt-BR')}</td>
                        <td style={{ textAlign: 'right' }} className="mono">{g.failed.toLocaleString('pt-BR')}</td>
                        <td style={{ textAlign: 'right', color: rate !== null && rate < 90 ? 'var(--danger)' : 'var(--primary)' }} className="mono">
                          {rate === null ? '—' : `${rate}%`}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ---------- Desempenho por número + Motivos de falha ---------- */}
      <div className="grid-2 mb-16">
        <div className="card">
          <div className="card-title" style={{ marginBottom: 14 }}>Desempenho por número</div>
          {stats.sessions.length === 0 ? (
            <p className="text-muted" style={{ fontSize: 13 }}>Nenhum número cadastrado.</p>
          ) : (
            <div className="table-wrap" style={{ border: 'none', background: 'transparent' }}>
              <table>
                <thead>
                  <tr><th>Número</th><th style={{ textAlign: 'right' }}>Enviadas</th><th style={{ textAlign: 'right' }}>Falhas</th><th style={{ textAlign: 'right' }}>Limite/min</th></tr>
                </thead>
                <tbody>
                  {stats.sessions.map((s) => (
                    <tr key={s.session_id}>
                      <td style={{ color: 'var(--text)' }}>
                        <span className="flex" style={{ gap: 7, alignItems: 'center' }}>
                          <span className="dot" style={{ width: 7, height: 7, borderRadius: '50%', background: s.status === 'connected' ? 'var(--primary)' : 'var(--text-muted)', display: 'inline-block' }} />
                          {s.phone_number ?? s.instance_name}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }} className="mono">{s.sent.toLocaleString('pt-BR')}</td>
                      <td style={{ textAlign: 'right', color: s.failed > 0 ? 'var(--danger)' : undefined }} className="mono">{s.failed.toLocaleString('pt-BR')}</td>
                      <td style={{ textAlign: 'right' }} className="mono">{s.rate_limit_per_min}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-title" style={{ marginBottom: 14 }}>Principais motivos de falha</div>
          {stats.failures.length === 0 ? (
            <p className="text-muted" style={{ fontSize: 13 }}>Sem falhas no período.</p>
          ) : (
            <div className="table-wrap" style={{ border: 'none', background: 'transparent' }}>
              <table>
                <thead>
                  <tr><th>Motivo</th><th style={{ textAlign: 'right' }}>Ocorrências</th></tr>
                </thead>
                <tbody>
                  {stats.failures.map((f, i) => (
                    <tr key={i}>
                      <td className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.reason}</td>
                      <td style={{ textAlign: 'right', color: 'var(--danger)' }} className="mono">{f.total.toLocaleString('pt-BR')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
