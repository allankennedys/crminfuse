/*
 * Service worker do Infuse CRM: deixa o app instalável e abre uma tela de
 * "sem conexão" quando a rede cai. Não guarda dados do sistema: nada de
 * Supabase, API, mídias ou conversas em cache. É de propósito: o atendimento
 * mostra informação ao vivo, e um cache velho mostraria conversa errada.
 *
 * - Páginas (navegação): sempre da rede; sem rede, a tela offline.
 * - /assets/* (arquivos com hash no nome, que nunca mudam): cache primeiro.
 * - Todo o resto (outros domínios, API, WebSocket): passa direto.
 *
 * Mudou este arquivo? Troque VERSAO: o cache antigo é apagado ao ativar.
 */
const VERSAO = 'v2'
const CACHE = `infuse-${VERSAO}`
const OFFLINE = '/offline.html'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, '/icon-192.png'])))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('infuse-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE)))
    return
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(req)
        if (hit) return hit
        const res = await fetch(req)
        if (res.ok) cache.put(req, res.clone())
        return res
      }),
    )
  }
})

/*
 * Notificação push: o servidor manda { title, body, tag, conversationId }.
 * Se o app já está aberto e à vista, não mostra (o próprio app avisa); fechado,
 * em segundo plano ou com a tela bloqueada, mostra. A mesma tag substitui o
 * aviso anterior da mesma conversa, então não empilha.
 */
self.addEventListener('push', (event) => {
  let d = {}
  try { d = event.data ? event.data.json() : {} } catch { d = { title: 'Infuse', body: event.data ? event.data.text() : '' } }

  event.waitUntil((async () => {
    const abertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (abertas.some((c) => c.visibilityState === 'visible' && c.focused)) return
    await self.registration.showNotification(d.title || 'Infuse', {
      body: d.body || '',
      tag: d.tag || undefined,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { conversationId: d.conversationId || null },
    })
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const id = event.notification.data && event.notification.data.conversationId
  event.waitUntil((async () => {
    const abertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (abertas.length > 0) {
      const c = abertas[0]
      await c.focus()
      if (id) c.postMessage({ type: 'abrir-conversa', id })
      return
    }
    await self.clients.openWindow(id ? `/?conversa=${encodeURIComponent(id)}` : '/')
  })())
})
