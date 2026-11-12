/**
 * Compressão de anexos no navegador, antes de subir para o storage (103).
 *
 * Imagem: redimensionada para no máximo MAX_SIDE no lado maior e regravada
 * em WebP (JPEG onde o navegador não grava WebP). GIF fica como está — a
 * conversão mataria a animação.
 *
 * PDF: o canvas não mexe em PDF, então vai em gzip (CompressionStream,
 * nativo). Quem abre descompacta com gunzipBlob. PDF já comprimido por
 * dentro rende pouco; se o gzip não economizar nada, sobe cru.
 *
 * Em qualquer caso, se o "comprimido" sair maior que o original, fica o
 * original.
 */

const MAX_SIDE = 2000
const QUALITY = 0.8

export const ACCEPTED_ATTACHMENT = 'application/pdf,.pdf,image/png,image/jpeg,image/webp,image/gif,image/bmp,image/heic,image/heif,image/avif,image/*'

export interface CompressedFile {
  /** O que vai para o bucket. */
  blob: Blob
  /** Content-Type gravado no bucket. */
  contentType: string
  /** Tipo do arquivo como o usuário vê. */
  mimeType: string
  /** Nome a gravar (troca a extensão quando a imagem vira WebP/JPEG). */
  name: string
  encoding: 'gzip' | null
  originalBytes: number
}

export function isAcceptedAttachment(file: File) {
  return file.type === 'application/pdf'
    || /\.pdf$/i.test(file.name)
    || file.type.startsWith('image/')
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, QUALITY))
}

async function compressImage(file: File): Promise<CompressedFile | null> {
  if (file.type === 'image/gif') return null
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    // Formato que o navegador não decodifica (HEIC fora do Safari): sobe cru.
    return null
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) { bitmap.close(); return null }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  // Safari devolve PNG quando não sabe gravar WebP — aí vai JPEG.
  let blob = await canvasToBlob(canvas, 'image/webp')
  if (!blob || blob.type !== 'image/webp') blob = await canvasToBlob(canvas, 'image/jpeg')
  canvas.width = canvas.height = 0
  if (!blob) return null
  const ext = blob.type === 'image/webp' ? 'webp' : 'jpg'
  return {
    blob,
    contentType: blob.type,
    mimeType: blob.type,
    name: file.name.replace(/\.[^.]+$/, '') + '.' + ext,
    encoding: null,
    originalBytes: file.size,
  }
}

async function gzip(file: Blob): Promise<Blob | null> {
  if (typeof CompressionStream === 'undefined') return null
  const stream = file.stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(stream).blob()
}

/** Desfaz o gzip de um anexo PDF para abrir no navegador. */
export async function gunzipBlob(blob: Blob, type: string): Promise<Blob> {
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'))
  const out = await new Response(stream).blob()
  return new Blob([out], { type })
}

export async function compressAttachment(file: File): Promise<CompressedFile> {
  const cru: CompressedFile = {
    blob: file,
    contentType: file.type || 'application/octet-stream',
    mimeType: file.type || 'application/octet-stream',
    name: file.name,
    encoding: null,
    originalBytes: file.size,
  }

  if (file.type.startsWith('image/')) {
    const img = await compressImage(file)
    return img && img.blob.size < file.size ? img : cru
  }

  // PDF (inclusive o que chega sem type, pela extensão).
  cru.contentType = cru.mimeType = 'application/pdf'
  const gz = await gzip(file)
  // Menos de 5% de ganho não paga o trabalho de descompactar ao abrir.
  if (gz && gz.size < file.size * 0.95) {
    return { ...cru, blob: gz, contentType: 'application/gzip', encoding: 'gzip' }
  }
  return cru
}
