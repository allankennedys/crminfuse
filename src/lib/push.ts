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

/** Permissão do aparelho para notificações (ou que o navegador não suporta). */
export function pushPermissao(): NotificationPermission | 'unsupported' {
  return pushSuportado() ? Notification.permission : 'unsupported'
}

/** Este aparelho está recebendo? Permissão dada, inscrição no navegador E registro no banco. */
export async function pushAtivo(): Promise<boolean> {
  if (!pushSuportado() || Notification.permission !== 'granted') return false
  const reg = await registro()
  const sub = reg ? await reg.pushManager.getSubscription() : null
  if (!sub) return false
  const { count } = await supabase
    .from('push_subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('endpoint', sub.endpoint)
  return (count ?? 0) > 0
}

// ---------- Decisão do usuário, por aparelho ----------
// Guardada no navegador (cada aparelho decide por si) e por usuário (quem
// divide o aparelho não herda a resposta do outro).

export type DecisaoPush = 'sim' | 'nao'
const chaveDecisao = (userId: string) => `push-decisao:${userId}`

export function lerDecisaoPush(userId: string): DecisaoPush | null {
  try {
    const v = localStorage.getItem(chaveDecisao(userId))
    return v === 'sim' || v === 'nao' ? v : null
  } catch { return null }
}

export function gravarDecisaoPush(userId: string, d: DecisaoPush) {
  try { localStorage.setItem(chaveDecisao(userId), d) } catch { /* sem armazenamento: pergunta de novo */ }
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

/**
 * Para de receber neste aparelho: apaga SÓ o registro do banco, e o servidor
 * deixa de mandar. A permissão do aparelho e a inscrição do navegador ficam
 * como estão (não dá para o app revogar a permissão, e manter a inscrição
 * deixa religar sem pedir nada de novo).
 */
export async function desativarPush(): Promise<void> {
  const reg = await registro()
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return
  await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
}

// ---------- Instalação do app ----------

/** Aberto como app instalado (tela cheia), e não numa aba do navegador. */
export function emAppInstalado(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true
  } catch { return false }
}

export const ehIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/** Celular ou tablet de toque (não um computador com a janela estreita). */
export const ehCelular = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
