import { crmService } from '@/services/crmService'
import { toast } from '@/store/toastStore'

/**
 * Aviso da venda aos sistemas externos (n8n), compartilhado pelos dois
 * formulários que lançam venda à mão: o drawer de "Lançar venda" e o painel
 * do contato.
 *
 * Vive aqui, e não no crmService, porque a parte difícil não é a chamada — é
 * o que a tela faz com o silêncio dela. O serviço fica com o RPC; este módulo
 * fica com os avisos ao usuário.
 *
 * NUNCA É CHAMADO POR AUTOMAÇÃO. Venda que entra pela crm-api (n8n) ou por
 * trigger não passa por aqui, e a própria RPC recusa quem não é usuário
 * logado do painel — a organização dela sai de auth.uid().
 */

/**
 * Confere o resultado do POST alguns segundos depois de a venda ser salva.
 *
 * O pg_net entrega em background: a RPC devolve na hora o id da requisição,
 * não a resposta. Sem esta segunda olhada, um webhook fora do ar seria
 * silêncio absoluto — a venda gravada e ninguém sabendo que o n8n não soube.
 *
 * Só reclama do que é falha DE VERDADE: resposta ainda em voo não vira aviso,
 * senão todo lançamento terminaria com um alerta que não quer dizer nada.
 * Roda solto, fora do React: a tela pode já ter fechado quando isto dispara.
 */
function conferirDepois(requestId: number) {
  window.setTimeout(() => {
    crmService.saleWebhookStatus(requestId)
      .then((r) => {
        if (!r) return
        if (r.timed_out) {
          toast.error('Venda registrada, mas o sistema integrado não respondeu a tempo.')
          return
        }
        const code = r.status_code
        if (code == null || code < 200 || code >= 300) {
          toast.error(
            `Venda registrada, mas o sistema integrado recusou o aviso (${code ?? r.error_msg ?? 'sem resposta'}).`,
          )
        }
      })
      .catch(() => { /* consultar o status não pode virar erro na tela */ })
  }, 4000)
}

/**
 * Avisa os sistemas externos de uma venda recém-lançada.
 *
 * Não propaga erro de propósito: a venda já está gravada quando isto roda, e
 * uma falha de integração não pode parecer falha de registro. O que der
 * errado vira aviso na tela, não exceção no fluxo de quem chamou.
 */
export async function avisarSistemasExternos(
  saleId: string,
  opts: { newContact?: boolean } = {},
): Promise<void> {
  try {
    const requestId = await crmService.notifySaleWebhook(saleId, opts)
    if (requestId != null) conferirDepois(requestId)
  } catch (err) {
    toast.error(
      `Venda registrada, mas o aviso aos outros sistemas falhou: ${
        err instanceof Error ? err.message : 'erro desconhecido'
      }`,
    )
  }
}
