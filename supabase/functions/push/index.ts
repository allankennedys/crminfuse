/**
 * Edge Function: push
 *
 *   { action: 'public_key' }  → { key }   chave pública VAPID, para o navegador se inscrever
 *   { action: 'tasks' }       → { sent }  avisa os lembretes vencidos (chamada por cron;
 *                                         exige o cabeçalho x-push-secret)
 *
 * Sem JWT (verify_jwt = false): a chave pública é pública, e o job do banco
 * não tem usuário. O que escreve é só 'tasks', protegida pelo segredo.
 *
 * Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_SECRET.
 */
import { createClient } from 'npm:@supabase/supabase-js@2'
import { chavePublicaPush, enviarPush, pushConfigurado } from '../_shared/push.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region, x-push-secret',
}

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

/** Comparação em tempo constante do segredo. */
function igual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? '')

  if (action === 'public_key') {
    if (!pushConfigurado) return json({ error: 'Notificação push não configurada' }, 503)
    return json({ key: chavePublicaPush })
  }

  if (action === 'tasks') {
    const segredo = Deno.env.get('PUSH_SECRET') ?? ''
    if (!segredo || !igual(req.headers.get('x-push-secret') ?? '', segredo)) return json({ error: 'Não autorizado' }, 401)
    if (!pushConfigurado) return json({ sent: 0 })

    // Reserva os lembretes antes de enviar: dois ciclos seguidos não avisam duas vezes.
    const { data: due } = await admin
      .from('wa_tasks')
      .update({ push_notified_at: new Date().toISOString() })
      .is('done_at', null)
      .is('push_notified_at', null)
      .lte('due_at', new Date().toISOString())
      .select('id, assigned_to, title, conversation_id')
      .limit(200)

    let sent = 0
    for (const t of due ?? []) {
      sent += await enviarPush(admin, [t.assigned_to], {
        title: 'Lembrete',
        body: t.title,
        tag: `task-${t.id}`,
        conversationId: t.conversation_id,
      })
    }
    return json({ sent, tasks: (due ?? []).length })
  }

  return json({ error: 'Ação desconhecida' }, 400)
})
