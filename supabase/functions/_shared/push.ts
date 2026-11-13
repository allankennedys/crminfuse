/**
 * Notificação push (Web Push, VAPID). Mantém só a lógica de envio; quem
 * decide QUANDO avisar é o wa-webhook (mensagem nova) e a função push
 * (lembretes vencidos).
 *
 * Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (URL ou mailto).
 * Sem eles, nada é enviado e nada quebra.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY') ?? ''
const PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') ?? ''
const SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? ''

export const pushConfigurado = Boolean(PUBLIC_KEY && PRIVATE_KEY && SUBJECT)
export const chavePublicaPush = PUBLIC_KEY

if (pushConfigurado) webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY)

export interface AvisoPush {
  title: string
  body: string
  /** Mesma tag = o aviso novo substitui o anterior (um por conversa). */
  tag: string
  /** Conversa a abrir ao tocar no aviso. */
  conversationId?: string
}

/** Manda o aviso a todos os aparelhos dos usuários. Aparelho que não existe mais é apagado. */
export async function enviarPush(admin: SupabaseClient, userIds: string[], aviso: AvisoPush): Promise<number> {
  if (!pushConfigurado || userIds.length === 0) return 0
  const { data: subs } = await admin
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .in('user_id', userIds)
  let enviados = 0
  const payload = JSON.stringify(aviso)
  await Promise.all((subs ?? []).map(async (s: { id: string; endpoint: string; p256dh: string; auth: string }) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 60 * 60, urgency: 'high' },
      )
      enviados++
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      // 404/410: o navegador cancelou a inscrição. Não adianta insistir.
      if (status === 404 || status === 410) await admin.from('push_subscriptions').delete().eq('id', s.id)
      else console.error('[push]', status ?? '', err instanceof Error ? err.message : err)
    }
  }))
  return enviados
}

const TIPO_TEXTO: Record<string, string> = {
  image: '📷 Foto', video: '🎥 Vídeo', audio: '🎤 Áudio', document: '📄 Documento',
  sticker: 'Figurinha', location: '📍 Localização', contact: '👤 Contato',
}

/** Mensagem nova de cliente: avisa quem atende (ou quem vê a Fila). */
export async function avisarMensagemNova(admin: SupabaseClient, conversationId: string): Promise<void> {
  if (!pushConfigurado) return
  const { data: conv } = await admin
    .from('wa_conversations')
    .select('id, push_name, phone, last_message_preview, crm_contacts(name)')
    .eq('id', conversationId)
    .maybeSingle()
  if (!conv) return

  const { data: rec } = await admin.rpc('wa_push_recipients', { p_conversation: conversationId })
  const ids = ((rec ?? []) as Array<{ user_id: string }>).map((r) => r.user_id)
  if (ids.length === 0) return

  // deno-lint-ignore no-explicit-any
  const nome = (conv as any).crm_contacts?.name || conv.push_name || conv.phone || 'Cliente'
  const preview = String(conv.last_message_preview ?? '').trim()
  await enviarPush(admin, ids, {
    title: String(nome),
    body: preview || TIPO_TEXTO.text || 'Nova mensagem',
    tag: `conv-${conversationId}`,
    conversationId,
  })
}
