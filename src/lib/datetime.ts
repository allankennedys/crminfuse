/**
 * Utilidades de data/hora fixadas no fuso de São Paulo.
 *
 * Toda a operação é no Brasil, então exibição e agendamento usam sempre
 * America/Sao_Paulo — independente do fuso do dispositivo de quem abre o painel.
 * Usa apenas Intl nativo (sem dependências extras).
 */

export const SP_TZ = 'America/Sao_Paulo'

type Parts = Record<string, number>

function getParts(date: Date, opts: Intl.DateTimeFormatOptions): Parts {
  const fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: SP_TZ, hour12: false, ...opts })
  const out: Parts = {}
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  // "24h" de meia-noite às vezes vem como 24 — normaliza para 0
  if (out.hour === 24) out.hour = 0
  return out
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * Formata um instante (ISO string ou Date) no horário de São Paulo.
 *  - withSeconds: inclui segundos
 *  - withAt: usa "dd/MM/yyyy 'às' HH:mm"
 */
export function formatSP(
  input: string | Date,
  opts: { withSeconds?: boolean; withAt?: boolean } = {},
): string {
  const date = typeof input === 'string' ? new Date(input) : input
  if (isNaN(date.getTime())) return '—'
  const p = getParts(date, {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    ...(opts.withSeconds ? { second: '2-digit' } : {}),
  })
  const dmy = `${pad(p.day)}/${pad(p.month)}/${p.year}`
  const hms = opts.withSeconds
    ? `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
    : `${pad(p.hour)}:${pad(p.minute)}`
  return opts.withAt ? `${dmy} às ${hms}` : `${dmy} ${hms}`
}

/** Offset (ms) do fuso SP no instante dado: (relógio de parede em SP) - UTC. */
function spOffsetMs(date: Date): number {
  const p = getParts(date, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const asUtcWall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtcWall - date.getTime()
}

/**
 * Converte um valor de <input type="datetime-local"> ("YYYY-MM-DDTHH:mm"),
 * interpretado como HORÁRIO DE SÃO PAULO, para o instante UTC (ISO string).
 */
export function spWallTimeToUtcISO(wall: string): string {
  const [datePart, timePart] = wall.split('T')
  const [y, mo, d] = datePart.split('-').map(Number)
  const [h, mi] = (timePart ?? '00:00').split(':').map(Number)
  // 1º palpite: trata os componentes como se fossem UTC
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  // Corrige pelo offset do fuso naquele instante (SP não tem DST hoje)
  const offset = spOffsetMs(new Date(guess))
  return new Date(guess - offset).toISOString()
}

/**
 * Instante (ISO string ou Date) → valor de <input type="datetime-local">
 * no horário de SP. Inverso de `spWallTimeToUtcISO` — usado para
 * pré-preencher o formulário ao editar algo já agendado.
 */
export function spDatetimeLocal(input: string | Date): string {
  const date = typeof input === 'string' ? new Date(input) : input
  if (isNaN(date.getTime())) return ''
  const p = getParts(date, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`
}

/** Agora em SP no formato de <input type="datetime-local"> ("YYYY-MM-DDTHH:mm"). */
export function nowSPDatetimeLocal(): string {
  return spDatetimeLocal(new Date())
}

/**
 * Meia-noite em São Paulo da data "YYYY-MM-DD", como instante ISO.
 *
 * Espelho de crm_day_start() no banco (037). É o que permite filtrar
 * created_at por data de calendário direto no PostgREST, com o mesmo
 * resultado das RPCs — sem isto, "hoje" no cliente seria as últimas 24h.
 */
export function spDayStartISO(day: string): string {
  return spWallTimeToUtcISO(`${day}T00:00`)
}

/**
 * Soma dias a "YYYY-MM-DD" fazendo a conta em UTC. Com o fuso local do
 * navegador, um dia de 23h ou 25h moveria a data para o vizinho.
 */
export function addDaysISO(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
