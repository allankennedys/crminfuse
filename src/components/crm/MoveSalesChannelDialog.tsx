import { useMemo, useState } from 'react'
import { ArrowRight, Send, TriangleAlert } from 'lucide-react'
import { Modal } from '../ui'
import { Combobox, type ComboOption } from './Combobox'
import { canalLabel, channelKey, crmService, formatBRL, paymentLabel } from '@/services/crmService'
import { toast } from '@/store/toastStore'
import { formatSP } from '@/lib/datetime'
import type { CrmContact, CrmSale } from '@/types'

/**
 * Escolher QUAIS vendas vão para outro canal (RPC crm_move_sales_to_channel, 089).
 *
 * O caso: cliente que comprou pelos dois WhatsApps com as duas vendas no
 * mesmo cadastro. Trocar o canal do contato leva todas junto — certo quando
 * de fato todas mudaram de dono, errado quando só uma comprou pelo outro
 * número.
 *
 * O CANAL MORA NO CONTATO, NÃO NA VENDA (080). Então esta tela não "marca a
 * venda com um canal": ela MOVE a venda para o cadastro daquele canal, que o
 * banco cria na hora se não existir, levando identidade e dados de anúncio.
 * O cadastro de origem fica com as vendas que sobraram. É por isso que o
 * texto fala em cadastro, e não em etiqueta de canal — quem ler "mudei o
 * canal da venda" vai procurar um campo que não existe.
 *
 * DUAS PORTAS, UMA TELA
 *
 *   • pela lista de vendas → o usuário escolhe o canal aqui (`channel` livre);
 *   • ao trocar o canal do contato com 2+ vendas → o canal já vem decidido e
 *     o campo aparece travado, porque mudá-lo aqui contradiria o que a
 *     pessoa acabou de digitar no drawer.
 *
 */
export function MoveSalesChannelDialog({
  contact, sales, channelOptions, fixedChannel, onAllSelected, onClose, onMoved,
}: {
  contact: CrmContact
  /** As vendas do contato, na ordem em que o drawer as mostra. */
  sales: CrmSale[]
  channelOptions: ComboOption[]
  /** Canal já decidido (veio da troca de canal do contato). Trava o campo. */
  fixedChannel?: string
  /**
   * Só existe na porta da troca de canal. Marcar TODAS ali não é mover venda
   * por venda: é o contato inteiro que mudou de número, e aí o caminho certo
   * é o de sempre (troca o canal do cadastro, com a oferta de unificar se o
   * canal de destino já estiver ocupado) — assim histórico, etiquetas e
   * anotações vão junto, e nenhum cadastro vazio fica para trás.
   */
  onAllSelected?: () => void
  onClose: () => void
  /** Chamado depois do movimento; o drawer recarrega a partir daí. */
  onMoved: (info: { moved: number; targetContactId: string; sourceSalesLeft: number }) => void
}) {
  const [channel, setChannel] = useState(fixedChannel ?? '')
  const [escolhidas, setEscolhidas] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)

  const destinoTravado = fixedChannel != null

  /**
   * Mesmo canal dos dois lados não tem movimento nenhum a fazer, e o banco
   * recusaria. Barrar aqui evita a viagem e diz o motivo no lugar certo.
   */
  const mesmoCanal = channelKey(channel) === channelKey(contact.channel ?? '')

  /**
   * O canal em que as vendas já estão sai da lista: escolhê-lo é justamente
   * o que o botão recusa, então oferecê-lo seria oferecer um beco.
   */
  const opcoes = useMemo(
    () => channelOptions.filter(
      (o) => channelKey(o.value) !== channelKey(contact.channel ?? ''),
    ),
    [channelOptions, contact.channel],
  )

  const todas = escolhidas.size === sales.length && sales.length > 0
  const total = useMemo(
    () => sales.filter((s) => escolhidas.has(s.id)).reduce((a, s) => a + s.value_cents, 0),
    [sales, escolhidas],
  )

  function alterna(id: string) {
    setEscolhidas((atual) => {
      const proximo = new Set(atual)
      if (proximo.has(id)) proximo.delete(id)
      else proximo.add(id)
      return proximo
    })
  }

  async function mover() {
    // Todas marcadas na porta da troca de canal: devolve para o fluxo do
    // drawer em vez de esvaziar o cadastro de origem.
    if (todas && onAllSelected) {
      onAllSelected()
      return
    }
    if (escolhidas.size === 0) {
      toast.error('Escolha ao menos uma venda')
      return
    }
    if (!channel.trim()) {
      toast.error('Escolha o canal de destino')
      return
    }
    setBusy(true)
    try {
      const r = await crmService.moveSalesToChannel([...escolhidas], channel.trim())
      toast.success(
        `${r.moved} venda${r.moved === 1 ? '' : 's'} agora ${r.moved === 1 ? 'é' : 'são'} de `
        + `${canalLabel(channel)}`
        + (r.targetCreated ? ' · cadastro criado neste canal' : '')
        + (r.sourceSalesLeft === 0 ? ' · o cadastro de origem ficou sem vendas' : ''),
      )
      onMoved({ moved: r.moved, targetContactId: r.targetContactId, sourceSalesLeft: r.sourceSalesLeft })
    } catch (err) {
      // O erro do supabase-js não é Error: a mensagem do banco (permissão,
      // venda que sumiu, cadastros diferentes) viria como "Falha ao mover".
      toast.error(err instanceof Error ? err.message : String((err as { message?: string })?.message ?? 'Falha ao mover as vendas'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Mover vendas para outro canal" onClose={onClose}>
      <p className="text-muted" style={{ fontSize: 12, marginBottom: 16 }}>
        As marcadas mudam de canal. As demais ficam
        em {canalLabel(contact.channel ?? '') || 'canal em branco'}.
      </p>

      <div className="field">
        <label>Canal de destino</label>
        {destinoTravado ? (
          <div className="input" aria-readonly="true" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="text-muted">{canalLabel(contact.channel ?? '') || 'em branco'}</span>
            <ArrowRight size={13} />
            <strong>{canalLabel(channel)}</strong>
          </div>
        ) : (
          <Combobox
            value={channel}
            onChange={setChannel}
            options={opcoes}
            placeholder="Escolha o canal…"
            ariaLabel="Canal de destino"
            // Escolher da lista é a tarefa desta tela: as opções aparecem
            // de saída, sem precisar clicar no campo antes.
            autoFocus
          />
        )}
      </div>

      {!destinoTravado && channel.trim() && mesmoCanal && (
        <div className="card ads-notice merge-warn">
          <p style={{ fontSize: 12.5 }}>
            <TriangleAlert size={13} /> As vendas já estão neste canal. Escolha outro.
          </p>
        </div>
      )}

      <div className="move-sales-head">
        <label>Quais vendas vão</label>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setEscolhidas(todas ? new Set() : new Set(sales.map((s) => s.id)))}
        >
          {todas ? 'Desmarcar todas' : 'Marcar todas'}
        </button>
      </div>

      <ul className="move-sales-list">
        {sales.map((s, i) => (
          <li key={s.id}>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={escolhidas.has(s.id)}
                onChange={() => alterna(s.id)}
              />
              <span className="move-sales-info">
                <strong>{formatBRL(s.value_cents)}</strong>
                <span className="text-muted">
                  {formatSP(s.sold_at)}
                  {s.payment_method && ` · ${paymentLabel(s.payment_method)}`}
                </span>
              </span>
            </label>
            {/* A 1ª venda é a que levou o contato ao funil e virou conversão
                na Meta. Movê-la é legítimo — o evento acompanha —, mas quem
                está escolhendo merece saber qual é. */}
            {i === 0 && <span className="badge badge-green">1ª venda</span>}
          </li>
        ))}
      </ul>

      {todas && sales.length > 1 && (
        <div className="card ads-notice merge-warn">
          <div className="card-title" style={{ marginBottom: 6 }}>
            <TriangleAlert size={14} /> Todas as vendas marcadas
          </div>
          <p style={{ fontSize: 12.5 }}>
            {onAllSelected
              ? 'É o contato inteiro mudando de canal. O botão abaixo faz isso, levando '
                + 'histórico e etiquetas junto.'
              : 'O cadastro de origem fica sem venda nenhuma.'}
          </p>
        </div>
      )}


      <div className="merge-actions">
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancelar</button>
        <button
          className="btn btn-primary"
          onClick={mover}
          disabled={busy || escolhidas.size === 0 || !channel.trim() || mesmoCanal}
        >
          <Send size={14} />
          {busy
            ? 'Movendo…'
            : todas && onAllSelected
              ? 'Trocar o canal do contato'
              : escolhidas.size === 0
                ? 'Mover'
                : `Mover ${escolhidas.size} venda${escolhidas.size === 1 ? '' : 's'} · ${formatBRL(total)}`}
        </button>
      </div>
    </Modal>
  )
}
