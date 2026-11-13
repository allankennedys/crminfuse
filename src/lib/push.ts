import { supabase, FunctionRegion } from '@/lib/supabase'

/** O navegador sabe receber push? (iPhone: só com o app instalado na tela inicial.) */
export function pushSuportado(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

function chaveParaBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4)
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function registro(): Promise<ServiceWorkerRegistration | null> {
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.ready)
  } catch {
    return null
  }
}

/** Este aparelho já está inscrito? */
export async function pushAtivo(): Promise<boolean> {
  if (!pushSuportado() || Notification.permission !== 'granted') return false
  const reg = await registro()
  return Boolean(reg && (await reg.pushManager.getSubscription()))
}

/** Pede a permissão, inscreve o aparelho e guarda a inscrição. Devolve o motivo se falhar. */
export async function ativarPush(userId: string, organizationId: string): Promise<{ ok: true } | { ok: false; motivo: string }> {
  if (!pushSuportado()) {
    return { ok: false, motivo: 'Este navegador não recebe notificação com o app fechado. No iPhone, instale o app na tela inicial primeiro.' }
  }
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (perm !== 'granted') return { ok: false, motivo: 'A notificação está bloqueada. Libere nas permissões do navegador.' }

  const reg = await registro()
  if (!reg) return { ok: false, motivo: 'O app ainda não está pronto para notificações. Recarregue a página e tente de novo.' }

  const { data, error } = await supabase.functions.invoke('push', { body: { action: 'public_key' }, region: FunctionRegion.EuWest3 })
  if (error || !data?.key) return { ok: false, motivo: 'As notificações ainda não foram configuradas no servidor.' }

  try {
    const sub = (await reg.pushManager.getSubscription())
      ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveParaBytes(data.key) }))
    const j = sub.toJSON()
    if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) return { ok: false, motivo: 'O navegador devolveu uma inscrição inválida.' }
    const { error: e2 } = await supabase.from('push_subscriptions').upsert({
      user_id: userId,
      organization_id: organizationId,
      endpoint: j.endpoint,
      p256dh: j.keys.p256dh,
      auth: j.keys.auth,
      user_agent: navigator.userAgent.slice(0, 200),
    }, { onConflict: 'endpoint' })
    if (e2) return { ok: false, motivo: 'Não consegui salvar a inscrição. Tente de novo.' }
    return { ok: true }
  } catch {
    return { ok: false, motivo: 'Não foi possível ativar as notificações neste aparelho.' }
  }
}

/** Cancela neste aparelho. */
export async function desativarPush(): Promise<void> {
  const reg = await registro()
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return
  await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
  await sub.unsubscribe().catch(() => {})
}
