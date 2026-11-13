import { useEffect, useState } from 'react'
import { Modal } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/store/authStore'
import { toast } from '@/store/toastStore'
import { atendimentoService } from '@/services/atendimentoService'
import { isAdContact } from '@/services/crmService'
import { SaleForm } from './ClientPanel'
import type { CrmContact } from '@/types'

/**
 * Lançar venda para quem NÃO tem acesso às vendas do CRM (ex.: Atendente com
 * "Mover no funil"). Arrastar um contato para a etapa de conversão abre este
 * popup; a venda é lançada pela conversa dele (a mesma porta do painel do
 * cliente, que confere se a conversa é de quem lança), e é ela que leva o
 * cartão para a conversão.
 */
export function LancarVendaDoContato({ contact, onClose, onSaved }: {
  contact: CrmContact
  onClose: () => void
  onSaved: () => void
}) {
  const userId = useAuthStore((s) => s.profile?.id ?? '')
  const [conversationId, setConversationId] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    supabase
      .from('wa_conversations')
      .select('id')
      .eq('contact_id', contact.id)
      .eq('assigned_to', userId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .then(({ data }) => setConversationId(data?.[0]?.id ?? null))
  }, [contact.id, userId])

  return (
    <Modal title={`Lançar venda: ${contact.name}`} onClose={onClose} variant="dialog">
      {conversationId === undefined ? (
        <div className="spinner" />
      ) : conversationId === null ? (
        <p className="text-secondary">
          Este contato não tem uma conversa atribuída a você, então não dá para lançar a venda por aqui.
        </p>
      ) : (
        <>
          <p className="text-muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
            Para marcar como convertido é preciso registrar a venda. Preencha os dados abaixo.
          </p>
          <SaleForm
            fromAd={isAdContact(contact, contact.origem)}
            onCancel={onClose}
            onSave={async (s) => {
              const r = await atendimentoService.launchSale(conversationId, s)
              toast.success(r.from_ad
                ? 'Venda lançada. A conversão vai para a Meta, atribuída ao anúncio.'
                : 'Venda lançada.')
              onSaved()
              onClose()
            }}
          />
        </>
      )}
    </Modal>
  )
}
