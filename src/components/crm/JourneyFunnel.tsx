import { fmtInt, fmtPct, formatDuration } from './reportKit'
import type { CrmJourneyStageFlowRow } from '@/types'

/** Um degrau já pronto para desenhar — o que as visões do funil consomem. */
export interface PassoDoFunil {
  key: string
  label: string
  /** Selo ao lado do nome, para o degrau que não é coluna do funil. */
  badge?: string
  hint: string
  color?: string
  reached: number
  /**
   * Nulo no último degrau, onde "não avançou" é conversão. O portfólio tem
   * queda desde a 092: recebeu e não entrou em nenhuma etapa depois dele.
   */
  dropped: number | null
  dropRate: number | null
  /**
   * Fora da corrente do funil (o degrau do portfólio, 084). O fio da visão
   * Jornada passa por baixo dele e nenhuma queda é desenhada ao lado.
   */
  offChain?: boolean
  worst?: boolean
}

/**
 * O card "Etapa de maior perda do funil", visual de 11/09/2026. O anterior
 * está guardado em JourneyFunnelLegacy.tsx, sem ligação com a tela.
 *
 * A PERGUNTA DO CARD É UMA SÓ: ONDE PERDEMOS MAIS
 *
 * Então o desenho é de ênfase, não de identidade. Todas as barras no mesmo
 * cinza (--metric) e só o pedaço perdido da pior etapa em vermelho — a cor
 * da etapa no kanban não entra: etapa de funil é sequência, e uma cor por
 * etapa vira arco-íris que disputa atenção com a única coisa que importa.
 *
 * CADA BARRA JÁ MOSTRA A QUEDA
 *
 * A barra é quantos ENTRARAM na etapa, dividida em quem seguiu e quem parou
 * ali (087: parou = entrou e não entrou em nenhuma etapa posterior). A queda
 * vira comprimento dentro da própria linha, sem etiqueta flutuando entre
 * duas barras.
 *
 * NENHUM NÚMERO DEPENDE DO MOUSE
 *
 * As duas colunas à direita são a tabela do gráfico: quantos chegaram e
 * quantos pararam, alinhados para comparar de cima a baixo. O title da linha
 * só acrescenta o tempo médio até chegar.
 */
export function FunilDePerdas({ base, steps, maior }: {
  /** A maior etapa: é ela que ocupa a largura inteira. */
  base: number
  steps: PassoDoFunil[]
  maior: CrmJourneyStageFlowRow | null
}) {
  const largura = (q: number) => {
    const pct = base > 0 ? (q / base) * 100 : 0
    // Piso de 1%: etapa com gente não pode sumir e parecer vazia.
    return Math.max(pct, q > 0 ? 1 : 0)
  }

  return (
    <div className="jl">
      {maior && (
        <div className="jl-lead">
          <div className="jl-lead-kicker">Maior perda</div>
          <p className="jl-lead-main">
            <strong>{maior.stage_name}</strong>
            <span className="jl-lead-sep" aria-hidden="true">·</span>
            {fmtInt(maior.dropped ?? 0)} de {fmtInt(maior.reached)} pararam ali
            {maior.drop_rate != null && <span className="jl-lead-rate"> ({fmtPct(maior.drop_rate)})</span>}
          </p>
          {/* O tempo até o PRIMEIRO degrau é sempre perto de zero (o lead
              entra nele ao ser criado): seria ruído com cara de métrica. */}
          {maior.ord > 1 && maior.avg_hours_to_reach != null && (
            <p className="jl-lead-sub">
              O lead leva em média {formatDuration(maior.avg_hours_to_reach)} desde a entrada
              para chegar a essa etapa.
            </p>
          )}
        </div>
      )}

      <div className="jl-table" role="table" aria-label="Leads por etapa do funil">
        <div className="jl-row jl-head" role="row">
          <span role="columnheader">Etapa</span>
          <span role="columnheader" className="jl-legend">
            <span><i className="jl-key jl-key-on" aria-hidden="true" />seguiram</span>
            <span><i className="jl-key jl-key-off" aria-hidden="true" />pararam ali</span>
          </span>
          <span role="columnheader" className="jl-num">Chegaram</span>
          <span role="columnheader" className="jl-num">Pararam</span>
        </div>

        {steps.map((s) => {
          const pararam = s.dropped ?? 0
          const seguiram = Math.max(0, s.reached - pararam)
          return (
            <div className={`jl-row${s.worst ? ' jl-row-worst' : ''}`} role="row" key={s.key} title={s.hint}>
              <span className="jl-name" role="cell">{s.label}</span>
              <span className="jl-barcell" role="cell">
                <span className="jl-bar" style={{ width: `${largura(s.reached)}%` }}>
                  {/* flex-grow proporcional às contagens: a divisão fica
                      certa sem calcular pixel. Segmento vazio nem entra,
                      senão sobra o vão de 2px sozinho na ponta. */}
                  {seguiram > 0 && (
                    <span className="jl-seg jl-seg-on" style={{ flexGrow: seguiram }} />
                  )}
                  {pararam > 0 && (
                    <span
                      className={`jl-seg ${s.worst ? 'jl-seg-worst' : 'jl-seg-off'}`}
                      style={{ flexGrow: pararam }}
                    />
                  )}
                </span>
              </span>
              <span className="jl-num jl-count" role="cell">{fmtInt(s.reached)}</span>
              <span className={`jl-num jl-drop${s.worst ? ' jl-drop-worst' : ''}`} role="cell">
                {s.dropped == null ? (
                  // Última etapa: não há "próxima" para onde deixar de ir.
                  <span className="jl-na">—</span>
                ) : (
                  <>
                    {fmtInt(pararam)}
                    {s.dropRate != null && pararam > 0 && <small>{fmtPct(s.dropRate)}</small>}
                  </>
                )}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
