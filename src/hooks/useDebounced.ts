import { useEffect, useState } from 'react'

/**
 * Debounce de um valor — tipicamente o texto de uma busca, para não disparar
 * uma consulta por tecla digitada.
 *
 * Estava duplicado dentro da tabela de contatos; virou hook quando o
 * relatório de leads sem origem passou a buscar no servidor também.
 */
export function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])

  return debounced
}
