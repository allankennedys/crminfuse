/**
 * E-mails do sistema, todos com a identidade da Infuse (logo, cores, texto em
 * português) e enviados pelo Resend, do endereço MAIL_FROM do domínio da Infuse.
 *
 * Secrets: RESEND_API_KEY e MAIL_FROM (ex.: "Infuse CRM <crm@infusesoftware.com>").
 */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

export interface EmailMarca {
  to: string
  subject: string
  /** Título dentro do e-mail. */
  titulo: string
  /** Parágrafos (texto simples; o que for dado fica escapado). */
  paragrafos: string[]
  botao: { texto: string; url: string }
  /** Linha pequena abaixo do botão. */
  rodape: string
  /** Aviso abaixo do cartão ("você recebeu este e-mail porque…"). */
  aviso?: string
  /** Endereço do sistema, de onde vem o logo. */
  base: string
}

export function emailConfigurado(): boolean {
  return Boolean(Deno.env.get('RESEND_API_KEY') && Deno.env.get('MAIL_FROM'))
}

export async function enviarEmailMarca(m: EmailMarca): Promise<boolean> {
  const key = Deno.env.get('RESEND_API_KEY') ?? ''
  const from = Deno.env.get('MAIL_FROM') ?? ''
  if (!key || !from) return false

  const link = esc(m.botao.url)
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border-radius:14px;border:1px solid #e3e6ec;">
      <tr><td style="padding:28px 32px 8px;">
        <img src="${esc(m.base)}/logo-navy.png" alt="Infuse" height="30" style="display:block;height:30px;border:0;">
      </td></tr>
      <tr><td style="padding:8px 32px 0;font-family:Arial,Helvetica,sans-serif;color:#0b1b3a;">
        <h1 style="font-size:20px;line-height:1.3;margin:12px 0 10px;">${esc(m.titulo)}</h1>
        ${m.paragrafos.map((p) => `<p style="font-size:15px;line-height:1.55;margin:0 0 14px;color:#3b4660;">${esc(p)}</p>`).join('\n        ')}
      </td></tr>
      <tr><td style="padding:4px 32px 8px;">
        <a href="${link}" style="display:inline-block;background:#1f6fe0;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:9px;">${esc(m.botao.texto)}</a>
      </td></tr>
      <tr><td style="padding:16px 32px 28px;font-family:Arial,Helvetica,sans-serif;font-size:12.5px;line-height:1.5;color:#6b7690;">
        ${esc(m.rodape)} Se o botão não abrir, copie este endereço no navegador:<br>
        <span style="word-break:break-all;color:#1f6fe0;">${link}</span>
      </td></tr>
    </table>
    ${m.aviso ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:11.5px;color:#8a93a8;margin:14px 0 0;max-width:520px;">${esc(m.aviso)}</p>` : ''}
  </td></tr>
</table></body></html>`
  const text = `${m.titulo}\n\n${m.paragrafos.join('\n\n')}\n\n${m.botao.texto}: ${m.botao.url}\n\n${m.rodape}${m.aviso ? `\n\n${m.aviso}` : ''}`

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [m.to], subject: m.subject, html, text }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null)
  if (!res?.ok) console.error('[email] resend', res?.status, await res?.text().catch(() => ''))
  return Boolean(res?.ok)
}

export async function sha256(texto: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function novoCodigo(): string {
  const b = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
