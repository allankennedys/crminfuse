import { useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js'

/**
 * Linha devolvida pelo Realtime. O supabase-js exige um tipo indexável aqui,
 * mas as interfaces do projeto (CrmContact, CrmStage…) não têm index
 * signature — daí o `{ [k: string]: any }` como restrição mínima, que aceita
 * qualquer interface de linha sem afrouxar a tipagem de quem chama.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RealtimeRow = { [key: string]: any }

/**
 * Assina mudanças (INSERT/UPDATE/DELETE) de uma tabela via Supabase Realtime
 * e dispara o callback.
 *
 * O callback recebe o payload do Postgres — quem só precisa saber que "algo
 * mudou" pode declarar `() => void` e ignorá-lo (é o caso das páginas que
 * recarregam a lista inteira). Já telas com muitos dados, como o kanban do
 * CRM, usam `payload.new`/`payload.old` para aplicar a mudança no estado
 * local, sem refazer a consulta — é a diferença entre baixar uma linha e
 * baixar a tabela toda a cada evento.
 */
export function useRealtime<T extends RealtimeRow = RealtimeRow>(
  table: string,
  onChange: (payload: RealtimePostgresChangesPayload<T>) => void,
) {
  // Mantém o callback atual sem reassinar o canal a cada render — reassinar
  // derrubaria e recriaria o WebSocket sempre que o componente renderizasse.
  const handler = useRef(onChange)
  handler.current = onChange

  useEffect(() => {
    const channel = supabase
      .channel(`realtime:${table}`)
      .on<T>(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        (payload) => handler.current(payload),
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [table])
}
