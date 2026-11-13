// ============================================================
// api.infusesoftware.com → backend do CRM
//
// 1. /m/<chave>  — mídias do atendimento, no bucket R2 (binding MIDIAS).
//    Só com link assinado pelo servidor do CRM (HMAC com MEDIA_SIGNING_KEY,
//    o mesmo segredo das funções — _shared/media.ts) e dentro da validade.
//    GET/HEAD lê (com Range, para o vídeo poder pular), PUT grava.
//
// 2. Todo o resto — proxy transparente para o projeto do backend: login,
//    banco, funções, arquivos e o tempo real (WebSocket). Dos retornos saem
//    os cabeçalhos que identificam o fornecedor.
//
// Assim o navegador só enxerga o domínio da Infuse, e as mídias abrem em
// qualquer rede que abra o próprio sistema.
//
// Publicado como Worker "infuse-api" com domínio próprio (ver README).
// ============================================================

const UPSTREAM = 'https://ywdctgawnfaheeeazzgb.supabase.co'

/** Cabeçalhos de resposta que não passam para o navegador. */
const OCULTAR = [/^sb-/i, /^x-sb-/i, /^x-served-by$/i, /^set-cookie$/i, /^x-envoy-/i]

/** Tamanho máximo de uma mídia (o mesmo limite do painel). */
const MAX_BYTES = 100 * 1024 * 1024

const CORS_MIDIA = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, range',
  'Access-Control-Expose-Headers': 'content-length, content-range, etag',
  'Access-Control-Max-Age': '3600',
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/m/')) return midia(request, env, url)
    return proxy(request, url)
  },
}

// ---------------------------------------------------------------------------
// Proxy do backend
// ---------------------------------------------------------------------------

async function proxy(request, url) {
  const headers = new Headers(request.headers)
  const ip = request.headers.get('cf-connecting-ip')
  if (ip) headers.set('x-forwarded-for', ip)

  const res = await fetch(UPSTREAM + url.pathname + url.search, {
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
}

// ---------------------------------------------------------------------------
// Mídias (R2)
// ---------------------------------------------------------------------------

const enc = new TextEncoder()

function b64url(buf) {
  let s = ''
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function assinatura(segredo, texto) {
  const chave = await crypto.subtle.importKey('raw', enc.encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64url(await crypto.subtle.sign('HMAC', chave, enc.encode(texto)))
}

function iguais(a, b) {
  const x = enc.encode(a)
  const y = enc.encode(b)
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y)
}

/** Content-Disposition de download com nome acentuado (RFC 6266/5987). */
function anexo(nome) {
  const ascii = nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nome)}`
}

const negar = (status, texto) => new Response(texto, { status, headers: CORS_MIDIA })

async function midia(request, env, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_MIDIA })
  if (!env.MIDIAS || !env.MEDIA_SIGNING_KEY) return negar(503, 'armazenamento indisponível')

  let chave
  try {
    chave = url.pathname.slice(3).split('/').map(decodeURIComponent).join('/')
  } catch {
    return negar(400, 'caminho inválido')
  }
  const exp = Number(url.searchParams.get('e'))
  const sig = url.searchParams.get('s') ?? ''
  const nome = url.searchParams.get('d') ?? ''
  const metodo = request.method === 'HEAD' ? 'GET' : request.method

  if (!chave || chave.includes('..')) return negar(400, 'caminho inválido')
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return negar(403, 'link expirado')
  const esperada = await assinatura(env.MEDIA_SIGNING_KEY, `${metodo}\n${chave}\n${exp}\n${nome}`)
  if (!iguais(esperada, sig)) return negar(403, 'link inválido')

  if (metodo === 'PUT') {
    const tamanho = Number(request.headers.get('content-length') ?? 'NaN')
    if (!Number.isFinite(tamanho)) return negar(411, 'tamanho do arquivo ausente')
    if (tamanho > MAX_BYTES) return negar(413, 'arquivo maior que 100 MB')
    await env.MIDIAS.put(chave, request.body, {
      httpMetadata: { contentType: request.headers.get('content-type') || 'application/octet-stream' },
    })
    return new Response(null, { status: 200, headers: CORS_MIDIA })
  }

  if (metodo !== 'GET') return negar(405, 'método não permitido')

  // Range só quando o navegador pediu um trecho (o vídeo, ao pular).
  const pediuTrecho = request.headers.has('range')
  const obj = await env.MIDIAS.get(chave, { range: pediuTrecho ? request.headers : undefined, onlyIf: request.headers })
  if (!obj) return negar(404, 'arquivo não encontrado')

  const h = new Headers(CORS_MIDIA)
  obj.writeHttpMetadata(h)
  h.set('etag', obj.httpEtag)
  h.set('accept-ranges', 'bytes')
  h.set('cache-control', 'private, max-age=3600')
  if (nome) h.set('content-disposition', anexo(nome))

  // onlyIf (If-None-Match etc.) não bateu: o navegador já tem o arquivo.
  if (!('body' in obj)) return new Response(null, { status: 304, headers: h })

  const corpo = request.method === 'HEAD' ? null : obj.body
  if (pediuTrecho && obj.range) {
    const r = obj.range
    const inicio = 'suffix' in r ? obj.size - r.suffix : (r.offset ?? 0)
    const qtd = 'suffix' in r ? r.suffix : (r.length ?? obj.size - inicio)
    h.set('content-range', `bytes ${inicio}-${inicio + qtd - 1}/${obj.size}`)
    h.set('content-length', String(qtd))
    return new Response(corpo, { status: 206, headers: h })
  }
  h.set('content-length', String(obj.size))
  return new Response(corpo, { status: 200, headers: h })
}
