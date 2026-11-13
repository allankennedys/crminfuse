// ============================================================
// api.infusesoftware.com → backend do CRM
//
// Proxy transparente: tudo o que o painel pede (login, banco, funções,
// arquivos e o tempo real via WebSocket) entra por aqui e é repassado ao
// projeto do backend. Assim o navegador só enxerga o domínio da Infuse.
// Dos retornos saem os cabeçalhos que identificam o fornecedor.
//
// Publicado como Worker "infuse-api" com domínio próprio (ver README).
// ============================================================

const UPSTREAM = 'https://ywdctgawnfaheeeazzgb.supabase.co'

/** Cabeçalhos de resposta que não passam para o navegador. */
const OCULTAR = [/^sb-/i, /^x-sb-/i, /^x-served-by$/i, /^set-cookie$/i, /^x-envoy-/i]

export default {
  async fetch(request) {
    const url = new URL(request.url)
    const alvo = UPSTREAM + url.pathname + url.search

    const headers = new Headers(request.headers)
    const ip = request.headers.get('cf-connecting-ip')
    if (ip) headers.set('x-forwarded-for', ip)

    const res = await fetch(alvo, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    })

    // WebSocket (tempo real): devolve a conexão como veio.
    if (res.status === 101) return res

    const out = new Headers(res.headers)
    for (const k of [...out.keys()]) if (OCULTAR.some((r) => r.test(k))) out.delete(k)
    const loc = out.get('location')
    if (loc && loc.startsWith(UPSTREAM)) out.set('location', url.origin + loc.slice(UPSTREAM.length))

    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
  },
}
