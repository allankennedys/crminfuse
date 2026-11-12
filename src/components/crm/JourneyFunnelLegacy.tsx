import { TrendingDown } from 'lucide-react'
import { fmtInt, fmtPct, formatDuration } from './reportKit'
import type { PassoDoFunil } from './JourneyFunnel'
import type { CrmJourneyStageFlowRow } from '@/types'

/**
 * O card "Etapa de maior perda do funil" como era até 11/09/2026: o quadro
 * do maior vazamento e as duas visões, Jornada (colunas ligadas por um fio)
 * e Escada (barras deitadas).
 *
 * GUARDADO PARA VOLTAR, SEM LIGAÇÃO COM A TELA. O visual em uso é o
 * FunilDePerdas (JourneyFunnel.tsx); a opção de ver este saiu da tela em
 * 11/09/2026. O código daqui foi movido do JourneyReport sem mudar nada.
 * Para voltar a ele: renderizar <FunilAnterior> no lugar do FunilDePerdas e
 * devolver ao cabeçalho do card o seletor Jornada/Escada — o commit 08aef5b
 * tem as duas coisas prontas, com a troca entre os visuais.
 */
export function FunilAnterior({ base, steps, maior, vista }: {
  base: number
  steps: PassoDoFunil[]
  maior: CrmJourneyStageFlowRow | null
  vista: 'jornada' | 'escada'
}) {
  return (
    <>
      {maior && (
        <div className="journey-callout">
          <TrendingDown size={16} />
          <div>
            <strong>
              O maior vazamento está em {maior.stage_name}:{' '}
              {fmtInt(maior.dropped ?? 0)} leads
              {maior.drop_rate != null && <> ({fmtPct(maior.drop_rate)})</>}
              {' '}entraram e não avançaram.
            </strong>
            <p>
              {/* "seguiram" sai do próprio degrau (entraram − pararam), não do
                  reached do vizinho: sem o cumulativo, quem entra na etapa
                  seguinte pode nunca ter passado por esta. */}
              De {fmtInt(maior.reached)} que passaram por{' '}
              {maior.stage_name},{' '}
              {fmtInt(maior.reached - (maior.dropped ?? 0))} seguiram
              adiante
              {/* O tempo até o PRIMEIRO degrau é sempre perto de zero (o
                  lead entra nele ao ser criado): dizer "leva 12 min para
                  chegar a Novo lead" é ruído com cara de métrica. */}
              {maior.ord > 1 && maior.avg_hours_to_reach != null && (
                <> · o lead leva em média {formatDuration(maior.avg_hours_to_reach)}
                  {' '}desde a entrada para chegar a {maior.stage_name}</>
              )}.
            </p>
          </div>
        </div>
      )}
      {vista === 'jornada'
        ? <FunnelJourney base={base} steps={steps} />
        : <FunnelLadder base={base} steps={steps} />}
    </>
  )
}

/**
 * A escada do funil: uma barra por degrau, proporcional a quantos leads
 * chegaram nele, e entre dois degraus a linha do vazamento.
 *
 * Barra proporcional em vez de gráfico de funil de biblioteca porque o que
 * se lê aqui é a QUEDA entre degraus vizinhos — e num funil trapezoidal a
 * queda vira área, que ninguém compara de olho.
 */
function FunnelLadder({ base, steps }: { base: number; steps: PassoDoFunil[] }) {
  return (
    <div className="journey-funnel">
      {steps.map((s, i) => {
        const pct = base > 0 ? (s.reached / base) * 100 : 0
        const ultimo = i === steps.length - 1
        return (
          <div key={s.key}>
            <div className="jf-step">
              <div className="jf-head">
                <span className="jf-label" title={s.hint}>
                  {s.color && <i className="jf-dot" style={{ background: s.color }} />}
                  {s.label}
                  {/* marginLeft zerado: o .jf-label já é flex com gap. */}
                  {s.badge && (
                    <span className="journey-chip" style={{ marginLeft: 0 }}>{s.badge}</span>
                  )}
                </span>
                <span className="jf-count">
                  <b>{fmtInt(s.reached)}</b>
                  <span className="jf-share">{base > 0 ? `${Math.round(pct)}%` : '—'}</span>
                </span>
              </div>
              <div className="jf-bar">
                <span
                  style={{
                    width: `${Math.max(pct, s.reached > 0 ? 1.5 : 0)}%`,
                    background: s.color ?? 'var(--primary)',
                  }}
                />
              </div>
            </div>
            {/* Marcador fora da corrente não tem queda para o seguinte. */}
            {!ultimo && s.dropped != null && (
              <div className={`jf-leak${s.worst ? ' jf-leak-worst' : ''}`}>
                <TrendingDown size={12} />
                {s.dropped > 0 ? (
                  <>
                    <b>{fmtInt(s.dropped)}</b> pararam aqui
                    {s.dropRate != null && <> ({fmtPct(s.dropRate)})</>}
                    {s.worst && <span className="jf-badge">maior vazamento</span>}
                  </>
                ) : (
                  <>ninguém ficou pelo caminho</>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * A mesma escada, deitada — a visão de jornada.
 *
 * POR QUE NÃO É UM FUNIL EM CONE
 *
 * O trapézio é o desenho óbvio de "jornada" e é o errado para esta
 * pergunta: nele a queda entre dois degraus vira ÁREA, e área ninguém
 * compara de olho. Aqui cada degrau é uma coluna contra a mesma trilha de
 * 100%, então a queda continua sendo comprimento — a única coisa que o
 * olho compara bem. É a mesma razão que a escada vertical já dava.
 *
 * O QUE FAZ ISTO LER COMO PERCURSO
 *
 * O fio que liga o topo de uma barra ao topo da seguinte. Sem ele são cinco
 * barras lado a lado; com ele o olho desce da esquerda para a direita e vê
 * onde o tombo é feio. O fio é um SVG esticado dentro do vão
 * (preserveAspectRatio="none"), com vector-effect="non-scaling-stroke" para
 * o esticão não engordar a diagonal.
 *
 * NENHUM NÚMERO DEPENDE DE PASSAR O MOUSE
 *
 * Quantos chegaram, a fatia e a queda estão escritos na tela. O title só
 * acrescenta o tempo médio — e a visão em escada, no botão ao lado, é a
 * mesma informação em forma de lista para quem preferir ler.
 */
function FunnelJourney({ base, steps }: { base: number; steps: PassoDoFunil[] }) {
  const n = steps.length
  /**
   * Altura da barra em % da trilha. O piso de 1,5% é o que impede um degrau
   * com gente de sumir e virar "zero" — e o fio precisa da MESMA conta, ou
   * ele encosta no lugar errado da barra.
   */
  const altura = (q: number) => {
    const pct = base > 0 ? (q / base) * 100 : 0
    return Math.max(pct, q > 0 ? 1.5 : 0)
  }
  /** Topo da barra i em coordenada de SVG (y cresce para baixo). */
  const topo = (i: number) => 100 - altura(steps[i].reached)
  /**
   * Os índices que o fio percorre. O marcador do portfólio fica de fora: ele
   * não é etapa cumprida, e ligá-lo à corrente desenharia uma subida que
   * ninguém andou.
   */
  const corrente = steps
    .map((p, i) => (p.offChain ? -1 : i))
    .filter((i) => i >= 0)
  /**
   * Onde a etiqueta da queda pousa: no meio do fio entre os degraus i e j,
   * mas nunca tão em cima ou tão embaixo que metade dela fique fora da
   * faixa. Sem a trava, dois degraus de mesma altura no topo põem a etiqueta
   * metade para fora do gráfico, por cima do texto do card.
   */
  const pouso = (i: number, j: number) =>
    Math.min(88, Math.max(12, (topo(i) + topo(j)) / 2))

  return (
    <div className="jj-wrap">
      <div className="jj">
        <div
          className="jj-cols"
          style={{ gridTemplateColumns: `repeat(${n}, minmax(96px, 1fr))` }}
        >
          {steps.map((s) => (
            <div className="jj-step" key={s.key}>
              <div className="jj-plot" title={s.hint}>
                <div className="jj-track">
                  <span
                    className="jj-fill"
                    style={{
                      height: `${altura(s.reached)}%`,
                      background: s.color ?? 'var(--primary)',
                    }}
                  />
                </div>
              </div>
              <div className="jj-baseline" />
              <div className="jj-meta">
                <div className="jj-val">{fmtInt(s.reached)}</div>
                <div className="jj-share">
                  {base > 0 ? `${Math.round((s.reached / base) * 100)}%` : '—'}
                </div>
                <div className="jj-name" title={s.hint}>
                  {s.color && <i className="jf-dot" style={{ background: s.color }} />}
                  {s.label}
                </div>
                {s.badge && (
                  <div>
                    <span className="journey-chip" style={{ marginLeft: 0 }}>{s.badge}</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* O percurso por cima das barras. Um degrau só não tem percurso. */}
        {n > 1 && (
          <div className="jj-overlay">
            <svg
              className="jj-link"
              viewBox={`0 0 ${n} 100`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {/* Centro da coluna i = i + 0,5, porque as colunas do grid têm
                  todas a mesma largura. É isto que dispensa medir pixel. */}
              <polyline
                points={corrente.map((i) => `${i + 0.5},${topo(i)}`).join(' ')}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            {corrente.slice(0, -1).map((i, k) => {
              const passo = steps[i]
              const seguinte = corrente[k + 1]
              if (passo.dropped == null) return null
              return (
                <span
                  key={passo.key}
                  className={`jj-drop${passo.worst ? ' jj-drop-worst' : ''}`}
                  // Encostada na coluna que perdeu a gente, e não no meio do
                  // trecho: entre dois degraus da corrente pode haver o
                  // marcador do portfólio, e a etiqueta pousaria em cima dele.
                  style={{
                    left: `${((i + 1) / n) * 100}%`,
                    top: `${pouso(i, seguinte)}%`,
                  }}
                  title={passo.dropped > 0
                    ? `${fmtInt(passo.dropped)} pararam em ${passo.label}`
                    : `ninguém parou em ${passo.label}`}
                >
                  <b>{passo.dropped > 0 ? `\u2212${fmtInt(passo.dropped)}` : '0'}</b>
                  {passo.dropped > 0 && passo.dropRate != null && <em>{fmtPct(passo.dropRate)}</em>}
                </span>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
