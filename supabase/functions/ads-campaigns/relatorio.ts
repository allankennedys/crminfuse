/**
 * Classificação e formatação do relatório de campanhas.
 *
 * Fora do index.ts pelo mesmo motivo da meta-ads/insights.ts: num arquivo que
 * chama Deno.serve() no topo, estas funções não podem ser exercitadas sem
 * subir a função inteira. E é aqui que mora a regra de negócio — a faixa de
 * ROI que decide se uma campanha escala ou morre —, que é justamente o que
 * alguém vai querer conferir sem token da Meta na mão.
 */

/** Mesma versão das outras funções: cada uma guarda a sua para poderem subir
    separadas, como a crm-worker já faz. */
export const META_API_VERSION = 'v21.0'

/**
 * AS FAIXAS DE ROI, E A LACUNA QUE O RASCUNHO DEIXOU
 *
 * O pedido descreveu três faixas — ≥3x quente, "entre 2x e 2,9x" morna,
 * <1x prejuízo — e entre 1x e 2x não havia regra nenhuma. Uma campanha com
 * ROI 1,5x simplesmente não teria classificação.
 *
 * O próprio exemplo do pedido resolve a lacuna: a "Campanha B" gasta R$ 60,
 * vende R$ 90 (ROI do dia = 1,5x) e está marcada como 🌤️ Morna. Então morna
 * é TUDO que está acima do prejuízo e abaixo do quente, e é assim que está
 * implementado. Se a intenção era outra — 1x a 2x virar uma quarta faixa —,
 * é este número que muda, e só ele.
 */
export const ROI_QUENTE = 3
export const ROI_MORNA = 1

/**
 * Prejuízo do dia que ainda é tolerável, em reais.
 *
 * O rascunho original se contradizia aqui: dizia "prejuízo até R$ 200
 * aceitável" e, na linha seguinte, "menos que isso, matar" — o que faria um
 * prejuízo MENOR ser pior que um maior. A leitura implementada é a única que
 * fecha: acima de R$ 200 é que dispara o alerta de matar.
 */
export const PREJUIZO_TOLERADO = 200

/** Quantas campanhas sem gasto cabem no rodapé antes de virar "+N". */
const TETO_SEM_GASTO = 6

/**
 * De quem é a campanha, lido do NOME. A mesma convenção da ads-daily,
 * repetida aqui porque cada Edge Function é publicada sozinha e não enxerga
 * o diretório da outra.
 *
 * A ORDEM IMPORTA: a primeira regra que casar vence. Recrutamento vem antes
 * de dono — "Recrutamento @PH" é vaga, não mídia do PH, e a ordem inversa
 * classificaria errado.
 *
 * Caixa não importa dos dois lados: o nome vindo da Meta e o padrão daqui
 * são rebaixados na comparação. Sem isso, alguém acrescentando "@Pedro" com
 * P maiúsculo a esta lista criaria uma regra que nunca casa — e a campanha
 * cairia calada em "Outros".
 *
 * Mudou a convenção da equipe? É esta lista que muda, e só ela.
 */
const DONOS: ReadonlyArray<{ dono: string; padroes: readonly string[] }> = [
  { dono: 'Recrutamento', padroes: ['recrutamento', 'vaga'] },
  { dono: 'Pedro', padroes: ['@pedro'] },
  { dono: 'PH', padroes: ['@ph'] },
]

/** O balde que impede uma campanha de sumir da soma por nome fora do padrão. */
export const OUTROS = 'Outros'
export const RECRUTAMENTO = 'Recrutamento'

/**
 * Ordem fixa das seções — não por gasto.
 *
 * Gasto reordenaria as seções todo dia, e quem lê cinco mensagens por dia
 * procura o próprio bloco no mesmo lugar. Dono desconhecido vai para o fim.
 */
const ORDEM_DONO = ['PH', 'Pedro', RECRUTAMENTO, OUTROS]

export function classificarDono(nome: string | null | undefined): string {
  const n = (nome ?? '').toLowerCase()
  for (const { dono, padroes } of DONOS) {
    if (padroes.some((p) => n.includes(p.toLowerCase()))) return dono
  }
  return OUTROS
}

export type Classe = 'quente' | 'morna' | 'aceitavel' | 'matar' | 'sem_gasto'

/** Uma campanha já somada, antes de classificada. */
export interface Campanha {
  id: string
  nome: string
  /** Rótulo da conta de anúncios, para o payload — não entra na mensagem. */
  conta: string
  /** PH, Pedro, Recrutamento ou Outros — lido do nome por classificarDono. */
  dono: string
  gastoHoje: number
  gastoMax: number
  vendasHoje: number
  vendasMax: number
}

export interface Avaliada extends Campanha {
  /** null quando o gasto do dia é zero: não há divisão a fazer. */
  roiHoje: number | null
  roiMax: number | null
  classe: Classe
  /** Só faz sentido nas classes de prejuízo; zero nas outras. */
  prejuizo: number
}

/**
 * ROI = vendas ÷ gasto. Sem gasto não há ROI — e devolver 0 aqui seria o
 * erro clássico: campanha que não gastou nada apareceria como prejuízo.
 */
export function roi(vendas: number, gasto: number): number | null {
  return gasto > 0 ? vendas / gasto : null
}

/**
 * Classifica pelo ROI DO DIA, não pelo do período máximo.
 *
 * A distinção é o ponto do relatório: o ROI de vida inteira de uma campanha
 * antiga é uma média que demora semanas para se mover, e não serve para
 * decidir nada às 14h. O que decide é o dia. O ROI máximo vai na mensagem
 * como contexto — "essa campanha já foi boa" —, nunca como gatilho.
 */
export function avaliar(c: Campanha): Avaliada {
  const roiHoje = roi(c.vendasHoje, c.gastoHoje)
  const roiMax = roi(c.vendasMax, c.gastoMax)
  const prejuizo = Math.max(0, c.gastoHoje - c.vendasHoje)

  let classe: Classe
  if (roiHoje === null) classe = 'sem_gasto'
  else if (roiHoje >= ROI_QUENTE) classe = 'quente'
  else if (roiHoje >= ROI_MORNA) classe = 'morna'
  else classe = prejuizo > PREJUIZO_TOLERADO ? 'matar' : 'aceitavel'

  return { ...c, roiHoje, roiMax, classe, prejuizo }
}

/**
 * Ordem das faixas na mensagem — a mesma do exemplo do pedido: começa no que
 * está indo bem e termina no que precisa morrer.
 *
 * Manter o alerta no FIM só funciona porque o cabeçalho anuncia quantas
 * campanhas precisam ser mortas; sem essa linha, a informação mais urgente
 * ficaria embaixo de um scroll no celular.
 */
const ORDEM: Record<Classe, number> = {
  quente: 0, morna: 1, aceitavel: 2, matar: 3, sem_gasto: 4,
}

export function ordenar(lista: Avaliada[]): Avaliada[] {
  return [...lista].sort((a, b) =>
    ORDEM[a.classe] - ORDEM[b.classe] || b.gastoHoje - a.gastoHoje)
}

/**
 * Dinheiro em reais inteiros, como no exemplo do pedido ("R$ 850").
 *
 * Centavos são ruído numa mensagem lida no celular e não mudam nenhuma das
 * decisões daqui: as faixas são 1x, 3x e R$ 200. A comparação de prejuízo
 * usa o valor EXATO, não este texto — arredondar antes de comparar deixaria
 * um prejuízo de R$ 200,40 escapar do alerta por causa da formatação.
 */
export function dinheiro(v: number, moeda = 'BRL'): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: moeda,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(v)
}

/** "4,4x"; "0x" quando é zero cravado; "—" quando não houve gasto. */
export function roiTexto(v: number | null): string {
  if (v === null) return '—'
  if (v === 0) return '0x'
  return `${v.toFixed(1).replace('.', ',')}x`
}

/** O selo que vai na frente do nome da campanha. */
export function selo(c: Avaliada, moeda: string): string {
  switch (c.classe) {
    case 'quente': return '🔥 Quente'
    case 'morna': return '🌤️ Morna'
    case 'aceitavel':
      return `🥶 Prejuízo (${dinheiro(c.prejuizo, moeda)}) — dentro do aceitável`
    case 'matar':
      return `🥶 Prejuízo (${dinheiro(c.prejuizo, moeda)}) — ⚠️ MATAR CAMPANHA`
    case 'sem_gasto': return 'sem gasto hoje'
  }
}

/**
 * "10h05" no relógio de São Paulo — a hora REAL do disparo, não a hora
 * agendada. O cron dispara aos 5 minutos (086), então é isso que sai no
 * cabeçalho; um reprocessamento à mão às 23h47 diz "23h47", que é o que
 * distingue a segunda entrega do dia da primeira.
 */
export function horaEmSP(agora: Date = new Date()): string {
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(agora)
  const pega = (t: string) => partes.find((p) => p.type === t)?.value ?? '00'
  return `${pega('hour')}h${pega('minute')}`
}

/**
 * O dia de hoje em São Paulo, "AAAA-MM-DD" — o formato que a Meta espera.
 *
 * Diferente da ads-daily, que manda o dia ANTERIOR: aqui o relatório é do
 * dia corrente, em andamento. `agora` é parâmetro para o teste poder fixar o
 * instante; às 21h UTC ainda é o mesmo dia em SP, mas às 00:30 UTC (fora da
 * janela do cron, mas alcançável à mão) já não é.
 */
export function hojeEmSP(agora: Date = new Date()): string {
  // en-CA formata como AAAA-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(agora)
}

export interface DadosDaMensagem {
  hora: string
  moeda: string
  gastoTotal: number
  campanhas: Avaliada[]
  /** Ativas que não gastaram nada hoje — vão numa linha só, no rodapé. */
  semGasto: string[]
  /** Gasto de hoje em campanhas que não estão mais ativas. */
  gastoPausadas: number
  /** Gasto de hoje nas campanhas da lista de ignoradas (059). */
  foraDoRelatorio: number
  /** Contas que a Meta não respondeu, com o motivo. */
  falhas: Array<{ conta: string; erro: string }>
  moedasDiferentes: boolean
}

/**
 * A mensagem pronta para o WhatsApp.
 *
 * Texto puro com `*negrito*` — a marcação que o WhatsApp entende. Nada de
 * markdown de verdade: `**assim**` sai literal na conversa.
 *
 * O QUE O SELO USA E O QUE A MENSAGEM MOSTRA SÃO COISAS DIFERENTES
 *
 * A classificação continua saindo do ROI DO DIA (`avaliar`), como o pedido
 * define. O que a mensagem exibe, por decisão do cliente, é só o acumulado:
 * gasto de hoje, gasto e vendas de vida inteira, ROI máximo.
 *
 * A consequência é real e é para ser assim: o selo NÃO é conferível pelos
 * números visíveis. Uma campanha pode aparecer 🔥 Quente ao lado de
 * "ROI máximo: 0,5x" — ela vendeu bem HOJE e mal na vida toda, e as duas
 * coisas são verdade. Quem precisar auditar o selo encontra `roi_hoje` e
 * `vendas_hoje` no payload, que continuam sendo calculados e enviados.
 *
 * TODO NÚMERO QUE SOME DA LISTA APARECE EM ALGUM LUGAR
 *
 * O gasto total é de TODAS as campanhas do dia, não só das ativas listadas.
 * Uma campanha pausada ao meio-dia gastou de verdade, e apagá-la do total
 * faria a mensagem discordar do Gerenciador sem nada explicando a diferença
 * — o erro que a ads-daily evita com o balde "Outros". Por isso o rodapé
 * declara, em linha própria, o gasto das pausadas e o das ignoradas.
 */
export function montarMensagem(d: DadosDaMensagem): string {
  const $ = (v: number) => dinheiro(v, d.moeda)
  const linhas: string[] = [`📊 *Resumo de Campanhas* — ${d.hora}`, '']

  linhas.push(`💰 Gasto total hoje: ${$(d.gastoTotal)}`)

  // No topo de propósito: é a única informação da mensagem que pede ação
  // agora, e o bloco dela fica lá embaixo. Recrutamento fica de fora — ver
  // o loop das seções.
  const matar = d.campanhas
    .filter((c) => c.classe === 'matar' && c.dono !== RECRUTAMENTO).length
  if (matar > 0) {
    linhas.push('')
    linhas.push(matar === 1
      ? '⚠️ *1 campanha para matar* — veja no fim'
      : `⚠️ *${matar} campanhas para matar* — veja no fim`)
  }

  if (d.moedasDiferentes) {
    linhas.push('')
    linhas.push('⚠️ Contas em moedas diferentes: o total acima não soma.')
  }

  if (d.campanhas.length === 0) {
    linhas.push('')
    linhas.push('Nenhuma campanha ativa registrou gasto hoje.')
  }

  /**
   * As seções, na ordem fixa, e depois qualquer dono que apareça sem estar
   * em ORDEM_DONO. Esse rabo existe para o mesmo perigo do balde "Outros":
   * quem acrescentar um dono novo a DONOS e esquecer de ORDEM_DONO veria as
   * campanhas dele sumirem da mensagem enquanto continuam no total.
   */
  const presentes = [...new Set(d.campanhas.map((c) => c.dono))]
  const secoes = [
    ...ORDEM_DONO.filter((x) => presentes.includes(x)),
    ...presentes.filter((x) => !ORDEM_DONO.includes(x)).sort(),
  ]

  for (const dono of secoes) {
    const doDono = d.campanhas.filter((c) => c.dono === dono)
    const gastoDoDono = doDono.reduce((soma, c) => soma + c.gastoHoje, 0)
    const vaga = dono === RECRUTAMENTO

    linhas.push('')
    linhas.push(`${vaga ? '📋' : '👤'} *${dono.toUpperCase()}* — ${$(gastoDoDono)} hoje`)

    for (const c of doDono) {
      linhas.push('')
      // Recrutamento não ganha selo nem linha de venda: não é campanha de
      // venda, nunca vai ter receita, e um "🥶 Prejuízo — MATAR CAMPANHA"
      // ali seria conselho para derrubar uma vaga aberta. Só o gasto, que é
      // a única coisa que a vaga de fato consome.
      linhas.push(vaga ? `*${c.nome}*` : `*${c.nome}* ${selo(c, d.moeda)}`)
      linhas.push(`Gasto hoje: ${$(c.gastoHoje)} | Gasto máximo: ${$(c.gastoMax)}`)
      if (!vaga) {
        linhas.push(`Vendas máximo: ${$(c.vendasMax)}`)
        linhas.push(`ROI máximo: ${roiTexto(c.roiMax)}`)
      }
    }
  }

  const rodape: string[] = []
  if (d.semGasto.length > 0) {
    const mostra = d.semGasto.slice(0, TETO_SEM_GASTO).join(', ')
    const resto = d.semGasto.length - TETO_SEM_GASTO
    rodape.push(`Ativas sem gasto hoje: ${mostra}${resto > 0 ? ` +${resto}` : ''}`)
  }
  if (d.gastoPausadas > 0) {
    rodape.push(`Gasto hoje em campanhas já pausadas: ${$(d.gastoPausadas)}`)
  }
  if (d.foraDoRelatorio > 0) {
    rodape.push(`Fora do relatório (recrutamento etc.): ${$(d.foraDoRelatorio)}`)
  }
  for (const f of d.falhas) {
    rodape.push(`⚠️ Conta sem resposta da Meta: ${f.conta} — ${f.erro}`)
  }

  if (rodape.length > 0) {
    linhas.push('')
    linhas.push('—')
    linhas.push(...rodape)
  }

  return linhas.join('\n')
}
