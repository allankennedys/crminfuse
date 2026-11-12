import { SP_TZ } from '@/lib/datetime'

const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: SP_TZ }) // AAAA-MM-DD

function isSameSPDay(a: Date, b: Date) {
  return dayKey(a) === dayKey(b)
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { timeZone: SP_TZ, hour: '2-digit', minute: '2-digit' })
}

/** Hora se for hoje, "Ontem", ou a data — como na lista do WhatsApp. */
export function formatListTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  if (isSameSPDay(d, now)) return formatTime(iso)
  const ontem = new Date(now.getTime() - 86_400_000)
  if (isSameSPDay(d, ontem)) return 'Ontem'
  return d.toLocaleDateString('pt-BR', { timeZone: SP_TZ, day: '2-digit', month: '2-digit', year: '2-digit' })
}

/** Separador de dia dentro da conversa. */
export function formatDayLabel(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  if (isSameSPDay(d, now)) return 'Hoje'
  if (isSameSPDay(d, new Date(now.getTime() - 86_400_000))) return 'Ontem'
  return d.toLocaleDateString('pt-BR', { timeZone: SP_TZ, day: '2-digit', month: 'long', year: 'numeric' })
}

export function sameDay(a: string, b: string): boolean {
  return isSameSPDay(new Date(a), new Date(b))
}

export function initials(name: string): string {
  const letters = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!letters.length) return '#'
  const first = letters[0][0] ?? ''
  const last = letters.length > 1 ? letters[letters.length - 1][0] ?? '' : ''
  return (first + last).toUpperCase()
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
