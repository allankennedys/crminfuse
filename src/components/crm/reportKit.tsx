/**
 * Peças compartilhadas pelas abas de relatório do CRM.
 *
 * Nasceu quando a aba Jornada passou a precisar das mesmas formatações e da
 * mesma tabela de quebra que a aba Funil usa. Duas cópias de "o que é uma
 * taxa" e de "o que é 'base inteira'" acabariam divergindo — e divergência
 * de formatação em relatório parece divergência de número.
 *
 * Aqui só entra o que mais de uma aba usa. Gráfico, seletor de período e as
 * peças de uma aba só continuam em CrmReports.tsx.
 */

import { useState, type CSSProperties, type ReactNode } from 'react'
import { CalendarRange, ChevronDown } from 'lucide-react'
import { formatBRL } from '@/services/crmService'
import type { CrmReportBreakdownRow } from '@/types'

export function fmtPct(v: number | null): string {
  return v == null ? '—' : `${v.toLocaleString('pt-BR')}%`
}

export function fmtInt(v: number): string {
  return Math.round(v).toLocaleString('pt-BR')
}

/** Duas casas, para CTR, frequência e afins. */
export function fmtDec(v: number, digits = 2): string {
  return v.toLocaleString('pt-BR', { maximumFractionDigits: digits })
}

/** "12h", "1,5 d" ou "—". Horas viram dias a partir de 48h para não virar número gigante. */
export function formatDuration(hours: number | null): string {
  if (hours == null) return '—'
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`
  if (hours < 48) return `${Math.round(hours)} h`
  return `${(hours / 24).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} d`
}

/**
 * Diz por qual data o card recorta o período. É a diferença entre coorte e
 * fluxo — os dois recortes convivem na mesma tela e sem a marca os números
 * parecem se contradizer. Duas palavras no card, o resto no title.
 */
export function ScopeTag({ kind }: { kind: 'entrada' | 'conversao' | 'base' }) {
  const TITLES = {
    entrada: 'Recorta por data de entrada: só os leads criados no período.',
    conversao: 'Recorta por data da conversão: fechou no período, venha o lead de quando vier.',
    // A terceira marca existe porque na aba Recompra os cards de carteira
    // convivem com os do período na mesma fileira. Sem ela, "18% de
    // recompra" ao lado de um filtro de 7 dias parece falar dos 7 dias.
    base: 'Ignora o período selecionado: é uma propriedade da carteira de '
      + 'clientes, não da janela. Recortá-la mediria outra coisa.',
  } as const
  const LABELS = { entrada: 'entrada', conversao: 'conversão', base: 'base inteira' } as const
  return (
    <span className={`kpi-scope kpi-scope-${kind}`} title={TITLES[kind]}>
      <CalendarRange size={10} />
      {LABELS[kind]}
    </span>
  )
}

/**
 * Card que encolhe no clique do cabeçalho.
 *
 * Existe para as seções de LISTA — conversas, fila de recuperação, clientes.
 * Elas são as mais altas do relatório e as que menos se lê de uma vez: com
 * três delas abertas, chegar ao fim da aba é meia dúzia de rolagens. Os
 * cards de número e os gráficos continuam fixos, porque são o que se olha
 * toda vez.
 *
 * O cabeçalho é um <button> de verdade: teclado e leitor de tela ganham o
 * mesmo comportamento sem nada a mais, e `aria-expanded` diz o estado.
 *
 * O conteúdo é DESMONTADO ao fechar, não escondido por CSS. Aqui dentro há
 * tabela com centenas de linhas, e mantê-las no DOM invisíveis só cobra
 * memória e tempo de layout.
 *
 * `hint` é o resumo que fica visível com o card fechado — sem ele, fechar a
 * seção apaga qualquer pista do que tem dentro.
 *
 * `open` + `onOpenChange` = quem chama guarda o estado. Serve para o card
 * que é desmontado no meio do caminho (o relatório que vira esqueleto a cada
 * troca de filtro): com o estado aqui dentro, a escolha voltaria ao padrão.
 */
export function CollapsibleCard({
  title, icon, hint, subtitle, defaultOpen = true, open: openProp, onOpenChange, style, children,
}: {
  title: ReactNode
  icon?: ReactNode
  /** Resumo curto à direita do título, visível também quando fechado. */
  hint?: ReactNode
  /** Linha de contexto sob o título; some junto com o corpo. */
  subtitle?: ReactNode
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Espaçamento do card no lugar onde ele entra; o resto vem da classe. */
  style?: CSSProperties
  children: ReactNode
}) {
  const [openLocal, setOpenLocal] = useState(defaultOpen)
  const open = openProp ?? openLocal
  function toggle() {
    setOpenLocal(!open)
    onOpenChange?.(!open)
  }
  return (
    <div className={`card mb-16 collapsible${open ? '' : ' is-closed'}`} style={style}>
      <button
        type="button"
        className="collapsible-head"
        onClick={toggle}
        aria-expanded={open}
      >
        <span className="card-title" style={{ marginBottom: 0 }}>{icon} {title}</span>
        {hint && <span className="collapsible-hint">{hint}</span>}
        <ChevronDown size={16} className="collapsible-caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="collapsible-body">
          {subtitle && (
            <p className="text-muted" style={{ fontSize: 11.5, margin: '4px 0 14px' }}>{subtitle}</p>
          )}
          {children}
        </div>
      )}
    </div>
  )
}

/** Tabela de quebra: leads, conversões, taxa e receita por dimensão. */
export function BreakdownCard({ title, colHead, icon, rows, emptyText, note }: {
  title: string
  colHead: string
  icon: ReactNode
  rows: CrmReportBreakdownRow[]
  emptyText: string
  /** Linha de contexto sob o título — de onde vem o número, o que ele não é. */
  note?: string
}) {
  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: note ? 4 : 14 }}>{icon} {title}</div>
      {note && (
        <p className="text-muted" style={{ fontSize: 11.5, marginBottom: 14 }}>{note}</p>
      )}
      {rows.length === 0 ? (
        <p className="text-muted" style={{ fontSize: 13 }}>{emptyText}</p>
      ) : (
        <div className="table-wrap" style={{ border: 'none', background: 'transparent' }}>
          <table>
            <thead>
              <tr>
                <th>{colHead}</th>
                <th style={{ textAlign: 'right' }}>Leads</th>
                <th style={{ textAlign: 'right' }}>Conv.</th>
                <th style={{ textAlign: 'right' }}>Taxa</th>
                <th style={{ textAlign: 'right' }}>Receita</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.label}
                  </td>
                  <td style={{ textAlign: 'right' }}>{r.leads.toLocaleString('pt-BR')}</td>
                  <td style={{ textAlign: 'right' }}>{r.converted.toLocaleString('pt-BR')}</td>
                  <td style={{ textAlign: 'right', minWidth: 96 }}>
                    <div className="rate-cell">
                      <div className="rate-bar">
                        <span style={{ width: `${Math.min(100, r.conversion_rate ?? 0)}%` }} />
                      </div>
                      <span className="rate-num">{fmtPct(r.conversion_rate)}</span>
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }}>{formatBRL(r.revenue_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
