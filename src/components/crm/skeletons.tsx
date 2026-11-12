/**
 * Esqueletos de carregamento dos relatórios.
 *
 * Existem por um motivo específico, não por enfeite. Trocar o filtro dispara
 * consulta nova, e até ela voltar a tela continuava mostrando os números do
 * filtro ANTERIOR. Em relatório isso é pior do que não mostrar nada: o número
 * velho não se anuncia como velho, e quem bateu o olho já leu — vai embora
 * com o ROAS dos últimos 30 dias achando que viu o de hoje.
 *
 * A REGRA DE USO: enquanto a consulta está no ar, o esqueleto ocupa o lugar
 * do dado. Nunca deixe o valor antigo à mostra "só até o novo chegar".
 *
 * As peças imitam a geometria do conteúdo real — altura de card, de linha de
 * tabela, de gráfico — para a página não pular quando o dado chega. Por isso
 * elas reusam as classes de verdade (.kpi-card, .ads-stats, .table-wrap) em
 * vez de terem layout próprio: mudando o card, o esqueleto acompanha sozinho.
 */

import type { CSSProperties, ReactNode } from 'react'

/** Barra cinza que pulsa. É a única peça que desenha alguma coisa. */
export function Skel({ w = '100%', h = 12, radius, style }: {
  w?: number | string
  h?: number
  /** Só quando a forma importa (ícone redondo, chip). O padrão já é arredondado. */
  radius?: number
  style?: CSSProperties
}) {
  return (
    <span
      className="skel"
      style={{
        width: w,
        height: h,
        ...(radius != null ? { borderRadius: radius } : null),
        ...style,
      }}
    />
  )
}

/**
 * Troca um valor pelo esqueleto enquanto ele está sendo recarregado.
 *
 * Serve para o caso mais chato: o card em que metade dos números já chegou
 * (vêm do banco) e a outra metade ainda não (vem da Meta). Sem isto, ou o
 * card inteiro some, ou o número velho fica.
 */
export function SkelValue({ on, w = 96, h = 22, children }: {
  on: boolean
  w?: number | string
  h?: number
  children: ReactNode
}) {
  if (!on) return <>{children}</>
  return <Skel w={w} h={h} style={{ margin: '4px 0' }} />
}

/** Fileira de KPIs, com a geometria dos cards de verdade. */
export function SkelKpis({ n = 4 }: { n?: number }) {
  return (
    <div className="crm-kpis" aria-busy="true">
      {Array.from({ length: n }, (_, i) => (
        <div className="kpi-card" key={i}>
          <Skel w={32} h={32} radius={11} />
          <Skel w="55%" h={11} style={{ marginTop: 18 }} />
          <Skel w="72%" h={26} style={{ marginTop: 12 }} />
          <Skel w="45%" h={10} style={{ marginTop: 12 }} />
        </div>
      ))}
    </div>
  )
}

/** Card com título e tabela — o esqueleto das quebras por campanha, anúncio, origem. */
export function SkelTableCard({ title, rows = 5, cols = 4 }: {
  /** Mantém o título de verdade à mostra: ele não depende da consulta. */
  title?: ReactNode
  rows?: number
  cols?: number
}) {
  return (
    <div className="card mb-16" aria-busy="true">
      {title
        ? <div className="card-title" style={{ marginBottom: 14 }}>{title}</div>
        : <Skel w={180} h={14} style={{ marginBottom: 16 }} />}
      <SkelRows rows={rows} cols={cols} />
    </div>
  )
}

/** Só as linhas, para quando o card já existe na tela. */
export function SkelRows({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div aria-busy="true">
      {Array.from({ length: rows }, (_, r) => (
        <div
          key={r}
          style={{
            display: 'grid',
            // A primeira coluna é o rótulo e é sempre a larga; as outras são
            // números alinhados à direita.
            gridTemplateColumns: `minmax(0, 2.2fr) repeat(${cols - 1}, minmax(0, 1fr))`,
            gap: 12,
            alignItems: 'center',
            padding: '11px 4px',
            borderBottom: r === rows - 1 ? 'none' : '1px solid var(--border)',
          }}
        >
          {Array.from({ length: cols }, (_, c) => (
            <Skel
              key={c}
              h={11}
              // Larguras irregulares: uma coluna de barras idênticas parece
              // tabela vazia, não tabela carregando.
              w={c === 0 ? `${55 + ((r * 13) % 35)}%` : `${40 + ((r * 7 + c * 11) % 30)}%`}
              style={c === 0 ? undefined : { marginLeft: 'auto' }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/** Área do gráfico: barras de alturas diferentes, para parecer gráfico. */
export function SkelChart({ height = 280 }: { height?: number }) {
  // Alturas fixas, não aleatórias: sorteadas a cada render, as barras
  // dançariam sozinhas e o esqueleto viraria a coisa mais viva da tela.
  const alturas = [42, 68, 55, 80, 38, 62, 74, 48, 88, 58, 70, 45, 66, 52]
  return (
    <div
      aria-busy="true"
      style={{
        height,
        display: 'flex',
        alignItems: 'flex-end',
        gap: 10,
        padding: '12px 4px 0',
      }}
    >
      {alturas.map((a, i) => (
        <Skel key={i} w="100%" h={Math.round((height - 24) * (a / 100))} radius={4} />
      ))}
    </div>
  )
}

/** O gráfico dentro do card, com título e legenda de mentira. */
export function SkelChartCard({ height = 280 }: { height?: number }) {
  return (
    <div className="card mb-16" aria-busy="true">
      <Skel w={230} h={14} style={{ marginBottom: 6 }} />
      <Skel w={340} h={10} style={{ marginBottom: 14 }} />
      <SkelChart height={height} />
    </div>
  )
}

/** Grade de métricas soltas — o formato do card "Entrega da Meta". */
export function SkelStats({ n = 8 }: { n?: number }) {
  return (
    <div className="card mb-16" aria-busy="true">
      <Skel w={210} h={14} style={{ marginBottom: 6 }} />
      <Skel w={320} h={10} style={{ marginBottom: 18 }} />
      <div className="ads-stats">
        {Array.from({ length: n }, (_, i) => (
          <div className="ads-stat" key={i}>
            <Skel w={26} h={26} radius={9} />
            <div className="ads-stat-body" style={{ width: '100%' }}>
              <Skel w="60%" h={16} />
              <Skel w="80%" h={10} style={{ marginTop: 8 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
