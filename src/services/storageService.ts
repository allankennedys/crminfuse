/**
 * storageService — upload de mídias no Supabase Storage (lado do painel).
 * A exclusão automática (24h após o envio) acontece no servidor,
 * na Edge Function `worker`.
 */

import { supabase } from '@/lib/supabase'

const BUCKET = 'media'
const MAX_SIZE = 100 * 1024 * 1024

export const storageService = {
  /** Faz upload da mídia e retorna URL pública + caminho */
  async upload(file: File, organizationId: string): Promise<{ url: string; path: string }> {
    if (file.size > MAX_SIZE) {
      throw new Error(`Arquivo excede o limite de 100 MB (${(file.size / 1024 / 1024).toFixed(1)} MB)`)
    }

    const safeName = file.name.replace(/[^\w.\-]+/g, '_')
    const path = `${organizationId}/${Date.now()}-${safeName}`

    const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    })
    if (error) throw new Error(`Upload falhou: ${error.message}`)

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
    return { url: data.publicUrl, path }
  },

  async remove(path: string) {
    const { error } = await supabase.storage.from(BUCKET).remove([path])
    if (error) throw new Error(error.message)
  },
}
