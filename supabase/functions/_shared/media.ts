// ============================================================
// Onde ficam as mídias do atendimento.
//
// Com MEDIA_SIGNING_KEY e PUBLIC_API_URL configurados, arquivo novo vai para
// o Cloudflare R2 — 10 GB grátis e sem cobrança de tráfego — ATRAVÉS do
// Worker do domínio da Infuse (cloudflare/api-proxy, rota /m/). Ninguém fala
// com o R2 direto: o Worker tem o bucket ligado a ele e só aceita links
// assinados aqui (HMAC com o MEDIA_SIGNING_KEY, que os dois conhecem).
// Vantagens: as mídias abrem em qualquer rede que abra o sistema (VPNs e
// filtros às vezes bloqueiam o endereço do R2) e as funções não guardam
// chave nenhuma do R2.
//
// Sem esses secrets, vai para o Storage do Supabase (bucket wa-media), como
// sempre foi.
//
// O media_path no banco diz onde cada um está: "r2:org/conversa/arquivo"
// é do R2; sem prefixo, é do Storage. Os dois convivem.
//
// Nada daqui é público: quem lê recebe um link temporário assinado, gerado
// só depois de a permissão ser conferida (wa-chat, ação media_urls).
// ============================================================

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

export const BUCKET = 'wa-media'
const R2_PREFIX = 'r2:'

const SIGNING_KEY = Deno.env.get('MEDIA_SIGNING_KEY') ?? ''
// Links que vão para o NAVEGADOR saem pelo domínio da Infuse (proxy
// api.infusesoftware.com), não pelo endereço interno do projeto.
const INTERNAL_URL = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '')
const PUBLIC_URL = (Deno.env.get('PUBLIC_API_URL') ?? '').replace(/\/+$/, '')

export const r2Enabled = Boolean(SIGNING_KEY && PUBLIC_URL)

const publico = (url: string) =>
  PUBLIC_URL && INTERNAL_URL && url.startsWith(INTERNAL_URL) ? PUBLIC_URL + url.slice(INTERNAL_URL.length) : url

export const isR2 = (path: string) => path.startsWith(R2_PREFIX)
/** Caminho sem o prefixo do lugar: "org/conversa/arquivo". */
export const keyOf = (path: string) => (isR2(path) ? path.slice(R2_PREFIX.length) : path)

// ---------------------------------------------------------------------------
// Links assinados para o Worker (/m/<chave>?e=<expira>&s=<assinatura>[&d=<nome>])
// ---------------------------------------------------------------------------

const enc = new TextEncoder()
let hmacKey: Promise<CryptoKey> | null = null

function b64url(buf: ArrayBuffer): string {
  let s = ''
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function assinar(texto: string): Promise<string> {
  hmacKey ??= crypto.subtle.importKey('raw', enc.encode(SIGNING_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64url(await crypto.subtle.sign('HMAC', await hmacKey, enc.encode(texto)))
}

/** O que o Worker confere: método, chave, validade e o nome do download. */
async function workerUrl(method: 'GET' | 'PUT', key: string, seconds: number, downloadName = ''): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + seconds
  const u = new URL(`${PUBLIC_URL}/m/${key.split('/').map(encodeURIComponent).join('/')}`)
  u.searchParams.set('e', String(exp))
  if (downloadName) u.searchParams.set('d', downloadName)
  u.searchParams.set('s', await assinar(`${method}\n${key}\n${exp}\n${downloadName}`))
  return u.toString()
}

// ---------------------------------------------------------------------------

/**
 * Grava o arquivo e devolve o media_path para o banco. Vai para o R2 (pelo
 * Worker) quando ele está configurado; senão, para o Storage do Supabase.
 */
export async function putMedia(
  admin: SupabaseClient,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  if (r2Enabled) {
    const res = await fetch(await workerUrl('PUT', key, 300), {
      method: 'PUT',
      body: bytes as unknown as BodyInit,
      headers: { 'Content-Type': contentType },
    })
    if (!res.ok) throw new Error(`Armazenamento recusou o arquivo (${res.status}): ${(await res.text()).slice(0, 200)}`)
    return R2_PREFIX + key
  }
  const { error } = await admin.storage.from(BUCKET).upload(key, bytes, { contentType, upsert: true })
  if (error) throw error
  return key
}

/**
 * Link temporário de leitura (também o que a Evolution usa para buscar o
 * anexo a enviar). null = arquivo inacessível (ex.: está no R2 e os secrets
 * foram removidos).
 */
export async function mediaUrl(admin: SupabaseClient, path: string, seconds: number): Promise<string | null> {
  if (isR2(path)) return r2Enabled ? workerUrl('GET', keyOf(path), seconds) : null
  const { data } = await admin.storage.from(BUCKET).createSignedUrl(path, seconds)
  return data?.signedUrl ?? null
}

/** Os dois links de uma mídia para o navegador: abrir e baixar (com o nome do arquivo). */
export async function mediaLinks(
  admin: SupabaseClient,
  path: string,
  seconds: number,
  downloadName: string,
): Promise<{ url: string; download: string } | null> {
  if (isR2(path)) {
    if (!r2Enabled) return null
    const key = keyOf(path)
    const [url, download] = await Promise.all([
      workerUrl('GET', key, seconds),
      workerUrl('GET', key, seconds, downloadName),
    ])
    return { url, download }
  }
  const interno = await mediaUrl(admin, path, seconds)
  if (!interno) return null
  const url = publico(interno)
  // O Storage do Supabase aceita &download=nome no próprio link assinado.
  return { url, download: `${url}&download=${encodeURIComponent(downloadName)}` }
}

/**
 * Para onde o navegador sobe um arquivo da equipe. No R2, devolve um link de
 * envio (PUT) válido por 10 min; no Supabase, só o caminho — o navegador sobe
 * pelo próprio supabase-js, com as regras do bucket.
 */
export async function uploadTarget(key: string): Promise<
  { store: 'r2'; path: string; url: string } | { store: 'supabase'; path: string }
> {
  if (!r2Enabled) return { store: 'supabase', path: key }
  return { store: 'r2', path: R2_PREFIX + key, url: await workerUrl('PUT', key, 600) }
}
