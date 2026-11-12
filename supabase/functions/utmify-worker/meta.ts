/**
 * De que campanha e conjunto é um anúncio — para as UTMs das vendas de CTWA.
 *
 * Sem dependência do Deno nem do Supabase: recebe os tokens e o fetch, e
 * devolve as UTMs no formato da UTMify ("nome|id"). Assim dá para testar
 * fora da Edge Function.
 */

const GRAPH = 'https://graph.facebook.com/v21.0'

export interface UtmsDoAnuncio {
  utm_campaign: string
  utm_medium: string
  utm_content: string
}

export type BuscaAnuncio =
  | { ok: true; utms: UtmsDoAnuncio }
  // transient = vale tentar de novo mais tarde (limite, rede, 5xx).
  | { ok: false; transient: boolean; error: string }

interface No { id?: string; name?: string }
interface MetaError { message?: string; code?: number }
interface Resposta extends No {
  adset?: No
  campaign?: No
  error?: MetaError
}

/** "nome|id", que é como a UTMify lê campanha, conjunto e anúncio. Barra no
    nome quebraria a separação, então vira hífen. */
function par(no: No | undefined, idAvulso = ''): string {
  const id = no?.id || idAvulso
  if (!id) return ''
  const nome = no?.name?.replace(/\|/g, '-').trim()
  return nome ? `${nome}|${id}` : id
}

/** Os mesmos códigos de limite que a meta-ads trata como passageiros. */
function passageiro(status: number, err?: MetaError): boolean {
  if (status === 0 || status === 429 || status >= 500) return true
  const code = err?.code
  if (code == null) return false
  return code === 1 || code === 2 || code === 4 || code === 17 || code === 32 || code === 613
    || (code >= 80000 && code <= 80014)
}

async function pedir(
  id: string, fields: string, token: string, fetcher: typeof fetch,
): Promise<{ status: number; body: Resposta | null; erroRede?: string }> {
  const url = `${GRAPH}/${encodeURIComponent(id)}?${new URLSearchParams({ fields, access_token: token })}`
  try {
    const res = await fetcher(url)
    const body = await res.json().catch(() => null) as Resposta | null
    return { status: res.status, body }
  } catch (err) {
    return { status: 0, body: null, erroRede: err instanceof Error ? err.message : 'Falha de rede' }
  }
}

/**
 * Tenta cada token até um enxergar o id. O id costuma ser de anúncio (é o
 * source_id do clique de CTWA); se a Meta disser que o objeto não tem
 * `adset` (código 100), ele é de conjunto, e a pergunta muda.
 *
 * O token vai na query string, não em log: a mensagem devolvida é só a da
 * Meta.
 */
export async function buscarAnuncio(
  id: string, tokens: string[], fetcher: typeof fetch = fetch,
): Promise<BuscaAnuncio> {
  if (tokens.length === 0) {
    return { ok: false, transient: false, error: 'Nenhum token da Meta salvo' }
  }

  let ultimoErro = 'Anúncio não encontrado'
  let houvePassageiro = false

  for (const token of tokens) {
    const anuncio = await pedir(id, 'name,adset{id,name},campaign{id,name}', token, fetcher)
    if (anuncio.status === 200 && anuncio.body?.campaign?.id) {
      return {
        ok: true,
        utms: {
          utm_campaign: par(anuncio.body.campaign),
          utm_medium: par(anuncio.body.adset),
          utm_content: par(anuncio.body, id),
        },
      }
    }

    const err = anuncio.body?.error
    ultimoErro = anuncio.erroRede ?? err?.message ?? `HTTP ${anuncio.status}`
    if (passageiro(anuncio.status, err)) {
      houvePassageiro = true
      continue
    }

    if (err?.code === 100) {
      const conjunto = await pedir(id, 'name,campaign{id,name}', token, fetcher)
      if (conjunto.status === 200 && conjunto.body?.campaign?.id) {
        return {
          ok: true,
          utms: {
            utm_campaign: par(conjunto.body.campaign),
            utm_medium: par(conjunto.body, id),
            utm_content: id,
          },
        }
      }
      if (passageiro(conjunto.status, conjunto.body?.error)) houvePassageiro = true
    }
    // Token de outra conta ou vencido: o próximo pode enxergar.
  }

  return { ok: false, transient: houvePassageiro, error: ultimoErro }
}
