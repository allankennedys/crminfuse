/**
 * metaAdsService — insights da conta de anúncios da Meta.
 *
 * Passa pela Edge Function `meta-ads` porque o token é secreto e não pode
 * chegar ao navegador. A função devolve os números já normalizados; aqui só
 * há o transporte e a tradução do erro.
 *
 * Erro esperado (conta não configurada, token sem ads_read, conta
 * desativada) volta da função com HTTP 200 e `ok: false` — de propósito,
 * para a mensagem da Meta chegar inteira à tela em vez de virar um 500
 * genérico. Por isso a única coisa que este arquivo trata como exceção é
 * falha de rede ou de autenticação do painel.
 */

import { supabase } from '@/lib/supabase'
import type { DateRange } from '@/services/crmService'
import type { MetaAdsInsights } from '@/types'

/**
 * Janela da consulta e, opcionalmente, a janela anterior de mesmo tamanho —
 * é dela que sai o badge de variação do investimento. Sem `previous`, a
 * função pula uma chamada à Meta (o caso do All-Time, que não tem anterior).
 */
export interface AdsInsightsQuery {
  range: DateRange
  previous?: DateRange | null
  /**
   * Quais contas consultar (act_XXXX). Vazio ou ausente = todas as
   * cadastradas, que é o padrão da tela: é só com todas que o gasto fecha
   * com a receita do CRM, que não se divide por conta.
   */
  accounts?: string[]
}

export const metaAdsService = {
  async insights({ range, previous, accounts }: AdsInsightsQuery): Promise<MetaAdsInsights> {
    // Inverte se vier de trás para frente, como rangeArgs do crmService: as
    // duas datas são escolhidas à mão no modo personalizado.
    const [from, to] = range.from <= range.to ? [range.from, range.to] : [range.to, range.from]

    const { data, error } = await supabase.functions.invoke('meta-ads', {
      body: {
        from,
        to,
        ...(previous ? { prevFrom: previous.from, prevTo: previous.to } : {}),
        ...(accounts?.length ? { accounts } : {}),
      },
    })

    if (error) {
      throw new Error(
        error instanceof Error && error.message
          ? error.message
          : 'Não foi possível falar com a Meta',
      )
    }

    return data as MetaAdsInsights
  },
}
