import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ArrowLeft, Check, Eye, Receipt, Search, X as XIcon } from 'lucide-react'
import {
  approvalService, base64ParaComprovante, extrairValor, knownSellerNumber, semPreAprovacao, SELLERS,
  type ApproveFields, type Comprovante, type PendingApproval,
} from '@/services/approvalService'
import { crmService, phoneKey, phoneKeyVariants } from '@/services/crmService'
import { useCan } from '@/store/authStore'
import { confirmDialog } from '@/store/confirmStore'
import { toast } from '@/store/toastStore'
import { Modal, Loader, EmptyState } from '@/components/ui'
import { formatSP } from '@/lib/datetime'
import type { CrmContact } from '@/types'

/**
 * Sem realtime no banco dos comprovantes (supabaseExterno é só consulta):
 * o aviso se atualiza por polling e quando a aba volta ao foco.
 */
const POLL_MS = 60_000

function sellerName(numero: string | number | null): string {
  const n = knownSellerNumber(numero)
  return SELLERS.find((s) => s.number === n)?.name ?? (numero ? String(numero) : '—')
}

function valorDoComprovante(a: PendingApproval): string | null {
  if (a.valor_capturado !== null && String(a.valor_capturado).trim() !== '') {
    const n = Number(a.valor_capturado)
    return Number.isFinite(n)
      ? n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : String(a.valor_capturado)
  }
  return extrairValor(a.text_ocr)
}

/** "1.234,56" / "1234.5" → número; vazio ou inválido → null. */
function parseValor(raw: string): number | null {
  const t = raw.trim()
  if (!t) return null
  const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null
}

/**
 * Aviso de comprovantes à espera da aprovação final, com a aprovação feita
 * daqui mesmo. Some para quem não tem `crm.comprovantes.aprovar` e quando
 * não há nada pendente.
 */
export function PendingReceiptsButton() {
  const can = useCan()
  const allowed = can('crm.comprovantes.aprovar')
  const [items, setItems] = useState<PendingApproval[]>([])
  const [open, setOpen] = useState(false)

  const refresh = useCallback(() => {
    approvalService.listAwaitingFinal()
      .then(setItems)
      // Aviso é acessório: se o outro banco não responder, só não aparece.
      .catch((err) => console.warn('[comprovantes] falha ao listar pendentes', err))
  }, [])

  useEffect(() => {
    if (!allowed) return
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    window.addEventListener('focus', refresh)
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [allowed, refresh])

  if (!allowed || (items.length === 0 && !open)) return null

  return (
    <>
      <button className="receipts-alert" onClick={() => setOpen(true)}>
        <Receipt size={14} />
        {items.length === 1
          ? '1 comprovante aguardando aprovação'
          : `${items.length} comprovantes aguardando aprovação`}
      </button>
      {open && (
        <PendingReceiptsModal
          items={items}
          onDecided={(id) => { setItems((cur) => cur.filter((a) => a.id !== id)); refresh() }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function PendingReceiptsModal({ items, onDecided, onClose }: {
  items: PendingApproval[]
  onDecided: (id: string) => void
  onClose: () => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(items.length === 1 ? items[0].id : null)
  const selected = items.find((a) => a.id === selectedId) ?? null

  return (
    <Modal title="Comprovantes aguardando aprovação" onClose={onClose}>
      {selected ? (
        <ApprovalForm
          key={selected.id}
          approval={selected}
          onBack={() => setSelectedId(null)}
          onDecided={() => {
            onDecided(selected.id)
            setSelectedId(null)
            if (items.length === 1) onClose()
          }}
        />
      ) : items.length === 0 ? (
        <EmptyState icon={<Receipt />} text="Nenhum comprovante aguardando aprovação." />
      ) : (
        <div className="receipts-list">
          {items.map((a) => {
            const valor = valorDoComprovante(a)
            return (
              <button key={a.id} className="receipts-item" onClick={() => setSelectedId(a.id)}>
                <div style={{ minWidth: 0 }}>
                  <div className="receipts-item-name">{a.client || a.client_number || 'Sem nome'}</div>
                  <div className="text-muted receipts-item-meta">
                    {formatSP(a.created_at)} · {sellerName(a.seller_number ?? a.numero_caixa)}
                  </div>
                </div>
                <div className="receipts-item-side">
                  {a.status === 'pre_approved' && <span className="badge badge-yellow">pré-aprovado</span>}
                  {semPreAprovacao(a) && <span className="badge badge-gray">sem pré-aprovação</span>}
                  {valor && <span className="badge badge-green">R$ {valor}</span>}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </Modal>
  )
}

function ApprovalForm({ approval: a, onBack, onDecided }: {
  approval: PendingApproval
  onBack: () => void
  onDecided: () => void
}) {
  // Vem preenchido com o que o n8n identificou ou o que a pré-aprovação
  // declarou — o aprovador revisa em vez de digitar de novo.
  const [creatives, setCreatives] = useState(a.creatives_qty === null ? '' : String(a.creatives_qty))
  const [netValue, setNetValue] = useState(a.net_value === null ? '' : String(a.net_value).replace('.', ','))
  const [outros, setOutros] = useState(a.outrosPacotes ?? '')
  const [copy, setCopy] = useState<boolean>(a.contem_copy ?? true)
  const [seller, setSeller] = useState<string>(
    knownSellerNumber(a.seller_number) ?? knownSellerNumber(a.numero_caixa) ?? '',
  )
  // Contato do CRM escolhido para substituir o da venda (nome + número).
  const [contactChoice, setContactChoice] = useState<CrmContact | null>(null)
  const [busy, setBusy] = useState(false)

  const hasNumber = (a.client_number ?? '').replace(/\D/g, '') !== ''
  const valor = valorDoComprovante(a)
  const netValueInvalid = netValue.trim() !== '' && parseValor(netValue) === null

  async function approve() {
    if (!hasNumber && !contactChoice) return
    if (netValueInvalid) return
    const fields: ApproveFields = {
      creatives_qty: creatives === '' ? null : Number(creatives),
      net_value: parseValor(netValue),
      outrosPacotes: outros.trim() || null,
      contem_copy: copy,
      seller_number: seller || null,
    }
    if (contactChoice) {
      fields.client = contactChoice.name
      fields.client_number = contactChoice.phone
    }
    setBusy(true)
    try {
      await approvalService.decide(a.token, { action: 'approve', fields })
      toast.success('Comprovante aprovado.')
      onDecided()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao aprovar')
    } finally {
      setBusy(false)
    }
  }

  async function reject() {
    const ok = await confirmDialog({
      title: 'Recusar comprovante',
      message: `Recusar o comprovante de ${a.client || a.client_number || 'este cliente'}? A venda não segue para o n8n.`,
      confirmLabel: 'Recusar',
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      await approvalService.decide(a.token, { action: 'reject' })
      toast.success('Comprovante recusado.')
      onDecided()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao recusar')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ marginBottom: 14 }}>
        <ArrowLeft /> Voltar à lista
      </button>

      {a.status === 'pre_approved' && (
        <div className="journey-warn">
          <Check size={16} />
          <div>
            <strong>Pré-aprovado{a.pre_approved_at ? ` em ${formatSP(a.pre_approved_at)}` : ''}</strong>
            <p>Os campos abaixo vêm da pré-aprovação. Revise e ajuste antes de aprovar.</p>
          </div>
        </div>
      )}

      {semPreAprovacao(a) && (
        <div className="journey-warn">
          <AlertTriangle size={16} />
          <div>
            <strong>Venda do Pedro ainda sem pré-aprovação</strong>
            <p>Aprovar aqui pula a pré-aprovação e já é a aprovação final.</p>
          </div>
        </div>
      )}

      <div className="receipts-facts">
        <div>
          <div className="text-muted">Recebido</div>
          <div>{formatSP(a.created_at)}</div>
        </div>
        <div>
          <div className="text-muted">Valor no comprovante</div>
          <div>{valor ? `R$ ${valor}` : '—'}</div>
        </div>
        <div>
          <div className="text-muted">Entrou pelo WhatsApp</div>
          <div>{sellerName(a.numero_caixa)}</div>
        </div>
      </div>

      <ContactField approval={a} choice={contactChoice} onChoose={setContactChoice} disabled={busy} />

      {a.produtos?.trim() && (
        <div className="field">
          <label>Produtos</label>
          <div className="receipts-products">{a.produtos.trim()}</div>
        </div>
      )}

      <ReceiptPreview id={a.id} />

      <div className="drawer-grid">
        <div className="field">
          <label htmlFor="rc-seller">Vendedor</label>
          <select id="rc-seller" className="input" value={seller} disabled={busy} onChange={(e) => setSeller(e.target.value)}>
            {!seller && <option value="">—</option>}
            {SELLERS.map((s) => <option key={s.number} value={s.number}>{s.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rc-creatives">Qtd. de criativos</label>
          <input
            id="rc-creatives"
            className="input"
            inputMode="numeric"
            placeholder="0"
            value={creatives}
            disabled={busy}
            onChange={(e) => setCreatives(e.target.value.replace(/\D/g, ''))}
          />
        </div>
      </div>

      <div className="drawer-grid">
        <div className="field">
          <label htmlFor="rc-net">Valor líquido (R$)</label>
          <input
            id="rc-net"
            className="input"
            inputMode="decimal"
            placeholder="0,00"
            value={netValue}
            disabled={busy}
            onChange={(e) => setNetValue(e.target.value.replace(/[^\d.,]/g, ''))}
          />
          {netValueInvalid && <span className="text-muted sale-hint" style={{ color: 'var(--danger)' }}>Valor inválido</span>}
        </div>
        <div className="field">
          <label>Copy</label>
          <select className="input" value={copy ? 'sim' : 'nao'} disabled={busy} onChange={(e) => setCopy(e.target.value === 'sim')}>
            <option value="sim">Inclui Copy</option>
            <option value="nao">Não inclui Copy</option>
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor="rc-outros">Outros pacotes</label>
        <textarea
          id="rc-outros"
          className="input"
          rows={2}
          placeholder="Ex: VSL, Tráfego, LP…"
          value={outros}
          disabled={busy}
          onChange={(e) => setOutros(e.target.value)}
        />
      </div>

      <div className="flex" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
        <button className="btn btn-ghost btn-danger-ghost" onClick={reject} disabled={busy}>
          <XIcon /> Recusar
        </button>
        <button
          className="btn btn-primary"
          onClick={approve}
          disabled={busy || (!hasNumber && !contactChoice) || netValueInvalid}
        >
          <Check /> {busy ? 'Enviando…' : 'Aprovar comprovante'}
        </button>
      </div>
    </div>
  )
}

/**
 * Cliente da venda, conferido contra os contatos do CRM — mesma checagem da
 * página de aprovação. Trocar o contato substitui nome e número da venda; o
 * CRM não é alterado.
 */
function ContactField({ approval: a, choice, onChoose, disabled }: {
  approval: PendingApproval
  choice: CrmContact | null
  onChoose: (c: CrmContact | null) => void
  disabled: boolean
}) {
  const number = (a.client_number ?? '').replace(/\D/g, '')
  const [inCrm, setInCrm] = useState<boolean | null>(null)
  const [searching, setSearching] = useState(!number)
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<CrmContact[] | null>(null)

  useEffect(() => {
    if (!number) { setInCrm(false); return }
    let alive = true
    const keys = new Set(phoneKeyVariants(number))
    crmService.searchContacts(number, 5)
      .then((rows) => { if (alive) setInCrm(rows.some((c) => c.phone != null && keys.has(phoneKey(c.phone)))) })
      .catch(() => { if (alive) setInCrm(null) })
    return () => { alive = false }
  }, [number])

  useEffect(() => {
    const q = term.trim()
    if (q.length < 2) { setResults(null); return }
    let alive = true
    const timer = setTimeout(() => {
      crmService.searchContacts(q)
        .then((rows) => { if (alive) setResults(rows) })
        .catch(() => { if (alive) setResults([]) })
    }, 300)
    return () => { alive = false; clearTimeout(timer) }
  }, [term])

  return (
    <div className="field">
      <label>Cliente</label>
      <div className="receipts-contact">
        <div style={{ minWidth: 0 }}>
          <div className="receipts-item-name">{choice ? choice.name : (a.client || '—')}</div>
          <div className="text-muted mono" style={{ fontSize: 12 }}>
            {choice ? choice.phone : (a.client_number || 'sem número')}
          </div>
        </div>
        {choice ? (
          <span className="badge badge-blue">trocado</span>
        ) : inCrm === true ? (
          <span className="badge badge-green">no CRM</span>
        ) : inCrm === false ? (
          <span className="badge badge-yellow">{number ? 'fora do CRM' : 'sem número'}</span>
        ) : null}
        {choice ? (
          <button className="btn btn-ghost btn-sm" onClick={() => onChoose(null)} disabled={disabled}>Desfazer</button>
        ) : !searching && (
          <button className="btn btn-ghost btn-sm" onClick={() => setSearching(true)} disabled={disabled}>Trocar</button>
        )}
      </div>

      {!number && !choice && (
        <span className="text-muted sale-hint" style={{ marginBottom: 0 }}>
          O comprovante chegou sem número: escolha o contato no CRM para liberar a aprovação.
        </span>
      )}

      {searching && !choice && (
        <>
          <label className="crm-search receipts-search">
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Buscar contato por nome ou número…"
              aria-label="Buscar contato no CRM"
              autoFocus
            />
            <Search size={14} />
          </label>
          {results && (
            <div className="receipts-list">
              {results.length === 0 ? (
                <span className="text-muted" style={{ fontSize: 12 }}>Nenhum contato encontrado.</span>
              ) : results.filter((c) => c.phone).map((c) => (
                <button key={c.id} className="receipts-item" onClick={() => { onChoose(c); setTerm(''); setSearching(false) }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="receipts-item-name">{c.name}</div>
                    <div className="text-muted receipts-item-meta mono">{c.phone}{c.channel ? ` · ${c.channel}` : ''}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Comprovante sob demanda: o base64 é pesado e só vem quando pedido. */
function ReceiptPreview({ id }: { id: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'error' | 'empty'>('idle')
  const [comprovante, setComprovante] = useState<Comprovante | null>(null)

  async function load() {
    setState('loading')
    try {
      const base64 = await approvalService.getComprovante(id)
      if (!base64) { setState('empty'); return }
      setComprovante(base64ParaComprovante(base64))
      setState('idle')
    } catch {
      setState('error')
    }
  }

  if (comprovante) {
    return (
      <div className="field">
        <label>Comprovante</label>
        {comprovante.tipo === 'pdf' ? (
          <iframe src={comprovante.uri} title="Comprovante em PDF" className="receipts-preview" style={{ height: 420 }} />
        ) : (
          <a href={comprovante.uri} target="_blank" rel="noopener noreferrer" title="Abrir em nova aba">
            <img src={comprovante.uri} alt="Comprovante de pagamento" className="receipts-preview" />
          </a>
        )}
      </div>
    )
  }

  return (
    <div className="field">
      <label>Comprovante</label>
      {state === 'loading' ? <Loader /> : (
        <div className="flex" style={{ gap: 10, alignItems: 'center' }}>
          <button className="btn btn-ghost btn-sm" onClick={load}><Eye /> Exibir comprovante</button>
          {state === 'empty' && <span className="text-muted" style={{ fontSize: 12 }}>Sem comprovante anexado.</span>}
          {state === 'error' && <span className="text-muted" style={{ fontSize: 12 }}>Falha ao carregar o comprovante.</span>}
        </div>
      )}
    </div>
  )
}
