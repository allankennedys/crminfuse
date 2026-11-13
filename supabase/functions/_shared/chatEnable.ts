/**
 * Liga o número no atendimento sozinho (webhook da Evolution apontando para a
 * wa-webhook + chat_enabled), sem o usuário precisar ligar à mão.
 *
 * Regra de segurança: se a instância já tem um webhook de OUTRO sistema (n8n,
 * bot…), não mexe. A Evolution tem UM webhook por instância, e trocá-lo
 * derrubaria o que já funciona; esse caso continua manual, com o aviso da tela.
 * Número recém-criado aqui nunca tem webhook de ninguém.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

export const WEBHOOK_EVENTS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'SEND_MESSAGE', 'CONNECTION_UPDATE']

// deno-lint-ignore no-explicit-any
type Json = any
type Evo = (method: string, path: string, body?: unknown) => Promise<{ ok: boolean; status: number; data: Json }>

export async function autoEnableChat(
  admin: SupabaseClient,
  evo: Evo,
  session: { id: string; instance_name: string; chat_enabled?: boolean; chat_manual_off?: boolean },
): Promise<'enabled' | 'already' | 'foreign' | 'error'> {
  try {
    if (session.chat_enabled) return 'already'
    // Quem desligou à mão não quer o número no atendimento: respeita.
    if (session.chat_manual_off) return 'foreign'
    const base = `${Deno.env.get('SUPABASE_URL')!.replace(/\/+$/, '')}/functions/v1/wa-webhook`
    const instance = encodeURIComponent(session.instance_name)

    const { data: existing } = await admin
      .from('wa_session_secrets')
      .select('webhook_token')
      .eq('session_id', session.id)
      .maybeSingle()

    const cur = await evo('GET', `/webhook/find/${instance}`)
    const url = cur.ok && cur.data && typeof cur.data === 'object' && typeof cur.data.url === 'string' ? cur.data.url : ''
    if (url && !url.startsWith(base)) return 'foreign'

    const token = existing?.webhook_token ?? `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '')
    if (!existing) {
      const { error } = await admin.from('wa_session_secrets').insert({
        session_id: session.id, webhook_token: token, previous_webhook: null,
      })
      if (error) return 'error'
    }

    const res = await evo('POST', `/webhook/set/${instance}`, {
      webhook: { enabled: true, url: `${base}?s=${token}`, byEvents: false, base64: true, events: WEBHOOK_EVENTS },
    })
    if (!res.ok) {
      if (!existing) await admin.from('wa_session_secrets').delete().eq('session_id', session.id)
      return 'error'
    }

    const { error } = await admin.from('whatsapp_sessions').update({ chat_enabled: true }).eq('id', session.id)
    return error ? 'error' : 'enabled'
  } catch (err) {
    console.error('[autoEnableChat]', err instanceof Error ? err.message : err)
    return 'error'
  }
}
