/**
 * dbError — o erro do PostgREST vira um Error de verdade.
 *
 * O supabase-js NÃO devolve uma instância de Error quando a chamada falha: o
 * `error` de `{ data, error }` é o corpo JSON do PostgREST cru, um objeto
 * simples com message, details, hint e code (`JSON.parse(body)`, sem classe).
 *
 * Isso quebra o padrão de catch usado no projeto inteiro:
 *
 *     const msg = err instanceof Error ? err.message : 'Falha ao salvar'
 *
 * Com o objeto cru, `instanceof Error` é falso, a tela mostra sempre o texto
 * genérico e a mensagem do banco — a que diz QUAL índice único barrou a
 * gravação — some no caminho. Era por isso que trocar o canal de um contato
 * que já tem cadastro naquele canal só dizia "Falha ao salvar", com o 409
 * visível apenas no console.
 *
 * Envolver no throw devolve essa mensagem para a tela sem mudar mais nada:
 * code, details e hint continuam pendurados no erro para quem quiser olhar.
 */

export interface DbError extends Error {
  /** SQLSTATE do Postgres (23505 = índice único) ou código PGRST*. */
  code?: string
  details?: string | null
  hint?: string | null
}

export function asError(e: unknown, fallback = 'Falha ao falar com o banco'): DbError {
  if (e instanceof Error) return e as DbError

  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>
    const message = typeof o.message === 'string' && o.message.trim() ? o.message : fallback
    const err = new Error(message) as DbError
    if (typeof o.code === 'string') err.code = o.code
    if (typeof o.details === 'string') err.details = o.details
    if (typeof o.hint === 'string') err.hint = o.hint
    return err
  }

  return new Error(typeof e === 'string' && e.trim() ? e : fallback)
}
