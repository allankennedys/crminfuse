import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Receipt, Search, UserPlus, X } from 'lucide-react'
import { Combobox, type ComboOption } from './Combobox'
import { avisarSistemasExternos } from './saleWebhook'
import {
  canalLabel, channelKey, crmService, formatBRL, isAdContact, normalizePhone, parseBRL,
  PAYMENT_METHODS,
} from '@/services/crmService'
import { useAuthStore, useCan } from '@/store/authStore'
import { toast } from '@/store/toastStore'
import { formatSP, nowSPDatetimeLocal, spWallTimeToUtcISO } from '@/lib/datetime'
import type { CrmContact, CrmPaymentMethod, CrmStage } from '@/types'

/** Número em forma legível. Cai no cru quando não é um telefone brasileiro. */
function phoneLabel(phone: string | null | undefined): string {
  const d = normalizePhone(phone ?? '')
  if (!d) return 'sem número'
  const local = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d
  if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`
  if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`
  return d
}

/**
 * Lançamento de venda a partir da tela inicial do CRM.
 *
 * O caminho do vendedor que fechou negócio e não quer procurar o card no
 * kanban: acha o cliente pelo nome ou pelo número, informa valor e criativos,
 * e pronto. O contato que ainda não existe é criado aqui mesmo.
 *
 * A REGRA DE QUEM CONVERTE NÃO ESTÁ AQUI. Como no painel do contato, o front
 * só insere a linha em crm_sales: é a trigger da 031 que move a primeira
 * venda para a etapa de conversão, e a da 072 que avisa a Meta de CADA venda
 * do cliente de anúncio — recompra inclusive, com o valor dela.
 */
export function SaleDrawer({ stages, initialContact, onClose, onSaved }: {
  stages: CrmStage[]
  /** Cliente já escolhido — o card arrastado para a conversão no kanban. */
  initialContact?: CrmContact
  onClose: () => void
  onSaved: () => void
}) {
  const profile = useAuthStore((s) => s.profile)
  const can = useCan()
  // Criar contato é permissão de contatos, não de vendas: quem só lança venda
  // escolhe entre os que já existem.
  const canEditContacts = can('crm.contatos.editar')

  // ---------- escolha do cliente ----------
  const [term, setTerm] = useState('')
  // null = ninguém buscou ainda (não é "nada encontrado").
  const [results, setResults] = useState<CrmContact[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [contact, setContact] = useState<CrmContact | null>(initialContact ?? null)
  // Cadastro novo, preenchido a partir do que foi digitado na busca.
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')

  // ---------- a venda ----------
  const [value, setValue] = useState('')
  const [creatives, setCreatives] = useState('1')
  // Sem valor inicial de propósito: chutar "Pix" faria a maioria das vendas
  // nascer com a forma errada sem ninguém perceber. Vazio obriga a escolher.
  const [payment, setPayment] = useState<CrmPaymentMethod | ''>('')
  const [date, setDate] = useState(() => nowSPDatetimeLocal().slice(0, 10))
  const [origem, setOrigem] = useState(initialContact?.origem ?? '')
  const [channel, setChannel] = useState(initialContact?.channel ?? '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const [origemOptions, setOrigemOptions] = useState<ComboOption[]>([])
  const [channelOptions, setChannelOptions] = useState<ComboOption[]>([])

  const searchRef = useRef<HTMLInputElement>(null)

  const conversionStage = stages.find((s) => s.is_conversion)
  // A venda saiu por um WhatsApp diferente do que está no cadastro escolhido.
  // Comparação pela chave do banco (069): "PH Creative" e "ph creative " são o
  // mesmo canal, e tratá-los como dois abriria cadastro à toa.
  const trocouDeCanal = !!contact && !!channel.trim()
    && channelKey(channel) !== channelKey(contact.channel)
  // Contato novo ou cliente que nunca comprou: esta venda é a que converte.
  const isFirstSale = contact === null || contact.sales_count === 0
  // Veio de anúncio por qualquer um dos caminhos (071): clique de
  // Click-to-WhatsApp, clique na landing ou a origem sendo digitada aqui.
  const fromAd = isAdContact(contact, origem)

  // Listas dos campos de escolha — as mesmas do painel do contato.
  useEffect(() => {
    crmService.listOrigens()
      .then((os) => setOrigemOptions(os.map((o) => ({
        value: o.origem,
        hint: `${o.contact_count} contato${o.contact_count === 1 ? '' : 's'}`,
      }))))
      .catch(() => setOrigemOptions([]))
    crmService.listChannels()
      .then((cs) => setChannelOptions(cs.map((c) => ({
        value: c.channel,
        hint: `${c.contact_count} contato${c.contact_count === 1 ? '' : 's'}`,
      }))))
      .catch(() => setChannelOptions([]))
  }, [])

  useEffect(() => { searchRef.current?.focus() }, [])

  // Esc fecha o painel — mesmo comportamento do drawer do contato.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Busca com debounce e piso de 2 caracteres, como a do funil: sem isso cada
  // tecla varreria a tabela de contatos.
  useEffect(() => {
    if (contact || creating) return
    const q = term.trim()
    if (q.length < 2) { setResults(null); setSearching(false); return }
    let alive = true
    setSearching(true)
    const timer = setTimeout(() => {
      crmService.searchContacts(q)
        .then((rows) => { if (alive) setResults(rows) })
        .catch((err) => {
          if (alive) toast.error(err instanceof Error ? err.message : 'Falha ao buscar contatos')
        })
        .finally(() => { if (alive) setSearching(false) })
    }, 300)
    return () => { alive = false; clearTimeout(timer) }
  }, [term, contact, creating])

  /** Escolher o cliente traz origem e canal dele para os campos da venda. */
  const choose = useCallback((c: CrmContact) => {
    setContact(c)
    setCreating(false)
    setOrigem(c.origem ?? '')
    setChannel(c.channel ?? '')
  }, [])

  /** Abre o cadastro novo já com o que foi digitado no lugar certo. */
  function startCreating() {
    const digits = normalizePhone(term)
    // Digitou um número: vira telefone e o nome fica para ele preencher.
    const isPhone = digits.length >= 8 && digits.length >= term.trim().length - 4
    setNewName(isPhone ? '' : term.trim())
    setNewPhone(isPhone ? digits : '')
    setCreating(true)
    setContact(null)
  }

  function backToSearch() {
    setCreating(false)
    setContact(null)
    setNewName('')
    setNewPhone('')
  }

  async function save() {
    const valueCents = parseBRL(value)
    const qtd = Math.max(0, Math.round(Number(creatives.replace(/\D/g, '')) || 0))

    if (!contact && !creating) {
      toast.error('Escolha o cliente desta venda')
      return
    }
    if (creating && !newName.trim()) {
      toast.error('Informe o nome do contato')
      return
    }
    if (valueCents <= 0) {
      toast.error('Informe o valor da venda')
      return
    }
    // Exigido no lançamento novo: informação que ninguém volta para preencher
    // depois, e sem ela o fechamento de caixa não fecha.
    if (!payment) {
      toast.error('Escolha a forma de pagamento')
      return
    }

    setBusy(true)
    try {
      let contactId: string
      let contactName: string
      // Esta venda é a primeira do cliente? Decide a mensagem e o que o n8n
      // recebe; quem confere de verdade é o banco, no webhook.
      let primeira: boolean
      let isNewContact = false

      if (!contact) {
        // Procura-e-cria no banco: o número digitado pode já existir — o
        // vendedor escreveu em vez de escolher na lista, ou uma automação
        // criou o cadastro no meio do caminho. Inserir direto criaria o
        // segundo cadastro do mesmo cliente NO MESMO CANAL, que é o que a
        // 069 proíbe.
        //
        // Com número, quem responde é a 080: se o cliente existe em outro
        // canal, ela abre o cadastro DESTE canal levando os dados de anúncio
        // junto, em vez de devolver o cadastro do canal errado. Sem número
        // não há identidade para comparar, e aí é a claim da 069 mesmo.
        // Nasce fora do funil: a venda logo abaixo é que o leva para a etapa
        // de conversão, pela trigger. Criá-lo já numa etapa só acrescentaria
        // uma movimentação que não aconteceu.
        const alvo = newPhone.trim()
          ? await crmService.contactForChannel({
            organizationId: profile!.organization_id,
            phone: newPhone.trim(),
            channel: channel.trim(),
            name: newName.trim(),
            stageId: null,
            origem: origem.trim(),
          })
          : { ...await crmService.claimContact({
            organizationId: profile!.organization_id,
            name: newName.trim(),
            phone: '',
            origem: origem.trim(),
            channel: channel.trim(),
            stageId: null,
          }), copiedFrom: null as string | null }

        isNewContact = alvo.created
        contactId = alvo.contactId

        if (alvo.created && !alvo.copiedFrom) {
          contactName = newName.trim()
          primeira = true
        } else {
          // Cadastro que já existia, ou cópia recém-aberta a partir do
          // cadastro de outro canal. Relê nos dois casos: é o banco que sabe
          // se este cliente já comprou, e "primeira compra" na mensagem é
          // decisão que não pode sair de um palpite da tela.
          const achado = await crmService.getContact(alvo.contactId)
          contactName = achado.name
          primeira = achado.sales_count === 0
          toast.info(alvo.copiedFrom
            ? `${achado.name} já tinha cadastro em outro canal — abrimos um para ${canalLabel(channel)} com os dados dele.`
            : `Este número já era de ${achado.name} — a venda foi lançada nesse cadastro.`)
        }
      } else if (trocouDeCanal && contact.phone) {
        // O CASO DA 080. A venda saiu por um WhatsApp diferente do que está no
        // cadastro. Trocar o canal do contato — o que esta tela fazia — move o
        // cliente inteiro de canal: o histórico do canal antigo passa a mentir
        // e, se o número já tiver cadastro no canal novo, o índice único da
        // 069 recusa a gravação e a venda nem entra.
        //
        // Um cadastro por canal, então: o do canal desta venda é procurado e,
        // faltando, aberto a partir deste aqui — com os dados de anúncio, que
        // é o que mantém a venda atribuível na Meta.
        const alvo = await crmService.contactForChannel({
          organizationId: profile!.organization_id,
          phone: contact.phone,
          channel: channel.trim(),
          name: contact.name,
          stageId: null,
          origem: origem.trim(),
        })
        isNewContact = alvo.created
        contactId = alvo.contactId

        if (alvo.contactId === contact.id) {
          // Cadastro cego que acabou de ganhar o nome do canal: continua sendo
          // o mesmo cliente, sem cópia nenhuma.
          contactName = contact.name
          primeira = contact.sales_count === 0
        } else {
          const achado = await crmService.getContact(alvo.contactId)
          contactName = achado.name
          primeira = achado.sales_count === 0
          toast.info(alvo.created
            ? `${contact.name} já era de outro canal — a venda foi para um cadastro novo em ${canalLabel(channel)}.`
            : `${contact.name} já tinha cadastro em ${canalLabel(channel)} — a venda foi lançada nele.`)
        }

        // Origem digitada agora vale no cadastro que recebeu a venda quando
        // ele ainda não tem uma; a 080 já grava isso. O que não fazemos mais é
        // reescrever o canal do contato escolhido.
      } else {
        contactId = contact.id
        contactName = contact.name
        primeira = contact.sales_count === 0
        const target = contact
        // Origem e canal escolhidos no lançamento passam a valer no cadastro.
        // Campo em branco não apaga o que o contato já tem — quem não mexeu
        // não quis limpar. O canal só chega aqui quando o contato não tem
        // número: sem identidade não há como abrir o cadastro do outro canal,
        // e mudar o campo é tudo o que dá para fazer.
        const patch: { origem?: string; channel?: string } = {}
        if (origem.trim() && origem.trim() !== (target.origem ?? '')) patch.origem = origem.trim()
        if (trocouDeCanal) patch.channel = channel.trim()
        // ANTES de inserir a venda, de propósito: é a entrada na etapa de
        // conversão que enfileira o evento da Meta (033), e ele carrega a
        // origem que estiver gravada no contato naquele instante.
        if (Object.keys(patch).length > 0) await crmService.updateContact(target.id, patch)
      }

      const today = nowSPDatetimeLocal().slice(0, 10)
      const sale = await crmService.addSale({
        contactId,
        creatives: qtd,
        valueCents,
        // Venda de hoje guarda a hora real. De outro dia, meio-dia em São
        // Paulo: o relatório agrupa por dia nesse fuso, e meio-dia nunca
        // escorrega para o dia vizinho na conversão para UTC.
        soldAt: date === today
          ? new Date().toISOString()
          : spWallTimeToUtcISO(`${date}T12:00`),
        note: note.trim(),
        paymentMethod: payment,
      })

      toast.success(
        primeira && conversionStage
          ? `Venda registrada — ${contactName} entrou em ${conversionStage.name}`
          : `Venda registrada para ${contactName}`,
      )

      // O aviso vem depois da venda e não a desfaz: a venda já está gravada, e
      // uma falha aqui é problema de integração, não de registro. Sempre
      // enviado, aqui e no painel do contato — é o que o rodapé promete.
      await avisarSistemasExternos(sale.id, { newContact: isNewContact })

      onSaved()
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Falha ao registrar a venda'
      toast.error(
        // Índice único do número por canal (069). Só chega aqui em corrida
        // com outro caminho de cadastro; a mensagem crua não ajudaria.
        msg.includes('idx_crm_contacts_numero_canal_unico')
          ? 'Este telefone já tem contato neste canal — busque por ele acima e lance a venda nele.'
          : msg,
      )
    } finally {
      setBusy(false)
    }
  }

  // Portal no body pelo mesmo motivo do drawer do contato: `position: fixed`
  // só se ancora na viewport fora de ancestrais com transform/filter.
  return createPortal(
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Lançar venda">
        <header className="drawer-head">
          <div>
            <h2>Lançar venda</h2>
            <p className="text-muted" style={{ fontSize: 12 }}>
              Escolha o cliente pelo nome ou pelo número
            </p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Fechar">
            <X size={17} />
          </button>
        </header>

        <div className="drawer-body">
          {/* ---------- Cliente ---------- */}
          <div className="field">
            <label>Cliente</label>

            {contact ? (
              <div className="sale-picked">
                <div className="sale-picked-info">
                  <p className="sale-picked-name">{contact.name}</p>
                  <p className="text-muted" style={{ fontSize: 11.5 }}>
                    {phoneLabel(contact.phone)}
                    {contact.channel ? ` · ${contact.channel}` : ''}
                    {contact.origem ? ` · ${contact.origem}` : ''}
                  </p>
                  <p className="text-muted" style={{ fontSize: 11.5 }}>
                    {contact.sales_count === 0
                      ? 'Nenhuma compra registrada'
                      : `${contact.sales_count} compra${contact.sales_count > 1 ? 's' : ''}`
                        + ` · ${formatBRL(contact.sales_total_cents)}`}
                    {' · desde '}
                    {formatSP(contact.created_at).slice(0, 10)}
                  </p>
                </div>
                <span className={`badge ${isFirstSale ? 'badge-blue' : 'badge-green'}`}>
                  {isFirstSale ? '1ª compra' : 'recompra'}
                </span>
                <button className="btn btn-ghost btn-sm" onClick={backToSearch} disabled={busy}>
                  Trocar
                </button>
              </div>
            ) : creating ? (
              <>
                <div className="sale-new-head">
                  <button className="btn btn-ghost btn-sm" onClick={backToSearch} disabled={busy}>
                    <ArrowLeft size={13} /> Voltar à busca
                  </button>
                  <span className="badge badge-blue">contato novo</span>
                </div>
                <div className="drawer-grid" style={{ marginTop: 8 }}>
                  <div className="field">
                    <label>Nome</label>
                    <input
                      className="input"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="Nome do cliente"
                    />
                  </div>
                  <div className="field">
                    <label>Telefone</label>
                    <input
                      className="input"
                      value={newPhone}
                      onChange={(e) => setNewPhone(e.target.value)}
                      placeholder="5511999999999"
                    />
                  </div>
                </div>
              </>
            ) : (
              <>
                <label className="crm-search crm-search-block">
                  <input
                    ref={searchRef}
                    value={term}
                    onChange={(e) => setTerm(e.target.value)}
                    placeholder="Nome ou número (com ou sem o 55)"
                    aria-label="Buscar contato"
                  />
                  <Search size={14} />
                </label>

                {searching && <p className="text-muted sale-pick-msg">Procurando…</p>}

                {results !== null && !searching && (
                  results.length === 0 ? (
                    <p className="text-muted sale-pick-msg">
                      Nenhum contato com “{term.trim()}”.
                    </p>
                  ) : (
                    <ul className="sale-pick-list">
                      {results.map((c) => (
                        <li key={c.id}>
                          <button type="button" onClick={() => choose(c)}>
                            <span className="sale-pick-main">
                              <span className="sale-pick-name">{c.name}</span>
                              <span className="text-muted" style={{ fontSize: 11.5 }}>
                                {phoneLabel(c.phone)}
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

                {/* Sempre à mão, não só quando a busca vem vazia: o cliente
                    novo pode ter um homônimo na base, e a lista acima é
                    justamente o que deixa isso à vista antes de duplicar. */}
                {canEditContacts ? (
                  term.trim().length >= 2 && !searching && (
                    <button className="btn btn-ghost btn-sm sale-create-btn" onClick={startCreating}>
                      <UserPlus size={14} /> Criar contato “{term.trim()}”
                    </button>
                  )
                ) : (
                  <p className="text-muted sale-pick-msg">
                    Seu usuário não pode criar contatos — escolha um já cadastrado.
                  </p>
                )}
              </>
            )}
          </div>

          {/* ---------- A venda ---------- */}
          <div className="drawer-grid">
            <div className="field">
              <label>Valor vendido</label>
              <input
                className="input"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onBlur={() => setValue(value.trim() ? formatBRL(parseBRL(value)) : '')}
                placeholder="R$ 0,00"
              />
            </div>
            <div className="field">
              <label>Criativos</label>
              <input
                className="input"
                inputMode="numeric"
                value={creatives}
                onChange={(e) => setCreatives(e.target.value.replace(/\D/g, ''))}
                placeholder="0"
              />
            </div>
          </div>

          {/* Data e pagamento andam com valor e criativos: são os campos do
              dinheiro. Origem e canal, abaixo, são os da atribuição. */}
          <div className="drawer-grid">
            <div className="field">
              <label>Data da venda</label>
              <input
                className="input"
                type="date"
                value={date}
                max={nowSPDatetimeLocal().slice(0, 10)}
                onChange={(e) => e.target.value && setDate(e.target.value)}
              />
            </div>
            <div className="field">
              <label>Forma de pagamento</label>
              <select
                className="input"
                value={payment}
                onChange={(e) => setPayment(e.target.value as CrmPaymentMethod | '')}
              >
                <option value="">Escolha…</option>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="drawer-grid">
            <div className="field">
              <label>Origem</label>
              <Combobox
                value={origem}
                onChange={setOrigem}
                options={origemOptions}
                ariaLabel="Origem"
                placeholder="Escolha ou digite uma nova"
              />
            </div>
            <div className="field">
              <label>Canal</label>
              <Combobox
                value={channel}
                onChange={setChannel}
                options={channelOptions}
                ariaLabel="Canal"
                placeholder="De qual WhatsApp veio"
              />
            </div>
          </div>

          {/* O que muda no cadastro do contato escolhido. Só aparece quando há
              mudança de verdade: aviso que aparece sempre ninguém lê. */}
          {contact && !trocouDeCanal && origem.trim() && origem.trim() !== (contact.origem ?? '') && (
            <p className="text-muted sale-hint" style={{ marginTop: -4 }}>
              {contact.origem
                ? `A origem do contato passa de “${contact.origem}” para “${origem.trim()}”.`
                : `O contato passa a ter origem “${origem.trim()}”.`}
            </p>
          )}
          {contact && trocouDeCanal && (
            <p className="text-muted sale-hint">
              {!contact.phone
                // Sem número não há como reconhecer o cliente no outro canal:
                // o campo do cadastro é tudo o que dá para mudar.
                ? (contact.channel
                  ? `O canal do contato passa de “${contact.channel}” para “${channel.trim()}”.`
                  : `O contato passa a ter canal “${channel.trim()}”.`)
                : !contact.channel
                  ? `O cadastro passa a ser do canal “${channel.trim()}” — ele ainda não tinha canal.`
                  : `A venda vai para o cadastro deste cliente em “${channel.trim()}”. Se ainda não `
                    + `existir, abrimos um agora com os dados de anúncio deste — e o cadastro em `
                    + `“${contact.channel}” fica como está.`}
            </p>
          )}

          <div className="field">
            <label>Observação</label>
            <input
              className="input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Opcional — o que foi vendido, condição, etc."
            />
          </div>

          {/* O que vai acontecer ao salvar. Mesma regra do painel do contato,
              dita antes do clique em vez de depois. */}
          <p className="text-muted sale-outcome">
            {isFirstSale
              ? conversionStage
                ? `1ª compra do cliente: o contato vai para “${conversionStage.name}”`
                  + (fromAd
                    ? ' e a Meta é avisada da venda.'
                    : '. Como o contato não veio de anúncio, a Meta não é avisada.')
                : 'Nenhuma etapa está marcada como conversão: a venda fica registrada, mas o contato não entra no funil.'
              // Desde a 072 cada venda tem seu próprio evento: recompra de
              // cliente de anúncio também é avisada.
              : fromAd
                ? 'Recompra: não move o contato de etapa, mas a Meta é avisada desta venda também — cliente de anúncio manda toda compra, não só a primeira.'
                : 'Recompra: fica registrada no cliente, não move o contato de etapa e não avisa a Meta.'}
          </p>
        </div>

        <footer className="drawer-foot">
          <div className="flex" style={{ marginLeft: 'auto', gap: 8 }}>
            <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancelar</button>
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              <Receipt size={15} /> {busy ? 'Salvando…' : 'Lançar venda'}
            </button>
          </div>
        </footer>
      </aside>
    </>,
    document.body,
  )
}
