import { useEffect, useState } from 'react'
import {
  ArrowRightLeft, CalendarRange, CheckCircle2, Clock, Hourglass, Inbox, MessageCircle, RotateCcw, Timer, Users,
} from 'lucide-react'
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { EmptyState, Loader } from '@/components/ui'
import { toast } from '@/store/toastStore'
import { atendimentoService } from '@/services/atendimentoService'
import type { WaReport } from '@/types'

/*
 * Cores dos gráficos: as duas primeiras vagas da paleta categórica, versão
 * para fundo escuro, validadas contra o card (#161619): contraste ≥ 3:1 e
 * separação para daltonismo ΔE 26,8. Azul = abertos, laranja = concluídos;
 * sempre nessa ordem, inclusive quando só um aparece.
 */
const COR_ABERTOS = 'var(--series-1)'
const COR_CONCLUIDOS = 'var(--series-2)'

const tooltipStyle = {
  background: 'var(--tooltip-bg)',
  border: '1px solid var(--tooltip-border)',
  borderRadius: 10,
  fontSize: 12,
} as const
const tooltipLabel = { color: 'var(--text-secondary)' }
const cursor = { fill: 'var(--surface)' }

/** Minutos legíveis: "8 min", "1 h 05", "2,5 d". */
export function fmtMin(min: number | null): string {
  if (min == null) return '—'
  if (min < 1) return '< 1 min'
  if (min < 60) return `${Math.round(min)} min`
  if (min < 1440) {
    const h = Math.floor(min / 60)
    const m = Math.round(min % 60)
    return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`
  }
  return `${(min / 1440).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} d`
}

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—')

/**
 * Relatórios → Atendimento (120). Só admin: a aba Relatórios inteira é só
 * dele, e o wa_report recusa qualquer outro usuário.
 */
export function AtendimentoReport({ label, range }: { label: string; range: { from: string; to: string } }) {
  const [data, setData] = useState<WaReport | null>(null)

  useEffect(() => {
    let vivo = true
    setData(null)
    atendimentoService.report(range.from, range.to)
      .then((r) => { if (vivo) setData(r) })
      .catch((err) => toast.error(err instanceof Error ? err.message : 'Falha ao carregar o relatório de atendimento'))
    return () => { vivo = false }
  }, [range.from, range.to])

  if (!data) return <Loader />

  const r = data.resumo
  const semResposta = Math.max(0, r.abertos - r.respondidos)
  const dias = data.por_dia.map((d) => ({ ...d, label: `${d.dia.slice(8, 10)}/${d.dia.slice(5, 7)}` }))
  const horas = data.por_hora.map((h) => ({ ...h, label: `${String(h.hora).padStart(2, '0')}h` }))
  const temMovimento = r.abertos > 0 || r.concluidos > 0
  const totalMotivos = data.por_motivo.reduce((s, m) => s + m.total, 0)
  const maxMotivo = Math.max(1, ...data.por_motivo.map((m) => m.total))
  const agentes = [...data.por_atendente].sort((a, b) => b.atendimentos - a.atendimentos || a.nome.localeCompare(b.nome))

  return (
    <>
      <div className="report-legend">
        <CalendarRange size={15} />
        <p>
          Um <b>atendimento</b> começa quando o cliente escreve e termina quando alguém o conclui.
          Volume, primeira resposta e espera contam os atendimentos <b>abertos</b> no período ({label});
          concluídos, tempo médio e motivos contam os <b>concluídos</b> no período. O filtro de vendedor
          não se aplica a esta aba.
        </p>
      </div>

      <div className="crm-kpis at-kpis">
        <Kpi icon={<Inbox size={16} />} title="Atendimentos" value={r.abertos.toLocaleString('pt-BR')} desc="abertos no período" />
        <Kpi
          icon={<CheckCircle2 size={16} />}
          title="Concluídos"
          value={r.concluidos.toLocaleString('pt-BR')}
          desc={r.abertos > 0 ? `${pct(r.concluidos, r.abertos)} do volume do período` : 'no período'}
        />
        <Kpi icon={<Timer size={16} />} title="Tempo médio de atendimento" value={fmtMin(r.tma_min)} desc="da abertura à conclusão" />
        <Kpi icon={<Clock size={16} />} title="Primeira resposta" value={fmtMin(r.tpr_min)} desc="tempo médio até a 1ª mensagem nossa" />
        <Kpi icon={<Hourglass size={16} />} title="Espera na fila" value={fmtMin(r.espera_min)} desc="tempo médio até ter um responsável" />
        <Kpi
          icon={<MessageCircle size={16} />}
          title="Sem resposta"
          value={semResposta.toLocaleString('pt-BR')}
          desc={r.abertos > 0 ? `${pct(semResposta, r.abertos)} dos abertos ainda sem resposta` : 'nenhum atendimento aberto'}
        />
        <Kpi
          icon={<Users size={16} />}
          title="Agora"
          value={`${r.em_atendimento_agora} · ${r.na_fila_agora}`}
          desc="em atendimento · na fila"
        />
        <Kpi
          icon={<RotateCcw size={16} />}
          title="Reaberturas · transferências"
          value={`${r.reaberturas} · ${r.transferencias}`}
          desc={`${r.msgs_recebidas.toLocaleString('pt-BR')} mensagens recebidas, ${r.msgs_enviadas.toLocaleString('pt-BR')} enviadas`}
        />
      </div>

      <div className="card mb-16">
        <div className="card-title" style={{ marginBottom: 4 }}>Atendimentos por dia — {label}</div>
        <p className="text-muted" style={{ fontSize: 11.5, marginBottom: 18 }}>
          Abertos e concluídos em cada dia
        </p>
        {!temMovimento ? (
          <EmptyState icon={<Inbox />} text="Nenhum atendimento aberto ou concluído no período." />
        ) : (
          <div style={{ width: '100%', height: 260 }}>
            <ResponsiveContainer>
              <BarChart data={dias} margin={{ top: 5, right: 5, bottom: 0, left: -20 }} barGap={2} barCategoryGap="22%">
                <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                <XAxis dataKey="label" stroke="var(--chart-axis)" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke="var(--chart-axis)" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} labelStyle={tooltipLabel} cursor={cursor} />
                {/* Texto da legenda em tinta de texto; a cor fica só no marcador. */}
                <Legend wrapperStyle={{ fontSize: 11.5 }} formatter={(v) => <span style={{ color: 'var(--text-secondary)' }}>{v}</span>} />
                <Bar dataKey="abertos" name="Abertos" fill={COR_ABERTOS} radius={[4, 4, 0, 0]} maxBarSize={18} />
                <Bar dataKey="concluidos" name="Concluídos" fill={COR_CONCLUIDOS} radius={[4, 4, 0, 0]} maxBarSize={18} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="at-report-grid">
        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>Horário de entrada</div>
          <p className="text-muted" style={{ fontSize: 11.5, marginBottom: 18 }}>
            Atendimentos abertos por hora do dia — ajuda a montar a escala
          </p>
          {r.abertos === 0 ? (
            <EmptyState icon={<Clock />} text="Sem atendimentos abertos no período." />
          ) : (
            <div style={{ width: '100%', height: 220 }}>
              <ResponsiveContainer>
                <BarChart data={horas} margin={{ top: 5, right: 5, bottom: 0, left: -20 }} barCategoryGap="18%">
                  <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                  <XAxis dataKey="label" stroke="var(--chart-axis)" fontSize={10.5} tickLine={false} axisLine={false} interval={2} />
                  <YAxis stroke="var(--chart-axis)" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip contentStyle={tooltipStyle} labelStyle={tooltipLabel} cursor={cursor} />
                  <Bar dataKey="abertos" name="Abertos" fill={COR_ABERTOS} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>Motivos de conclusão</div>
          <p className="text-muted" style={{ fontSize: 11.5, marginBottom: 14 }}>
            Atendimentos concluídos no período
          </p>
          {data.por_motivo.length === 0 ? (
            <EmptyState icon={<CheckCircle2 />} text="Nenhum atendimento concluído no período." />
          ) : (
            <div className="at-reason-bars">
              {data.por_motivo.map((m) => (
                <div key={m.motivo} className="at-reason-bar" title={`${m.motivo}: ${m.total}`}>
                  <div className="at-reason-bar-top">
                    <span>{m.motivo}</span>
                    <span className="text-secondary">{m.total} · {pct(m.total, totalMotivos)}</span>
                  </div>
                  <div className="at-reason-bar-track">
                    <div style={{ width: `${(m.total / maxMotivo) * 100}%`, background: COR_ABERTOS }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card mb-16">
        <div className="card-title" style={{ marginBottom: 4 }}><Users size={15} /> Por atendente</div>
        <p className="text-muted" style={{ fontSize: 11.5, marginBottom: 14 }}>
          Cada atendimento conta para quem está responsável por ele. "Agora" ignora o período.
        </p>
        {agentes.length === 0 ? (
          <EmptyState icon={<Users />} text="Nenhum usuário com atendimento ainda." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Atendente</th>
                  <th className="at-num">Agora</th>
                  <th className="at-num">Atendimentos</th>
                  <th className="at-num">Concluídos</th>
                  <th className="at-num">Tempo médio</th>
                  <th className="at-num">1ª resposta</th>
                  <th className="at-num">Mensagens</th>
                  <th className="at-num" title="Transferências recebidas · feitas">
                    <ArrowRightLeft size={12} style={{ verticalAlign: '-2px' }} /> Transf. receb. · feitas
                  </th>
                  <th className="at-num">Reaberturas</th>
                </tr>
              </thead>
              <tbody>
                {agentes.map((a) => (
                  <tr key={a.id}>
                    <td style={{ color: 'var(--text)' }}>
                      {a.nome}
                      {!a.ativo && <span className="badge badge-gray" style={{ marginLeft: 6 }}>inativo</span>}
                    </td>
                    <td className="at-num" title={a.limite == null ? 'Sem limite' : `Limite de ${a.limite}`}>
                      {a.em_atendimento}{a.limite != null && <span className="text-muted"> / {a.limite}</span>}
                    </td>
                    <td className="at-num">{a.atendimentos.toLocaleString('pt-BR')}</td>
                    <td className="at-num">{a.concluidos.toLocaleString('pt-BR')}</td>
                    <td className="at-num">{fmtMin(a.tma_min)}</td>
                    <td className="at-num">{fmtMin(a.tpr_min)}</td>
                    <td className="at-num">{a.msgs_enviadas.toLocaleString('pt-BR')}</td>
                    <td className="at-num">{a.transf_recebidas} · {a.transf_feitas}</td>
                    <td className="at-num">{a.reaberturas}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

function Kpi({ icon, title, value, desc }: { icon: React.ReactNode; title: string; value: string; desc: string }) {
  return (
    <div className="kpi-card">
      <div className="kpi-card-bg" aria-hidden="true" />
      <div className="kpi-card-top">
        <span className="kpi-icon">{icon}</span>
      </div>
      <div className="kpi-title">{title}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-desc">{desc}</div>
    </div>
  )
}
