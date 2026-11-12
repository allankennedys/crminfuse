import { Fragment } from 'react'
import { ExternalLink } from 'lucide-react'

/**
 * Texto livre com as URLs viradas link, de forma discreta: no lugar da URL
 * inteira aparece só o domínio e um pedaço do caminho, e a URL completa fica
 * no title. Só http(s) e www. viram link — nada de javascript: ou data:.
 */

// Para no espaço e em < > " — o resto da pontuação final sai no trimTrailing.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi
const MAX_LABEL = 32

/** Ponto, vírgula ou parêntese de fechamento colados no fim são da frase, não da URL. */
function trimTrailing(raw: string): [string, string] {
  let url = raw
  let resto = ''
  while (/[.,;:!?'")\]]$/.test(url)) {
    // Parêntese que fecha um aberto dentro da URL (Wikipédia) fica.
    if (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break
    resto = url.slice(-1) + resto
    url = url.slice(0, -1)
  }
  return [url, resto]
}

function shortLabel(href: string): string {
  try {
    const u = new URL(href)
    const host = u.hostname.replace(/^www\./, '')
    const caminho = (u.pathname === '/' ? '' : u.pathname) + (u.search ? '?…' : '')
    const label = host + caminho
    return label.length > MAX_LABEL ? label.slice(0, MAX_LABEL - 1) + '…' : label
  } catch {
    return href.length > MAX_LABEL ? href.slice(0, MAX_LABEL - 1) + '…' : href
  }
}

export function LinkifiedText({ text }: { text: string }) {
  const partes: React.ReactNode[] = []
  let ultimo = 0
  for (const m of text.matchAll(URL_RE)) {
    const inicio = m.index ?? 0
    const [url, resto] = trimTrailing(m[0])
    if (inicio > ultimo) partes.push(text.slice(ultimo, inicio))
    const href = url.toLowerCase().startsWith('www.') ? `https://${url}` : url
    partes.push(
      <a
        key={inicio}
        className="note-link"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={href}
      >
        {shortLabel(href)}
        <ExternalLink size={11} aria-hidden />
      </a>,
    )
    if (resto) partes.push(resto)
    ultimo = inicio + m[0].length
  }
  if (ultimo < text.length) partes.push(text.slice(ultimo))
  return <>{partes.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>
}
