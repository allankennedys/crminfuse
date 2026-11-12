import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ExternalLink, Megaphone, Pencil, Receipt, X as XIcon } from 'lucide-react'
import { Loader } from '@/components/ui'
import { toast } from '@/store/toastStore'
import { useCan } from '@/store/authStore'
import { atendimentoService, formatPhone } from '@/services/atendimentoService'
import { PAYMENT_METHODS, formatBRL, paymentLabel } from '@/services/crmService'
import { nowSPDatetimeLocal, spWallTimeToUtcISO, formatSP } from '@/lib/datetime'
import type { WaClientCard, WaConversation } from '@/types'

/** "1.234,56", "1234,56", "1234.56" ou "R$ 1.234" → centavos. */
function parseBRL(raw: string): number | null {
  let t = raw.replace(/[R$\s]/g, '')
  if (!t) return null
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.')
  const n = Number(t)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null
}

/**
 * Cartão do cliente dentro da conversa (121): dados do contato do CRM,
 * origem, se veio de anúncio, e lançar venda. Funciona para o atendente sem
 * acesso ao CRM — as RPCs conferem se ele enxerga a conversa.
 */
export function ClientPanel({ conversation: conv, onClose, onOpenContact }: {
  conversation: WaConversation
  onClose: () => void
  onOpenContact?: (contactId: string) => void
}) {
  const can = useCan()
  const [card, setCard] = useState<WaClientCard | null>(null)
  const [editing, setEditing] = useState(false)
  const [selling, setSelling] = useState(false)

  const load = useCallback(() => {
    atendimentoService.clientCard(conv.id)
      .then(setCard)
      .catch((err) => toast.error(err instanceof Error ? err.message : 'Falha ao carregar o cliente'))
  }, [conv.id])

  // Recarrega quando o contato nasce (primeira mensagem) ou muda.
  useEffect(load, [load, conv.contact_id])

  const ct = card?.contact ?? null
  const nome = ct?.name || conv.push_name || formatPhone(conv.phone) || 'Cliente'

  return (
    <aside className="at-client" aria-label="Cliente">
      <header className="at-client-head">
        <strong>Cliente</strong>
        <button className="icon-btn" onClick={onClose} aria-label="Fechar painel do cliente"><XIcon size={16} /></button>
      </header>

      {!card ? <Loader /> : (
        <div className="at-client-body">
          {editing ? (
            <EditForm
              card={card}
              fallbackName={nome}
              onCancel={() => setEditing(false)}
              onSave={async (f) => {
                setCard(await atendimentoService.clientUpdate(conv.id, f))
                setEditing(false)
                toast.success('Cliente atualizado.')
              }}
            />
          ) : (
            <section className="at-client-id">
              <div className="at-client-name">
                <span>{nome}</span>
                <button className="icon-btn" onClick={() => setEditing(true)} aria-label="Editar cliente" title="Editar">
                  <Pencil size={14} />
                </button>
              </div>
              <div className="text-secondary">{formatPhone(ct?.phone ?? conv.phone) || 'Número oculto pelo WhatsApp'}</div>
              {ct?.email && <div className="text-secondary">{ct.email}</div>}

              <dl className="at-client-facts">
                <dt>Origem</dt>
                <dd>{ct?.origem || <span className="text-muted">não identificada</span>}</dd>
                {ct?.stage && (<><dt>Etapa</dt><dd>{ct.stage}</dd></>)}
                <dt>Compras</dt>
                <dd>{ct ? `${ct.sales_count} · ${formatBRL(ct.sales_total_cents)}` : '—'}</dd>
              </dl>

              {(card.ad || ct?.from_ad) && (
                <div className="at-client-ad">
                  <Megaphone size={14} />
                  <div>
                    <strong>Veio de anúncio{card.ad?.app ? ` (${card.ad.app === 'instagram' ? 'Instagram' : 'Facebook'})` : ''}</strong>
                    {card.ad?.title && <span>{card.ad.title}</span>}
                    <span className="text-muted">
                      {ct?.has_click
                        ? 'Vendas deste cliente vão para a Meta atribuídas ao anúncio.'
                        : 'Vendas deste cliente vão para a Meta como conversão de anúncio.'}
                    </span>
                  </div>
                </div>
              )}

              {ct && onOpenContact && can('crm.contatos.ver') && (
                <button className="btn btn-ghost btn-sm" onClick={() => onOpenContact(ct.id)}>
                  <ExternalLink size={13} /> Abrir no funil
                </button>
              )}
            </section>
          )}

          <section className="at-client-sales">
            {selling ? (
              <SaleForm
                fromAd={Boolean(card.ad || ct?.from_ad)}
                onCancel={() => setSelling(false)}
                onSave={async (s) => {
                  const r = await atendimentoService.launchSale(conv.id, s)
                  toast.success(r.from_ad
                    ? 'Venda lançada. A conversão vai para a Meta, atribuída ao anúncio.'
                    : 'Venda lançada.')
                  setSelling(false)
                  load()
                }}
              />
            ) : (
              <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setSelling(true)}>
                <Receipt size={15} /> Lançar venda
              </button>
            )}

            {card.sales.length > 0 && (
              <ul className="at-client-salelist">
                {card.sales.map((s) => (
                  <li key={s.id}>
                    <span>{formatBRL(s.value_cents)}</span>
                    <span className="text-muted">{paymentLabel(s.payment_method)} · {formatSP(s.sold_at).slice(0, 10)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </aside>
  )
}

function EditForm({ card, fallbackName, onCancel, onSave }: {
  card: WaClientCard
  fallbackName: string
  onCancel: () => void
  onSave: (f: { name: string; email: string; origem: string }) => Promise<void>
}) {
  const [name, setName] = useState(card.contact?.name ?? fallbackName)
  const [email, setEmail] = useState(card.contact?.email ?? '')
  const [origem, setOrigem] = useState(card.contact?.origem ?? '')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    try {
      await onSave({ name: name.trim(), email: email.trim(), origem: origem.trim() })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar')
      setBusy(false)
    }
  }

  return (
    <form className="at-client-form" onSubmit={submit}>
      <div className="field">
        <label htmlFor="cli-nome">Nome</label>
        <input id="cli-nome" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label htmlFor="cli-email">E-mail</label>
        <input id="cli-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="cli-origem">Origem</label>
        <input id="cli-origem" className="input" list="cli-origens" value={origem} onChange={(e) => setOrigem(e.target.value)} />
        <datalist id="cli-origens">
          {card.origens.map((o) => <option key={o} value={o} />)}
        </datalist>
      </div>
      <div className="flex" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancelar</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !name.trim()}>
          {busy ? <span className="spinner" /> : 'Salvar'}
        </button>
      </div>
    </form>
  )
}

function SaleForm({ fromAd, onCancel, onSave }: {
  fromAd: boolean
  onCancel: () => void
  onSave: (s: { valueCents: number; payment: string | null; soldAt: string | null; note: string }) => Promise<void>
}) {
  const [value, setValue] = useState('')
  const [payment, setPayment] = useState('')
  const [day, setDay] = useState(() => nowSPDatetimeLocal().slice(0, 10))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const cents = parseBRL(value)
  const hoje = nowSPDatetimeLocal().slice(0, 10)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!cents) return
    setBusy(true)
    try {
      // Hoje = agora; outro dia = meio-dia daquele dia em São Paulo.
      const soldAt = day === hoje ? null : spWallTimeToUtcISO(`${day}T12:00`)
      await onSave({ valueCents: cents, payment: payment || null, soldAt, note: note.trim() })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível lançar a venda')
      setBusy(false)
    }
  }

  return (
    <form className="at-client-form" onSubmit={submit}>
      <div className="field">
        <label htmlFor="venda-valor">Valor (R$)</label>
        <input
          id="venda-valor"
          className="input"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="0,00"
          autoFocus
        />
        {value && !cents && <span className="error-text" style={{ fontSize: 12 }}>Valor inválido</span>}
      </div>
      <div className="field">
        <label htmlFor="venda-pgto">Forma de pagamento</label>
        <select id="venda-pgto" className="input" value={payment} onChange={(e) => setPayment(e.target.value)}>
          <option value="">Não informada</option>
          {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="venda-dia">Data da venda</label>
        <input id="venda-dia" className="input" type="date" value={day} max={hoje} onChange={(e) => e.target.value && setDay(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="venda-obs">Observação</label>
        <input id="venda-obs" className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
      </div>
      <p className="text-muted" style={{ fontSize: 12 }}>
        {fromAd
          ? 'Cliente de anúncio: a venda vai para a Meta automaticamente.'
          : 'Sem anúncio identificado: a venda fica só no CRM.'}
      </p>
      <div className="flex" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancelar</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !cents}>
          {busy ? <span className="spinner" /> : 'Lançar venda'}
        </button>
      </div>
    </form>
  )
}
