import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, Merge, Search, TriangleAlert } from 'lucide-react'
import { Modal } from '../ui'
import { crmService, formatBRL, hasAdClick } from '@/services/crmService'
import { toast } from '@/store/toastStore'
import { confirmDialog } from '@/store/confirmStore'
import { formatSP } from '@/lib/datetime'
import type { CrmContact, CrmMergeResult } from '@/types'

/**
 * Unificar dois cadastros do MESMO cliente (RPC crm_merge_contacts, 077).
 *
 * O caso: a venda chega do gateway com um número diferente do que o cliente
 * usa no WhatsApp, a automação não acha o cadastro e cria outro. Fica um
 * contato com a conversa e o clique do anúncio, e outro com a venda — e a
 * venda não vai para a Meta, porque o cadastro em que ela caiu não tem
 * clique nenhum.
 *
 * POR QUE A ESCOLHA DE QUEM FICA É EXPLÍCITA
 *
 * Não é detalhe de implementação: o que fica é o telefone, o canal, a etapa,
 * o histórico e a conversa do sobrevivente. Do descartado sobe só o que
 * falta no outro. Escolher errado troca o número pelo qual a automação fala
 * com o cliente — por isso a tela mostra os dois lado a lado com os sinais
 * que decidem, em vez de resolver sozinha e avisar depois.
 *
 * A recomendação NÃO desempata por data. Contato de importação carrega
 * created_at de 2025-01-01, e "o mais antigo" elegeria justamente a carcaça.
 */
export function MergeContactsDialog({ contact, onClose, onMerged }: {
  /** O contato aberto no drawer — um dos dois lados, não necessariamente o
      que fica. */
  contact: CrmContact
  onClose: () => void
  /** Chamado com o resultado da RPC; o drawer usa para recarregar a tela. */
  onMerged: (result: CrmMergeResult) => void
}) {
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<CrmContact[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [outro, setOutro] = useState<CrmContact | null>(null)
  /** Id de quem FICA. Só existe depois de escolher o segundo cadastro. */
  const [survivorId, setSurvivorId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => { searchRef.current?.focus() }, [])

  // Busca com respiro de 300ms, como a do lançamento de venda: a cada tecla
  // seria uma varredura da tabela de contatos.
  useEffect(() => {
    if (outro) return
    const q = term.trim()
    if (q.length < 2) { setResults(null); setSearching(false); return }
    let alive = true
    setSearching(true)
    const timer = setTimeout(() => {
      crmService.searchContacts(q)
        .then((rows) => {
          // O próprio contato nunca aparece na lista: unificar alguém com ele
          // mesmo é o único par que a função recusa, e vê-lo ali só convida
          // ao clique errado.
          if (alive) setResults(rows.filter((r) => r.id !== contact.id))
        })
        .catch((err) => {
          if (alive) toast.error(err instanceof Error ? err.message : 'Falha ao buscar contatos')
        })
        .finally(() => { if (alive) setSearching(false) })
    }, 300)
    return () => { alive = false; clearTimeout(timer) }
  }, [term, outro, contact.id])

  /**
   * Quem deveria ficar, na ordem que importa: o clique do anúncio é o que
   * atribui a venda à campanha, e sem ele a conversão sai como
   * system_generated (ou não sai). Depois a conversa, que é por onde a
   * automação fala com o cliente.
   */
  const recomendar = useCallback((a: CrmContact, b: CrmContact): CrmContact => {
    const clique = [hasAdClick(a), hasAdClick(b)]
    if (clique[0] !== clique[1]) return clique[0] ? a : b
    const conversa = [!!a.conversation_id, !!b.conversation_id]
    if (conversa[0] !== conversa[1]) return conversa[0] ? a : b
    // Empatado nos dois sinais: fica o que o operador já tinha aberto, que é
    // o contexto de onde ele veio.
    return a
  }, [])

  function escolher(c: CrmContact) {
    setOutro(c)
    setSurvivorId(recomendar(contact, c).id)
  }

  const fica = survivorId === contact.id ? contact : outro
  const sai = survivorId === contact.id ? outro : contact

  async function unificar() {
    if (!fica || !sai) return

    const ok = await confirmDialog({
      title: 'Unificar cadastros',
      message:
        `"${sai.name}" deixa de existir. As vendas e os eventos da Meta passam `
        + `para "${fica.name}", que mantém o telefone, o canal e a etapa dele.\n\n`
        + 'O que já foi enviado à Meta NÃO é reenviado. O que ainda não foi entra '
        + 'na fila, com a data da venda preservada.\n\n'
        + 'Não dá para desfazer.',
      confirmLabel: 'Unificar',
      danger: true,
    })
    if (!ok) return

    setBusy(true)
    try {
      const r = await crmService.mergeContacts(fica.id, sai.id)
      onMerged(r)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao unificar os cadastros')
      setBusy(false)
    }
  }

  return (
    <Modal title="Unificar cadastros" onClose={onClose} wide>
      {!outro ? (
        <>
          <p className="text-muted merge-intro">
            Procure o outro cadastro do mesmo cliente, por exemplo um que foi
            criado com outro número ou em outro canal.
          </p>

          <label className="crm-search crm-search-block">
            <input
              ref={searchRef}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Nome ou número (com ou sem o 55)"
              aria-label="Buscar o outro cadastro"
            />
            <Search size={14} />
          </label>

          {searching && <p className="text-muted sale-pick-msg">Procurando…</p>}

          {results !== null && !searching && (
            results.length === 0 ? (
              <p className="text-muted sale-pick-msg">
                Nenhum outro contato com “{term.trim()}”.
              </p>
            ) : (
              <ul className="sale-pick-list">
                {results.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => escolher(c)}>
                      <span className="sale-pick-main">
                        <span className="sale-pick-name">{c.name}</span>
                        <span className="text-muted" style={{ fontSize: 11.5 }}>
                          {c.phone || 'sem telefone'}
                          {c.origem ? ` · ${c.origem}` : ''}
                          {c.channel ? ` · ${c.channel}` : ''}
                        </span>
                      </span>
                      <span className={`badge ${c.sales_count > 0 ? 'badge-green' : 'badge-gray'}`}>
                        {c.sales_count > 0
                          ? `${c.sales_count}× · ${formatBRL(c.sales_total_cents)}`
                          : 'sem compra'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}
        </>
      ) : (
        <>
          <p className="text-muted merge-intro">
            Escolha qual cadastro <strong>fica</strong>. Ele mantém o telefone, o
            canal, a etapa e a conversa; do outro sobe só o que estiver
            faltando nele: e-mail, clique do anúncio, origem e etiquetas.
          </p>

          <div className="merge-sides">
            {[contact, outro].map((c) => {
              const escolhido = survivorId === c.id
              const clique = hasAdClick(c)
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`merge-side${escolhido ? ' active' : ''}`}
                  onClick={() => setSurvivorId(c.id)}
                  aria-pressed={escolhido}
                >
                  <span className="merge-side-tag">
                    {escolhido ? 'Fica' : 'Sai'}
                  </span>
                  <span className="merge-side-name">{c.name}</span>
                  <span className="text-muted merge-side-phone">
                    {c.phone || 'sem telefone'}
                  </span>
                  <span className="merge-side-facts">
                    {/* Os três sinais que decidem quem fica, na mesma ordem da
                        recomendação. */}
                    <span className={clique ? 'badge badge-green' : 'badge badge-gray'}>
                      {clique ? 'clique de anúncio' : 'sem clique'}
                    </span>
                    <span className={c.conversation_id ? 'badge badge-green' : 'badge badge-gray'}>
                      {c.conversation_id ? 'tem conversa' : 'sem conversa'}
                    </span>
                    <span className={c.sales_count > 0 ? 'badge badge-blue' : 'badge badge-gray'}>
                      {c.sales_count > 0
                        ? `${c.sales_count} venda${c.sales_count === 1 ? '' : 's'} · ${formatBRL(c.sales_total_cents)}`
                        : 'sem venda'}
                    </span>
                  </span>
                  <span className="text-muted merge-side-meta">
                    {c.origem ? `${c.origem} · ` : ''}
                    {c.channel ? `${c.channel} · ` : ''}
                    criado em {formatSP(c.created_at)}
                  </span>
                </button>
              )
            })}
          </div>

          {/* O que vai acontecer, em uma linha — antes do botão, não depois. */}
          {fica && sai && (
            <p className="merge-summary">
              <strong>{sai.name}</strong> <ArrowRight size={13} /> <strong>{fica.name}</strong>
              {sai.sales_count > 0 && (
                <span className="text-muted">
                  {' '}· {sai.sales_count} venda{sai.sales_count === 1 ? '' : 's'} muda
                  {sai.sales_count === 1 ? '' : 'm'} de dono, com a data preservada
                </span>
              )}
            </p>
          )}

          {/* Trocar o número pelo qual a automação fala com o cliente é o erro
              caro desta tela, e ele não tem volta. O aviso só aparece quando
              é o caso de fato. */}
          {sai?.conversation_id && !fica?.conversation_id && (
            <div className="card ads-notice merge-warn">
              <div className="card-title" style={{ marginBottom: 6 }}>
                <TriangleAlert size={14} /> A conversa é do cadastro que sai
              </div>
              <p style={{ fontSize: 12.5 }}>
                “{sai.name}” é quem tem o vínculo com o WhatsApp. Ele sobe para o
                cadastro que fica, mas confira se é mesmo esse o lado certo,
                porque é por ele que o atendimento encontra o cliente.
              </p>
            </div>
          )}

          <div className="merge-actions">
            {/* "Voltar à busca", e não "trocar": quem troca é o clique nos
                cartões acima, que muda o lado que fica. Dois controles com
                nomes parecidos, no único lugar da tela onde o erro não tem
                volta, é confusão que sai caro. */}
            <button
              className="btn btn-ghost"
              onClick={() => { setOutro(null); setSurvivorId(null) }}
              disabled={busy}
            >
              Voltar à busca
            </button>
            <button className="btn btn-primary" onClick={unificar} disabled={busy}>
              <Merge size={15} /> {busy ? 'Unificando…' : 'Unificar'}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
