/**
 * approvalService — comprovantes (tabela `approvals`) que ficam em OUTRO
 * projeto Supabase, o do pós-compra (pos-compra-ph-creative).
 *
 * Nada aqui toca a tabela direto. Ler passa pela Edge Function `receipts` e
 * aprovar/recusar pela `crm-decide-receipt`, as duas lá, conferindo a sessão
 * deste CRM e a organização. A decisão dispara o mesmo webhook do n8n que a
 * página de aprovação dispara.
 */

import { supabase } from '@/lib/supabase'
import { supabaseExterno } from '@/lib/supabaseExterno'

/**
 * Extrai o valor do pagamento a partir do texto do OCR: pega os números que
 * vêm logo após o "R$" (formato brasileiro, ex: "R$ 1.234,56" → "1.234,56").
 */
export function extrairValor(textoOcr: string | null): string | null {
  if (!textoOcr) return null
  const m = textoOcr.match(/R\$\s*([\d.]+(?:,\d{2})?)/)
  return m ? m[1] : null
}

/** WhatsApp do Pedro: as vendas dele passam por pré-aprovação antes da final (no CRM, opcional). */
export const PEDRO_NUMBER = '00000000000'

/** Vendedores a quem a venda pode ser creditada — espelha SELLERS do pós-compra. */
export const SELLERS = [
  { number: '00000000001', name: 'Vendedor 1' },
  { number: PEDRO_NUMBER, name: 'Vendedor 2' },
] as const

/** Venda do Pedro que ainda não foi pré-aprovada — aprovar pelo CRM pula essa etapa. */
export function semPreAprovacao(a: { status: string; numero_caixa: string | number | null }): boolean {
  return a.status === 'pending' && String(a.numero_caixa ?? '').replace(/\D/g, '') === PEDRO_NUMBER
}

/** Número do vendedor quando é um dos conhecidos, null caso contrário. */
export function knownSellerNumber(raw: string | number | null): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '')
  return SELLERS.some((s) => s.number === digits) ? digits : null
}

/**
 * O CRM só passou a avisar dos comprovantes a partir desta data: o que ficou
 * em aberto antes dela é acúmulo de vendas resolvidas por fora.
 */
export const AVISO_DESDE = '2026-10-21T00:00:00-03:00'

/** Comprovante esperando a aprovação final, com o que ela pode ajustar. */
export interface PendingApproval {
  id: string
  token: string
  status: 'pending' | 'pre_approved'
  created_at: string
  text_ocr: string | null
  client: string | null
  client_number: string | null
  numero_caixa: string | number | null
  seller_number: string | null
  valor_capturado: string | number | null
  creatives_qty: number | null
  net_value: number | null
  outrosPacotes: string | null
  contem_copy: boolean | null
  produtos: string | null
  pre_approved_at: string | null
}

/** O que a aprovação final envia — mesmos campos da página de aprovação. */
export interface ApproveFields {
  /** Só quando o contato foi trocado (ou o registro chegou sem número). */
  client?: string | null
  client_number?: string | null
  creatives_qty: number | null
  net_value: number | null
  outrosPacotes: string | null
  contem_copy: boolean
  seller_number: string | null
}

export interface Comprovante {
  uri: string
  tipo: 'imagem' | 'pdf'
}

/**
 * Monta o data URI do comprovante base64 (imagem ou PDF). Se já vier com
 * prefixo "data:", reaproveita; senão detecta o tipo pela assinatura do base64.
 */
export function base64ParaComprovante(base64: string): Comprovante {
  const raw = base64.trim()

  if (raw.startsWith('data:')) {
    return { uri: raw, tipo: raw.startsWith('data:application/pdf') ? 'pdf' : 'imagem' }
  }

  // JVBER... = "%PDF" em base64
  if (raw.startsWith('JVBER')) {
    return { uri: `data:application/pdf;base64,${raw}`, tipo: 'pdf' }
  }

  let mime = 'image/jpeg'
  if (raw.startsWith('iVBOR')) mime = 'image/png'
  else if (raw.startsWith('R0lGOD')) mime = 'image/gif'
  else if (raw.startsWith('UklGR')) mime = 'image/webp'
  else if (raw.startsWith('/9j/')) mime = 'image/jpeg'
  return { uri: `data:${mime};base64,${raw}`, tipo: 'imagem' }
}

/**
 * Leitura da tabela `approvals` pela Edge Function `receipts` do pós-compra,
 * com a sessão de quem está logado. A tabela não é mais legível com a anon
 * key: a policy aberta deixava qualquer um que tivesse um link de aprovação
 * baixar todos os comprovantes, com nome e telefone dos clientes.
 */
async function readReceipts<T>(payload: Record<string, unknown>): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Sessão expirada. Entre de novo.')
  const { data, error } = await supabaseExterno.functions.invoke('receipts', {
    body: payload,
    headers: { 'x-crm-token': session.access_token },
  })
  if (error) throw new Error(await functionErrorMessage(error, 'Falha ao carregar comprovantes'))
  return data as T
}

export const approvalService = {
  /** Busca o comprovante em base64 de um registro específico. */
  async getComprovante(id: string): Promise<string | null> {
    const data = await readReceipts<{ comprovante_base64: string | null }>({ action: 'file', id })
    return data?.comprovante_base64 ?? null
  },

  /**
   * Comprovantes em aberto, todos decididos daqui como aprovação FINAL —
   * Vendas do Pedro ainda sem pré-aprovação ficam de fora: só entram no
   * aviso depois de pré-aprovadas.
   */
  async listAwaitingFinal(): Promise<PendingApproval[]> {
    const { rows } = await readReceipts<{ rows: PendingApproval[] }>({ action: 'pending', since: AVISO_DESDE })
    return (rows ?? []).filter((a) => !semPreAprovacao(a))
  },

  /** Aprovação final (ou recusa) pela Edge Function do pós-compra. */
  async decide(token: string, decision: { action: 'approve'; fields: ApproveFields } | { action: 'reject' }): Promise<void> {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) throw new Error('Sessão expirada. Entre de novo.')

    const body = decision.action === 'approve'
      ? { token, action: 'approve', ...decision.fields }
      : { token, action: 'reject' }
    const { error } = await supabaseExterno.functions.invoke('crm-decide-receipt', {
      body,
      headers: { 'x-crm-token': session.access_token },
    })
    if (error) throw new Error(await functionErrorMessage(error, 'Falha ao decidir o comprovante'))
  },
}

/** A mensagem que a Edge Function devolveu em { error }, quando há uma. */
async function functionErrorMessage(err: unknown, fallback: string): Promise<string> {
  const e = err as { message?: string; context?: unknown }
  if (e.context instanceof Response) {
    const parsed = await e.context.json().catch(() => null) as { error?: unknown } | null
    if (parsed && typeof parsed.error === 'string') return parsed.error
  }
  return e.message ?? fallback
}
