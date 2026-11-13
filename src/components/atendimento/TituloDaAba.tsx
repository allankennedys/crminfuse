import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore, useCan } from '@/store/authStore'

const PADRAO = 'CRM Infuse'

/**
 * Título da aba do navegador: "Nome da organização - CRM Infuse", com o
 * número de conversas não lidas atribuídas a esta pessoa na frente: "(5) Nome
 * - CRM Infuse". Conta conversas, não mensagens: cinco conversas com várias
 * mensagens cada continuam sendo (5). Zera sozinho quando ela abre a conversa
 * e a marca como lida.
 */
export function TituloDaAba() {
  const orgName = useAuthStore((s) => s.organizationName)
  const userId = useAuthStore((s) => s.profile?.id ?? '')
  const can = useCan()
  const atende = can('atendimento.ver')
  const [naoLidas, setNaoLidas] = useState(0)

  useEffect(() => {
    if (!atende || !userId) { setNaoLidas(0); return }
    let vivo = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const conta = async () => {
      const { count, error } = await supabase
        .from('wa_conversations')
        .select('id', { count: 'exact', head: true })
        .eq('assigned_to', userId)
        .gt('unread_count', 0)
      if (vivo && !error) setNaoLidas(count ?? 0)
    }
    const agenda = () => { clearTimeout(timer); timer = setTimeout(conta, 600) }

    void conta()
    // A RLS vale no Realtime: só chegam as conversas que a pessoa enxerga.
    const channel = supabase
      .channel(`titulo-aba:${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wa_conversations' }, agenda)
      .subscribe()
    const intervalo = setInterval(conta, 60_000)
    window.addEventListener('focus', agenda)
    return () => {
      vivo = false
      clearTimeout(timer)
      clearInterval(intervalo)
      window.removeEventListener('focus', agenda)
      void supabase.removeChannel(channel)
    }
  }, [atende, userId])

  const base = orgName ? `${orgName} - ${PADRAO}` : PADRAO
  useEffect(() => {
    document.title = naoLidas > 0 ? `(${naoLidas}) ${base}` : base
  }, [naoLidas, base])

  // Saiu do sistema (ou desmontou): volta ao título neutro.
  useEffect(() => () => { document.title = PADRAO }, [])

  return null
}
