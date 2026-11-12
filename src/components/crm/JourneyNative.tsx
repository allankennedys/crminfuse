import { useEffect, useState } from 'react'
import {
  CalendarRange, Clock, DollarSign, Hourglass, MessageCircle, MessagesSquare, Reply, ShoppingBag, Users, UserX,
} from 'lucide-react'
import { EmptyState, Loader } from '@/components/ui'
import { toast } from '@/store/toastStore'
import { formatBRL, reportJourneyNative, type CrmJourneyNative } from '@/services/crmService'
import { fmtMin } from '@/components/atendimento/AtendimentoReport'

/** Cor única das barras (magnitude): a primeira vaga da paleta validada. */
const COR_BARRA = '#3987e5'

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—')

function fmtDias(d: number | null): string {
  if (d == null) return '—'
  if (d < 1) return `${Math.max(1, Math.round(d * 24))} h`
  return `${d.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} d`
}

/**
 * Relatórios → Jornada (122). Só com o que o próprio sistema registra:
 * etapas do funil, conversa no WhatsApp, vendas e origem. Coorte = leads
 * que entraram no período, igual à aba Funil.
 */
export function JourneyNative({ label, range, channel, origem }: {
  label: string
  range: { from: string; to: string }
  channel: string
  origem: string
}) {
  const [data, setData] = useState<CrmJourneyNative | null>(null)

  useEffect(() => {
    let vivo = true
    setData(null)
    reportJourneyNative(range, channel, origem)
      .then((r) => { if (vivo) setData(r) })
      .catch((err) => toast.error(err instanceof Error ? err.message : 'Falha ao carregar a jornada'))
    return () => { vivo = false }
  }, [range.from, range.to, channel, origem])

  if (!data) return <Loader />

  const r = data.resumo
  if (r.leads === 0) {
    return (
      <div className="card">
        <EmptyState icon={<Users />} text={`Nenhum lead entrou no período (${label}).`} />
      </div>
    )
  }

  return (
    <>
      <div className="report-legend">
        <CalendarRange size={15} />
        <p>
          Tudo nesta aba fala dos <b>leads que entraram no período</b> ({label}) e do que o próprio
          sistema registrou deles: por quais etapas do funil passaram, como foi a conversa no
          WhatsApp e se compraram.
        </p>
      </div>

      <div className="crm-kpis at-kpis">
        <Kpi icon={<Users size={16} />} title="Leads" value={r.leads.toLocaleString('pt-BR')} desc="entraram no período" />
        <Kpi
          icon={<ShoppingBag size={16} />}
          title="Compraram"
          value={r.convertidos.toLocaleString('pt-BR')}
          desc={`${pct(r.convertidos, r.leads)} dos leads`}
        />
        <Kpi
          icon={<Hourglass size={16} />}
          title="Tempo até comprar"
          value={fmtDias(r.dias_ate_compra)}
          desc={r.dias_ate_compra_mediana == null ? 'da entrada à 1ª compra' : `média · mediana ${fmtDias(r.dias_ate_compra_mediana)}`}
        />
        <Kpi icon={<DollarSign size={16} />} title="Receita" value={formatBRL(r.receita_cents)} desc="dos leads que compraram" />
        <Kpi
          icon={<MessageCircle size={16} />}
          title="Com conversa"
          value={r.com_conversa.toLocaleString('pt-BR')}
          desc={`${pct(r.com_conversa, r.leads)} dos leads falaram no WhatsApp`}
        />
        <Kpi
          icon={<Reply size={16} />}
          title="Respondidos"
          value={r.respondidos.toLocaleString('pt-BR')}
          desc={`${pct(r.respondidos, r.com_conversa)} das conversas`}
        />
        <Kpi icon={<Clock size={16} />} title="Primeira resposta" value={fmtMin(r.tpr_min)} desc="tempo médio até a equipe responder" />
        <Kpi
          icon={<MessagesSquare size={16} />}
          title="Mensagens até comprar"
          value={r.msgs_ate_compra == null ? '—' : r.msgs_ate_compra.toLocaleString('pt-BR')}
          desc="média, somando cliente e equipe"
        />
      </div>

      <div className="at-report-grid">
        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>Por onde passaram</div>
          <p className="text-muted" style={{ fontSize: 11.5, marginBottom: 14 }}>
            Quantos leads do período passaram por cada etapa, quantos estão nela agora e quanto
            tempo levaram, em média, para chegar
          </p>
          <div className="at-reason-bars">
            {data.etapas.map((e) => (
              <div key={e.id} className="at-reason-bar">
                <div className="at-reason-bar-top">
                  <span>
                    <span className="jn-dot" style={{ background: e.cor }} aria-hidden="true" />
                    {e.nome}
                  </span>
                  <span className="text-secondary">
                    {e.passaram} · {pct(e.passaram, r.leads)}
                  </span>
                </div>
                <div className="at-reason-bar-track">
                  <div style={{ width: `${r.leads ? (e.passaram / r.leads) * 100 : 0}%`, background: COR_BARRA }} />
                </div>
                <div className="jn-stage-meta text-muted">
                  agora: {e.agora}
                  {e.dias_ate != null && <> · chegam em {fmtDias(e.dias_ate)}</>}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-title" style={{ marginBottom: 4 }}>Parados agora</div>
          <p className="text-muted" style={{ fontSize: 11.5, marginBottom: 14 }}>
            Leads do período que ainda não compraram, pela última mensagem da conversa
          </p>
          <div className="jn-stuck">
            <div>
              <MessageCircle size={16} />
              <strong>{r.aguardando_equipe}</strong>
              <span>esperando a equipe — o cliente falou por último</span>
            </div>
            <div>
              <UserX size={16} />
              <strong>{r.aguardando_cliente}</strong>
              <span>cliente sumiu — a equipe falou por último há mais de 24 h</span>
            </div>
          </div>
        </div>
      </div>

      <div className="card mb-16">
        <div className="card-title" style={{ marginBottom: 4 }}>Por origem</div>
        <p className="text-muted" style={{ fontSize: 11.5, marginBottom: 14 }}>
          Leads do período por origem: quantos compraram e quanto renderam
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Origem</th>
                <th className="at-num">Leads</th>
                <th className="at-num">Compraram</th>
                <th className="at-num">Taxa</th>
                <th className="at-num">Receita</th>
              </tr>
            </thead>
            <tbody>
              {data.por_origem.map((o) => (
                <tr key={o.origem}>
                  <td style={{ color: 'var(--text)' }}>{o.origem}</td>
                  <td className="at-num">{o.leads.toLocaleString('pt-BR')}</td>
                  <td className="at-num">{o.convertidos.toLocaleString('pt-BR')}</td>
                  <td className="at-num">{pct(o.convertidos, o.leads)}</td>
                  <td className="at-num">{formatBRL(o.receita_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

function Kpi({ icon, title, value, desc }: { icon: React.ReactNode; title: string; value: string; desc: string }) {
  return (
    <div className="kpi-card">
      <div className="kpi-card-bg" aria-hidden="true" />
      <div className="kpi-card-top"><span className="kpi-icon">{icon}</span></div>
      <div className="kpi-title">{title}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-desc">{desc}</div>
    </div>
  )
}
