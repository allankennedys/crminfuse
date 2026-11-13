// ============================================================
// Onde ficam as mídias do atendimento.
//
// Com os secrets do R2 configurados (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY, R2_BUCKET), arquivo novo vai para o Cloudflare R2 —
// 10 GB grátis e sem cobrança de tráfego. Sem eles, vai para o Storage do
// Supabase (bucket wa-media), como sempre foi.
//
// O media_path no banco diz onde cada um está: "r2:org/conversa/arquivo"
// é do R2; sem prefixo, é do Supabase. Os dois convivem — arquivo antigo
// continua abrindo de onde foi gravado.
//
// Nada daqui é público: quem lê recebe um link temporário assinado, gerado
// só depois de a permissão ser conferida (wa-chat, ação media_urls).
// ============================================================

import { AwsClient } from 'npm:aws4fetch@1.0.20'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

export const BUCKET = 'wa-media'
const R2_PREFIX = 'r2:'

const ACCOUNT = Deno.env.get('R2_ACCOUNT_ID') ?? ''
const KEY_ID = Deno.env.get('R2_ACCESS_KEY_ID') ?? ''
const SECRET = Deno.env.get('R2_SECRET_ACCESS_KEY') ?? ''
const R2_BUCKET = Deno.env.get('R2_BUCKET') ?? ''

export const r2Enabled = Boolean(ACCOUNT && KEY_ID && SECRET && R2_BUCKET)

const r2 = r2Enabled
  ? new AwsClient({ accessKeyId: KEY_ID, secretAccessKey: SECRET, service: 's3', region: 'auto' })
  : null

/** URL do objeto (estilo caminho: conta.r2.cloudflarestorage.com/bucket/chave). */
function objectUrl(key: string): URL {
  const chave = key.split('/').map(encodeURIComponent).join('/')
  return new URL(`https://${ACCOUNT}.r2.cloudflarestorage.com/${encodeURIComponent(R2_BUCKET)}/${chave}`)
}

export const isR2 = (path: string) => path.startsWith(R2_PREFIX)
/** Caminho sem o prefixo do lugar: "org/conversa/arquivo". */
export const keyOf = (path: string) => (isR2(path) ? path.slice(R2_PREFIX.length) : path)

/** Content-Disposition de download com nome acentuado (RFC 6266/5987). */
function attachment(name: string): string {
  const ascii = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

async function presign(method: 'GET' | 'PUT', key: string, seconds: number, extra?: Record<string, string>) {
  const url = objectUrl(key)
  url.searchParams.set('X-Amz-Expires', String(seconds))
  for (const [k, v] of Object.entries(extra ?? {})) url.searchParams.set(k, v)
  const signed = await r2!.sign(new Request(url, { method }), { aws: { signQuery: true } })
  return signed.url
}

/**
 * Grava o arquivo e devolve o media_path para o banco. Vai para o R2 quando
 * ele está configurado; senão, para o Storage do Supabase.
 */
export async function putMedia(
  admin: SupabaseClient,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  if (r2) {
    const res = await r2.fetch(objectUrl(key).toString(), {
      method: 'PUT',
      body: bytes as unknown as BodyInit,
      headers: { 'Content-Type': contentType },
    })
    if (!res.ok) throw new Error(`R2 recusou o arquivo (${res.status}): ${(await res.text()).slice(0, 200)}`)
    return R2_PREFIX + key
  }
  const { error } = await admin.storage.from(BUCKET).upload(key, bytes, { contentType, upsert: true })
  if (error) throw error
  return key
}

/** Link temporário de leitura. null = arquivo inacessível (ex.: está no R2 e os secrets dele foram removidos). */
export async function mediaUrl(admin: SupabaseClient, path: string, seconds: number): Promise<string | null> {
  if (isR2(path)) return r2 ? presign('GET', keyOf(path), seconds) : null
  const { data } = await admin.storage.from(BUCKET).createSignedUrl(path, seconds)
  return data?.signedUrl ?? null
}

/** Os dois links de uma mídia: abrir e baixar (com o nome do arquivo). */
export async function mediaLinks(
  admin: SupabaseClient,
  path: string,
  seconds: number,
  downloadName: string,
): Promise<{ url: string; download: string } | null> {
  if (isR2(path)) {
    if (!r2) return null
    const [url, download] = await Promise.all([
      presign('GET', keyOf(path), seconds),
      presign('GET', keyOf(path), seconds, { 'response-content-disposition': attachment(downloadName) }),
    ])
    return { url, download }
  }
  const url = await mediaUrl(admin, path, seconds)
  // O Storage do Supabase aceita &download=nome no próprio link assinado.
  return url ? { url, download: `${url}&download=${encodeURIComponent(downloadName)}` } : null
}

/**
 * Para onde o navegador sobe um arquivo da equipe. No R2, devolve um link de
 * envio (PUT) válido por 10 min; no Supabase, só o caminho — o navegador sobe
 * pelo próprio supabase-js, com as regras do bucket.
 */
export async function uploadTarget(key: string): Promise<
  { store: 'r2'; path: string; url: string } | { store: 'supabase'; path: string }
> {
  if (!r2) return { store: 'supabase', path: key }
  return { store: 'r2', path: R2_PREFIX + key, url: await presign('PUT', key, 600) }
}
