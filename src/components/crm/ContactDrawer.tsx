import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRightLeft, Trash2, History, Merge, MessageCirclePlus, Pencil, Plus, Receipt, RotateCcw, Save, Undo2, X } from 'lucide-react'
import { useConversaStore } from '@/store/conversaStore'
import { Combobox, type ComboOption } from './Combobox'
import { TagInput } from './TagInput'
import { MergeContactsDialog } from './MergeContactsDialog'
import { MoveSalesChannelDialog } from './MoveSalesChannelDialog'
import { RefundDetailDialog, refundTargetFromDetail } from './RefundDetailDialog'
import { RefundEditDialog, type RefundTarget } from './RefundEditDialog'
import { DateInput, Modal } from '../ui'
import {
  canalLabel, channelKey, crmService, formatBRL, hasAdClick, isAdOrigem, parseBRL, paymentLabel,
  PAYMENT_METHODS, STAGE_COLORS,
} from '@/services/crmService'
import { useAuthStore, useCan } from '@/store/authStore'
import { toast } from '@/store/toastStore'
import { confirmDialog } from '@/store/confirmStore'
import {
  formatSP, nowSPDatetimeLocal, spDatetimeLocal, spWallTimeToUtcISO,
} from '@/lib/datetime'
import type {
  CrmContact, CrmMergeResult, CrmPaymentMethod, CrmSale, CrmStage, CrmStageHistory,
} from '@/types'

const SOURCE_LABEL: Record<string, string> = {
  ui: 'pelo painel',
  api: 'por automação',
  system: 'pelo sistema',
}

/**
 * O que dizer depois de unificar dois cadastros (077).
 *
 * Serve os dois caminhos que fundem daqui: o botão "Unificar" e a troca de
 * canal que esbarrou no cadastro do canal de destino.
 */
function resumoFusao(r: CrmMergeResult): string[] {
  const partes: string[] = [
    r.sales_moved > 0
      ? `${r.sales_moved} venda${r.sales_moved === 1 ? '' : 's'} agora em "${r.survivor_name}"`
      : `Cadastros unificados em "${r.survivor_name}"`,
  ]
  // Os dois lados da regra da Meta, ditos só quando existem: o que entrou na
  // fila e o que não vai ser reenviado porque já chegou lá.
  if (r.conversions_queued > 0) {
    partes.push(
      r.conversions_queued === 1
        ? '1 conversão na fila para a Meta'
        : `${r.conversions_queued} conversões na fila para a Meta`,
    )
  }
  if (r.events_already_sent > 0) {
    partes.push(
      r.events_already_sent === 1
        ? '1 já enviada antes, sem reenvio'
        : `${r.events_already_sent} já enviadas antes, sem reenvio`,
    )
  }
  return partes
}

/**
 * Painel lateral do contato: edição completa + histórico de movimentações.
 *
 * Recebe `contact === null` para criar um contato novo. O formulário é o
 * mesmo nos dois casos — só muda o que acontece ao salvar.
 */
export function ContactDrawer({ contact, stages, onClose, onSaved }: {
  contact: CrmContact | null
  stages: CrmStage[]
  onClose: () => void
  onSaved: () => void
}) {
  const canConversa = useCan()
  // Iniciar conversa (126): para quem atende.
  const podeConversar = canConversa('atendimento.ver') || canConversa('atendimento.ver_todas')
  const pedirConversa = useConversaStore((st) => st.pedir)
  const profile = useAuthStore((s) => s.profile)
  const isNew = contact === null

  const [name, setName] = useState(contact?.name ?? '')
  const [email, setEmail] = useState(contact?.email ?? '')
  const [phone, setPhone] = useState(contact?.phone ?? '')
  const [channel, setChannel] = useState(contact?.channel ?? '')
  const [sourceId, setSourceId] = useState(contact?.source_id ?? '')
  const [origem, setOrigem] = useState(contact?.origem ?? '')
  // '' = fora do funil (contato existe, mas não ocupa coluna no kanban)
  const [stageId, setStageId] = useState(contact?.stage_id ?? '')
  // Etapa que está gravada no banco. Não dá para ler de `contact`: o prop não
  // é recarregado, e registrar a 1ª venda muda a etapa por trigger.
  const [savedStageId, setSavedStageId] = useState(contact?.stage_id ?? '')
  // Motivo da perda (139): pedido ao mover para uma etapa de perdidos.
  const [lostReason, setLostReason] = useState('')
  const [lostOptions, setLostOptions] = useState<string[]>([])
  useEffect(() => { crmService.getLostReasons().then(setLostOptions).catch(() => {}) }, [])

  // Ocultos no drawer, mas preservados: mantidos como valor do contato para
  // que salvar não os apague. São preenchidos pelas automações/API, não pela
  // interface — por isso não têm campo de edição aqui.
  const conversationId = contact?.conversation_id ?? ''
  const ctwaclid = contact?.ctwaclid ?? ''
  const description = contact?.description ?? ''

  // Etiquetas: exibidas e editáveis como chips. Também aparecem no card do kanban.
  const [tags, setTags] = useState<string[]>(contact?.tags ?? [])

  // Listas dos campos de escolha. Carregadas aqui, e não recebidas por
  // prop, porque o drawer abre de três telas (funil, contatos, relatórios) e
  // só uma delas tinha esses dados em mãos. Falha na consulta = campo vira
  // texto livre puro, que é o comportamento antigo — nada trava.
  const [channelOptions, setChannelOptions] = useState<ComboOption[]>([])
  const [origemOptions, setOrigemOptions] = useState<ComboOption[]>([])
  const [tagOptions, setTagOptions] = useState<string[]>([])

  const [history, setHistory] = useState<CrmStageHistory[] | null>(null)
  const [busy, setBusy] = useState(false)

  // Vendas do cliente. A primeira da lista é a que virou conversão e moveu
  // o contato de etapa; as seguintes são recompras, que ficam registradas
  // sem mexer no funil — mas cada uma tem seu evento na Meta quando o
  // cliente veio de anúncio (regras no banco, 031/072).
  const [sales, setSales] = useState<CrmSale[] | null>(null)
  const [saleValue, setSaleValue] = useState('')
  // Vazio obriga a escolher: chutar "Pix" faria a maioria das vendas nascer
  // com a forma errada sem ninguém perceber.
  const [salePayment, setSalePayment] = useState<CrmPaymentMethod | ''>('')
  const [saleDate, setSaleDate] = useState(() => nowSPDatetimeLocal().slice(0, 10))
  const [savingSale, setSavingSale] = useState(false)
  /** Venda cuja lixeira foi clicada: abre a escolha excluir × reembolso. */
  const [removendo, setRemovendo] = useState<CrmSale | null>(null)
  /**
   * Venda no formulário de reembolso — marcar, ou editar valor, nota e
   * anexos (102/103). O formulário é o RefundEditDialog, o mesmo do relatório.
   */
  const [reembolsando, setReembolsando] = useState<RefundTarget | null>(null)
  /** Venda cujo selo de reembolso foi clicado: abre o card com nota e anexos. */
  const [detalheReembolso, setDetalheReembolso] = useState<string | null>(null)

  // Unificação de cadastros (077). Só admin — a operação apaga um contato e
  // mexe no que já foi para a Meta.
  const [merging, setMerging] = useState(false)

  /**
   * Escolha de quais vendas mudam de canal (089).
   *
   * `canalFixo` preenchido = veio da troca do campo Canal, e o destino já
   * está decidido. Vazio = veio do botão da lista de vendas, e o canal é
   * escolhido lá dentro.
   */
  const [moverVendas, setMoverVendas] = useState<{ canalFixo?: string } | null>(null)
  const isAdmin = profile?.role === 'admin'

  // Edição em linha de uma venda já registrada. null = ninguém editando.
  const [editingSale, setEditingSale] = useState<string | null>(null)
  const [editDate, setEditDate] = useState('')
  const [editValue, setEditValue] = useState('')
  // Na edição o vazio é permitido: venda antiga (anterior à 070) não tem forma
  // de pagamento, e corrigir o valor dela não pode exigir inventar uma.
  const [editPayment, setEditPayment] = useState<CrmPaymentMethod | ''>('')

  const conversionStage = stages.find((s) => s.is_conversion)
  const hasSales = (sales?.length ?? 0) > 0
  // Só conversão de anúncio vai para a Meta (032/033), por um de dois
  // caminhos. Usa a origem sendo digitada, não a salva: assim a dica muda
  // junto com o campo e a pessoa vê o efeito antes de salvar.
  // Clique guardado = a Meta sabe de qual anúncio a venda veio. Vale para os
  // dois funis: Click-to-WhatsApp (ctwaclid) e landing page (fbc, 071). Lê do
  // contato salvo porque nenhum dos dois tem campo aqui — quem preenche é a
  // automação.
  const hasClick = hasAdClick(contact)
  const adByOrigem = isAdOrigem(origem)
  const fromAd = hasClick || adByOrigem

  const stageById = useCallback(
    (id: string | null) => stages.find((s) => s.id === id),
    [stages],
  )

  // Já passou por etapa de conversão alguma vez? Mesma definição do banco
  // (crm_has_converted): olha o histórico, não a etapa atual — quem foi
  // arquivado pela rotina dos 5 dias continua contando como convertido.
  const hasConverted = (history ?? []).some((h) => stageById(h.to_stage_id)?.is_conversion)
  // Marcar a origem como anúncio agora vai enfileirar a conversão ao salvar.
  const willEnqueueByOrigem = !isNew && hasConverted && adByOrigem && !hasClick
    && !isAdOrigem(contact.origem)

  // Quem já ocupa (número, canal) enquanto o campo é digitado. O 409 do
  // índice único (069) continua sendo a trava de verdade — isto só faz o
  // aviso chegar ANTES do Salvar, e não como erro depois dele.
  const [conflitoDeCanal, setConflitoDeCanal] = useState<{
    id: string
    name: string
    salesCount: number
  } | null>(null)

  useEffect(() => {
    const numero = phone.trim()
    // Canal igual ao que já está gravado não conflita com nada: o cadastro
    // que ocupa aquele canal é ele mesmo. No cadastro novo não há canal
    // gravado, e o canal em branco também é uma chave do índice — por isso a
    // consulta vale mesmo com o campo vazio.
    if (!numero || (!isNew && channelKey(channel) === channelKey(contact?.channel))) {
      setConflitoDeCanal(null)
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      crmService.channelConflict(numero, channel.trim(), contact?.id)
        .then((c) => { if (alive) setConflitoDeCanal(c) })
        // Falha de consulta não vira aviso: quem barra de verdade é o banco.
        .catch(() => { if (alive) setConflitoDeCanal(null) })
    }, 400)
    return () => { alive = false; clearTimeout(timer) }
  }, [phone, channel, contact, isNew])

  const loadSales = useCallback(async (id: string) => {
    try {
      setSales(await crmService.listSales(id))
    } catch {
      setSales([])
    }
  }, [])

  // Histórico e vendas só fazem sentido para contato existente.
  useEffect(() => {
    if (!contact) return
    crmService.listHistory(contact.id)
      .then(setHistory)
      .catch(() => setHistory([]))
    loadSales(contact.id)
  }, [contact, loadSales])

  // Canais, origens e etiquetas já em uso: alimentam as listas dos campos.
  useEffect(() => {
    crmService.listChannels()
      .then((cs) => setChannelOptions(cs.map((c) => ({
        value: c.channel,
        hint: `${c.contact_count} contato${c.contact_count === 1 ? '' : 's'}`,
      }))))
      .catch(() => setChannelOptions([]))
    crmService.listOrigens()
      .then((os) => setOrigemOptions(os.map((o) => ({
        value: o.origem,
        hint: `${o.contact_count} contato${o.contact_count === 1 ? '' : 's'}`,
      }))))
      .catch(() => setOrigemOptions([]))
    crmService.listTags().then(setTagOptions).catch(() => setTagOptions([]))
  }, [])

  // Esc fecha o painel — comportamento esperado de drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /**
   * Depois de mexer nas vendas o contato mudou no banco: a primeira venda
   * pode tê-lo movido para a etapa de conversão. Relê a etapa para o
   * formulário não desfazer isso ao salvar.
   */
  async function syncAfterSale(id: string) {
    await loadSales(id)
    try {
      const fresh = await crmService.getContact(id)
      setStageId(fresh.stage_id ?? '')
      setSavedStageId(fresh.stage_id ?? '')
    } catch {
      // A lista de vendas já está atualizada; a etapa aparece no próximo
      // carregamento do funil.
    }
    onSaved()
  }

  /** true = venda gravada. Validação ou falha já viram aviso na tela. */
  async function addSale(): Promise<boolean> {
    if (!contact) return false
    const valueCents = parseBRL(saleValue)
    if (valueCents <= 0) {
      toast.error('Informe o valor da venda')
      return false
    }
    if (!salePayment) {
      toast.error('Escolha a forma de pagamento')
      return false
    }
    const isFirst = !hasSales

    setSavingSale(true)
    try {
      const today = nowSPDatetimeLocal().slice(0, 10)
      await crmService.addSale({
        contactId: contact.id,
        valueCents,
        // Venda de hoje guarda a hora real. De outro dia, meio-dia em São
        // Paulo: o relatório agrupa por dia nesse fuso, e meio-dia nunca
        // escorrega para o dia anterior/seguinte na conversão para UTC.
        soldAt: saleDate === today
          ? new Date().toISOString()
          : spWallTimeToUtcISO(`${saleDate}T12:00`),
        paymentMethod: salePayment,
      })
      toast.success(
        isFirst && conversionStage
          ? `Venda registrada. Contato movido para ${conversionStage.name}`
          : 'Venda registrada',
      )
      setSaleValue('')
      setSaleDate(today)
      setSalePayment('')
      await syncAfterSale(contact.id)
      return true
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao registrar a venda')
      return false
    } finally {
      setSavingSale(false)
    }
  }

  function startEdit(sale: CrmSale) {
    setEditingSale(sale.id)
    // A data vem do instante gravado, lida no fuso de São Paulo — senão uma
    // venda das 21h viraria o dia seguinte no campo.
    setEditDate(spDatetimeLocal(sale.sold_at).slice(0, 10))
    setEditValue(formatBRL(sale.value_cents))
    setEditPayment(sale.payment_method ?? '')
  }

  function cancelEdit() {
    setEditingSale(null)
  }

  /**
   * Salva a edição. Não gera evento novo na Meta em hipótese nenhuma; se a
   * conversão deste contato ainda estiver na fila, o valor corrigido vai
   * junto quando ela sair (migration 042).
   */
  async function saveSale() {
    if (!contact || !editingSale) return
    const valueCents = parseBRL(editValue)
    if (valueCents <= 0) {
      toast.error('Informe o valor da venda')
      return
    }
    const original = sales?.find((s) => s.id === editingSale)
    const originalDate = original ? spDatetimeLocal(original.sold_at).slice(0, 10) : ''

    setSavingSale(true)
    try {
      await crmService.updateSale(editingSale, {
        valueCents,
        // '' vira null: é o jeito de dizer "não informada" numa venda antiga.
        paymentMethod: editPayment || null,
        // Data intocada mantém a hora original: mexer nela sem necessidade
        // mudaria a ordem das vendas e, com isso, qual delas é a primeira.
        ...(editDate && editDate !== originalDate
          ? { soldAt: spWallTimeToUtcISO(`${editDate}T12:00`) }
          : {}),
      })
      toast.success('Venda atualizada')
      setEditingSale(null)
      await syncAfterSale(contact.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao atualizar a venda')
    } finally {
      setSavingSale(false)
    }
  }

  /**
   * A lixeira pergunta o que fazer (101): excluir de verdade — a venda some —
   * ou só marcar como reembolso, e a venda fica, descontando no líquido do
   * relatório.
   * Marcar e editar o reembolso é com o RefundEditDialog; aqui fica excluir
   * e o desfazer da lixeira.
   */
  async function removeSale(
    sale: CrmSale,
    modo: 'excluir' | 'desfazer',
  ) {
    if (!contact) return
    setRemovendo(null)
    setReembolsando(null)
    setSavingSale(true)
    try {
      if (modo === 'excluir') {
        await crmService.deleteSale(sale.id)
        toast.success('Venda excluída')
      } else {
        await crmService.setSaleRefunded(sale.id, false)
        toast.success('Reembolso desfeito')
      }
      await syncAfterSale(contact.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao alterar a venda')
    } finally {
      setSavingSale(false)
    }
  }

  /** Abre o formulário de reembolso (valor, nota e anexos). */
  function askRefund(sale: RefundTarget) {
    setRemovendo(null)
    setDetalheReembolso(null)
    setReembolsando(sale)
  }

  /**
   * Desfazer confirma antes porque perde a data original — remarcar grava a
   * de hoje, e é ela que define o período do líquido. Para só corrigir o
   * valor existe o RefundEditDialog, que mantém a data (102).
   */
  async function undoRefund(sale: CrmSale) {
    if (!sale.refunded_at) return
    setReembolsando(null)
    setRemovendo(null)
    const ok = await confirmDialog({
      title: 'Desfazer reembolso',
      message: `Venda de ${formatBRL(sale.value_cents)} em ${formatSP(sale.sold_at)}.\n`
        + `${sale.refunded_cents != null ? `${formatBRL(sale.refunded_cents)} reembolsados` : 'Reembolsada'} em ${formatSP(sale.refunded_at)}. `
        + 'O valor volta para o líquido do relatório. A nota e os anexos ficam guardados '
        + 'e voltam se a venda for marcada de novo.',
      confirmLabel: 'Desfazer reembolso',
    })
    if (!ok) return
    await removeSale(sale, 'desfazer')
  }

  /**
   * Só o que mudou em relação ao cadastro que abriu o drawer.
   *
   * Existe para o retry depois da unificação: a fusão (077) acabou de subir
   * e-mail, origem, etiquetas e clique do cadastro que saiu, e reenviar o
   * formulário inteiro regravaria os valores antigos por cima justamente do
   * que ela juntou. Fora desse caminho o salvamento continua mandando tudo.
   */
  function patchDoQueMudou(base: CrmContact) {
    const p: Parameters<typeof crmService.updateContact>[1] = {}
    if (name.trim() !== base.name) p.name = name.trim()
    if (email.trim() !== (base.email ?? '')) p.email = email.trim()
    if (phone.trim() !== (base.phone ?? '')) p.phone = phone.trim()
    if (channel.trim() !== (base.channel ?? '')) p.channel = channel.trim()
    if (sourceId.trim() !== (base.source_id ?? '')) p.sourceId = sourceId.trim()
    if (origem.trim() !== (base.origem ?? '')) p.origem = origem.trim()
    if ((stageId || null) !== (base.stage_id ?? null)) p.stageId = stageId || null
    if (tags.join('\u0000') !== (base.tags ?? []).join('\u0000')) p.tags = tags
    return p
  }

  /**
   * A troca de canal esbarrou em quem já ocupa (número, canal) — o índice
   * único da 069.
   *
   * Não há o que "forçar": dois cadastros do mesmo número no mesmo canal é
   * exatamente o que aquele índice existe para impedir, e passar por cima
   * traria de volta o cliente dividido em dois que a 069 veio consertar. O
   * que resolve é juntar os dois, e é o que se oferece aqui — este cadastro
   * fica, o outro sobe para dentro dele e some, e aí o canal está livre.
   *
   * 'salvo'   = fundiu, regravou e o drawer pode fechar;
   * 'avisado' = já disse na tela o que houve (sem permissão, ou desistiu);
   * 'nada'    = não há o que oferecer, quem chamou mostra a mensagem seca.
   */
  async function unificarParaTrocarDeCanal(base: CrmContact): Promise<'salvo' | 'avisado' | 'nada'> {
    const numero = phone.trim() || (base.phone ?? '')
    const outro = numero
      ? await crmService.channelConflict(numero, channel.trim(), base.id)
      : null
    // Sem saber de quem é o cadastro do outro lado (ou porque a RLS o esconde
    // deste usuário) não dá para propor fusão nenhuma: cai na mensagem seca.
    if (!outro) return 'nada'

    if (!isAdmin) {
      toast.error(
        `Já existe outro cadastro deste telefone em ${canalLabel(channel)}: “${outro.name}”. `
        + 'Só um administrador pode unificar os dois.',
      )
      return 'avisado'
    }

    const ok = await confirmDialog({
      title: 'Unificar para trocar de canal',
      message: `“${outro.name}” já é o cadastro deste telefone em ${canalLabel(channel)}`
        + (outro.salesCount > 0
          ? `, com ${outro.salesCount} venda${outro.salesCount === 1 ? '' : 's'}.`
          : ', sem vendas.')
        + `\n\nUnificar os dois? “${base.name}” é quem fica: as vendas, as conversões já `
        + 'enviadas à Meta e os campos que faltarem sobem para ele, o outro cadastro é apagado e '
        + `o canal passa a ser ${canalLabel(channel)}.`,
      confirmLabel: 'Unificar e salvar',
      danger: true,
    })
    if (!ok) return 'avisado'

    const r = await crmService.mergeContacts(base.id, outro.id)
    const mudou = patchDoQueMudou(base)
    if (Object.keys(mudou).length > 0) await crmService.updateContact(base.id, mudou)
    toast.success([...resumoFusao(r), `canal agora é ${canalLabel(channel)}`].join(' · '))
    return 'salvo'
  }

  /**
   * `jaEscolheu` = a tela de escolher vendas já rodou e o usuário decidiu que
   * TODAS mudam de dono. Sem ela, salvar entraria de novo na mesma pergunta.
   */
  async function save(jaEscolheu = false) {
    if (!name.trim()) {
      toast.error('Informe o nome do contato')
      return
    }
    if (!isNew && stageById(stageId)?.is_lost && stageId !== savedStageId && !lostReason.trim()) {
      toast.error('Informe o motivo da perda')
      return
    }
    setBusy(true)
    try {
      // VENDA PREENCHIDA E NÃO REGISTRADA. Quem muda a etapa para a conversão
      // e digita o valor costuma clicar neste Salvar, não no "Registrar" da
      // seção de vendas. Sem isto o formulário da venda era descartado: o
      // contato entrava na conversão sem venda — valor zero e Purchase de R$ 0
      // para a Meta. Registra antes de salvar o
      // contato, que é a ordem do botão Registrar.
      let stageFinal = stageId
      if (!isNew && saleValue.trim()) {
        const mexeuNaEtapa = stageId !== savedStageId
        if (!(await addSale())) return
        // A venda pode ter movido o contato para a conversão (031). Se a
        // etapa não foi mexida no formulário, a que vale é a do banco —
        // gravar a do formulário tiraria o contato de lá.
        if (!mexeuNaEtapa) stageFinal = (await crmService.getContact(contact.id)).stage_id ?? ''
      }

      // O valor do contato não sai daqui: ele vem das vendas, pela trigger.
      if (isNew) {
        const criado = await crmService.createContact({
          organizationId: profile!.organization_id,
          stageId: stageId || null,
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          conversationId: conversationId.trim(),
          channel: channel.trim(),
          ctwaclid: ctwaclid.trim(),
          sourceId: sourceId.trim(),
          origem: origem.trim(),
          tags,
          description: description.trim(),
        })

        // O ANÚNCIO DO CLIENTE NO OUTRO CANAL (081). É um cadastro por canal
        // (069): o mesmo cliente pode já existir no outro WhatsApp com o
        // clique do anúncio guardado. Sem isto o cadastro aberto aqui nasce
        // sem atribuição, e a venda que sair dele não chega à Meta ligada ao
        // anúncio que trouxe o cliente. A regra mora no banco e se guarda
        // sozinha — com um ID de origem digitado acima, nada é copiado.
        let herdouDe: string | null = null
        try {
          herdouDe = await crmService.inheritAds(criado.id)
        } catch {
          // O contato existe, que era o pedido. A atribuição herdada é
          // conserto e pode ser refeita depois; o que não pode é o
          // salvamento parecer ter falhado.
          toast.error('Contato criado, mas os dados de anúncio do outro canal não foram copiados')
          onSaved()
          onClose()
          return
        }
        toast.success(herdouDe
          ? 'Contato criado com os dados de anúncio do cadastro deste cliente em outro canal'
          : 'Contato criado')
      } else {
        // TROCA DE CANAL COM MAIS DE UMA VENDA (089). Salvar aqui arrastaria
        // todas de uma vez, e o cliente pode ter comprado só uma delas pelo
        // outro número. Pergunta quais vão antes de mexer em coisa alguma —
        // com uma venda só não há o que perguntar, e o fluxo segue igual.
        if (!jaEscolheu
            && channelKey(channel) !== channelKey(contact.channel)
            && (sales?.length ?? 0) > 1) {
          setBusy(false)
          setMoverVendas({ canalFixo: channel.trim() })
          return
        }

        await crmService.updateContact(contact.id, {
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          conversationId: conversationId.trim(),
          channel: channel.trim(),
          ctwaclid: ctwaclid.trim(),
          sourceId: sourceId.trim(),
          origem: origem.trim(),
          tags,
          description: description.trim(),
          stageId: stageFinal || null,
        })
        // Motivo da perda: o gatilho já marcou a data ao entrar na etapa.
        if (stageById(stageFinal)?.is_lost && stageFinal !== savedStageId && lostReason.trim()) {
          await crmService.setLostReason(contact.id, lostReason.trim())
        }
        toast.success('Contato atualizado')
      }
      onSaved()
      onClose()
    } catch (err) {
      // Índices únicos: a mensagem crua do Postgres não ajuda ninguém. São
      // dois, e dizem coisas diferentes — o do número (069) é o que aparece
      // quando alguém cadastra à mão um cliente que já existe naquele canal
      // e, editando, quando o canal escolhido é justamente o canal onde o
      // número já tem outro cadastro. Aí o caminho não é procurar: é juntar
      // os dois em Unificar, no rodapé (só admin, como a 077 exige).
      const msg = err instanceof Error ? err.message : 'Falha ao salvar'

      // Troca de canal barrada por quem já ocupa aquele canal: em vez de
      // devolver o índice único na cara do usuário, oferece a saída.
      if (!isNew && contact && msg.includes('idx_crm_contacts_numero_canal_unico')) {
        try {
          const saida = await unificarParaTrocarDeCanal(contact)
          if (saida === 'salvo') {
            onSaved()
            onClose()
            return
          }
          if (saida === 'avisado') return
        } catch (e2) {
          toast.error(e2 instanceof Error ? e2.message : 'Falha ao unificar os cadastros')
          return
        }
      }

      toast.error(
        msg.includes('idx_crm_contacts_numero_canal_unico')
          ? isNew
            ? 'Já existe um contato com este telefone neste canal. Procure por ele em Contatos.'
            : `Já existe outro contato com este telefone ${channel.trim() ? `em ${canalLabel(channel)}` : 'sem canal preenchido'}. `
              + (isAdmin
                ? 'Use “Unificar”, aqui embaixo, para juntar os dois cadastros num só.'
                : 'Peça a um administrador para unificar os dois cadastros.')
          : msg.includes('idx_crm_contacts_conversation') || msg.includes('duplicate key')
            ? 'Já existe um contato com este ID de conversa'
            : msg,
      )
    } finally {
      setBusy(false)
    }
  }

  /**
   * Voltou da unificação (077).
   *
   * O drawer FECHA nos dois casos, inclusive quando o contato aberto foi o
   * que ficou — e isso não é preguiça. O formulário guarda os campos como
   * estavam quando ele abriu, e o sobrevivente acabou de receber e-mail,
   * origem, etiquetas e clique do outro lado. Deixar a tela aberta convidaria
   * um "Salvar" a regravar os valores antigos por cima do que a fusão juntou.
   */
  function afterMerge(r: CrmMergeResult) {
    setMerging(false)
    toast.success(resumoFusao(r).join(' · '))
    onSaved()
    onClose()
  }

  async function remove() {
    if (!contact) return
    const ok = await confirmDialog({
      title: 'Excluir contato',
      message: `Excluir "${contact.name}"? O histórico de movimentações também será removido.`,
      confirmLabel: 'Excluir',
      danger: true,
    })
    if (!ok) return

    setBusy(true)
    try {
      await crmService.deleteContact(contact.id)
      toast.success('Contato excluído')
      onSaved()
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao excluir')
    } finally {
      setBusy(false)
    }
  }

  const currentStage = stageById(stageId)

  // Portal no body, como o Modal (ui.tsx): o drawer é `position: fixed` e
  // precisa se ancorar na VIEWPORT. Renderizado na árvore, bastava um
  // ancestral com transform/filter — .crm-main tinha, por causa da animação de
  // entrada — para ele se ancorar no container que rola e sumir para cima em
  // telas longas. A animação já foi corrigida; o portal é o que garante que
  // nenhum ancestral futuro reintroduza o problema.
  return createPortal(
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={isNew ? 'Novo contato' : contact.name}>
        <header className="drawer-head">
          <div>
            <h2>{isNew ? 'Novo contato' : contact.name}</h2>
            {!isNew && (
              <p className="text-muted" style={{ fontSize: 12 }}>
                Criado em {formatSP(contact.created_at)}
              </p>
            )}
          </div>
          <div className="flex" style={{ gap: 6 }}>
            {!isNew && contact.phone && podeConversar && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => pedirConversa({ id: contact.id, name: contact.name, phone: contact.phone })}
                title="Iniciar conversa no WhatsApp"
              >
                <MessageCirclePlus size={14} /> Conversar
              </button>
            )}
            <button className="icon-btn" onClick={onClose} aria-label="Fechar">
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="drawer-body">
          <div className="field">
            <label>Nome</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome do contato" />
          </div>

          <div className="drawer-grid">
            <div className="field">
              <label>Email</label>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@exemplo.com" />
            </div>
            <div className="field">
              <label>Telefone</label>
              <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="5511999999999" />
            </div>
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
            {conflitoDeCanal && (
              <p className="text-muted" style={{ fontSize: 11, marginTop: 4 }}>
                “{conflitoDeCanal.name}” já é o cadastro deste telefone em {canalLabel(channel)}
                {conflitoDeCanal.salesCount > 0
                  ? `, com ${conflitoDeCanal.salesCount} venda${conflitoDeCanal.salesCount === 1 ? '' : 's'}.`
                  : '.'}
                {' '}
                {isNew
                  ? 'Salve neste canal e você fica com dois cadastros do mesmo cliente. Melhor lançar no que já existe.'
                  : isAdmin
                    ? 'Ao salvar, os dois serão unificados num só (com sua confirmação).'
                    : 'Só um administrador pode unificar os dois cadastros.'}
              </p>
            )}
          </div>

          <div className="drawer-grid">
            <div className="field">
              <label>Origem</label>
              {/* Lista as origens já usadas (crm_origens, 038) e aceita uma
                  nova digitada — mesmo comportamento do campo Canal. */}
              <Combobox
                value={origem}
                onChange={setOrigem}
                options={origemOptions}
                ariaLabel="Origem"
                placeholder="Escolha ou digite uma nova"
              />
              {willEnqueueByOrigem && (
                <p className="text-muted" style={{ fontSize: 11, marginTop: 4 }}>
                  Origem de anúncio: ao salvar, a Meta é avisada desta venda. Como não
                  há clique de anúncio registrado, ela não vai saber de qual anúncio veio.
                </p>
              )}
            </div>
            <div className="field">
              <label>ID da origem</label>
              <input
                className="input mono"
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
                placeholder="Campanha / anúncio / formulário"
              />
            </div>
          </div>

          <div className="field">
            <label>Etiquetas</label>
            {/* Escolhe entre as que já existem na organização ou cria uma nova. */}
            <TagInput
              value={tags}
              onChange={setTags}
              suggestions={tagOptions}
              placeholder="Ex.: vip, base-antiga"
            />
          </div>

          <div className="drawer-grid">
            {/* Linha inteira: dividia a linha com o Valor, que saiu. */}
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Etapa</label>
              <select className="input" value={stageId} onChange={(e) => setStageId(e.target.value)}>
                <option value="">Fora do funil</option>
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              {!stageId && (
                <p className="text-muted" style={{ fontSize: 11, marginTop: 4 }}>
                  Aparece em Contatos, mas não no kanban.
                </p>
              )}
              {currentStage?.is_lost && !isNew && savedStageId !== stageId && (
                <div style={{ marginTop: 8 }}>
                  <label htmlFor="drawer-lost">Motivo da perda</label>
                  <select id="drawer-lost" className="input" value={lostReason} onChange={(e) => setLostReason(e.target.value)}>
                    <option value="">Escolha um motivo</option>
                    {lostOptions.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
              )}
              {currentStage?.is_lost && !isNew && savedStageId === stageId && contact?.lost_reason && (
                <p className="text-muted" style={{ fontSize: 11, marginTop: 4 }}>Motivo da perda: {contact.lost_reason}</p>
              )}
              {currentStage?.is_conversion && !isNew && savedStageId !== stageId && (
                <p className="text-muted" style={{ fontSize: 11, marginTop: 4 }}>
                  {!fromAd
                    ? 'Etapa de conversão. Como o contato não veio de anúncio, a Meta não é avisada.'
                    : !hasSales
                      // Sem o campo Valor, a conversão pela etapa vai com o
                      // valor do contato — zero enquanto não houver venda.
                      ? 'Etapa de conversão: sem venda registrada, a Meta é avisada sem valor. Registre a venda na seção abaixo.'
                      : hasClick
                        ? 'Etapa de conversão: ao salvar, a Meta é avisada da venda e sabe de qual anúncio este contato veio.'
                        : 'Etapa de conversão: ao salvar, a Meta é avisada da venda. Sem o clique do anúncio, ela não vai saber de qual anúncio veio.'}
                </p>
              )}
            </div>
            {/* Não há mais campo Valor aqui (11/09/2026). Digitado com o
                contato indo para a conversão, ele fazia o banco criar uma
                venda sozinho (040) — sem forma de pagamento e sem avisar os
                outros sistemas. O valor do contato agora só vem das vendas,
                lançadas na seção abaixo. */}
          </div>

          {!isNew && (
            <section className="drawer-sales">
              <h3><Receipt size={14} /> Vendas</h3>

              {/* A OUTRA PORTA para o movimento de canal (089). A primeira é
                  o campo Canal lá em cima, que pergunta ao salvar. Esta serve
                  para o caso oposto: quem já sabe que só UMA das vendas foi
                  pelo outro número entra direto pela lista, sem mexer no
                  cadastro. Some com uma venda só — aí não há o que escolher,
                  e trocar o canal do contato é o caminho. */}
              {(sales?.length ?? 0) > 1 && (
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ marginBottom: 10 }}
                  onClick={() => setMoverVendas({})}
                  disabled={busy || savingSale}
                >
                  <ArrowRightLeft size={13} /> Mover vendas para outro canal
                </button>
              )}

              {sales === null ? (
                <p className="text-muted" style={{ fontSize: 12 }}>Carregando…</p>
              ) : (
                <>
                  {sales.length === 0 ? (
                    <p className="text-muted" style={{ fontSize: 12 }}>Nenhuma venda registrada.</p>
                  ) : (
                    <>
                      <ul className="sale-list">
                        {sales.map((s) => (
                          <li key={s.id}>
                            {editingSale === s.id ? (
                              <div className="sale-edit">
                                <label>
                                  <span>Data</span>
                                  <DateInput value={editDate} onChange={setEditDate} />
                                </label>
                                <label>
                                  <span>Valor</span>
                                  <input
                                    className="input"
                                    value={editValue}
                                    onChange={(e) => setEditValue(e.target.value)}
                                    onBlur={() => setEditValue(editValue.trim() ? formatBRL(parseBRL(editValue)) : '')}
                                  />
                                </label>
                                <label>
                                  <span>Pagamento</span>
                                  <select
                                    className="input"
                                    value={editPayment}
                                    onChange={(e) => setEditPayment(e.target.value as CrmPaymentMethod | '')}
                                  >
                                    <option value="">Não informada</option>
                                    {PAYMENT_METHODS.map((m) => (
                                      <option key={m.value} value={m.value}>{m.label}</option>
                                    ))}
                                  </select>
                                </label>
                                <div className="flex" style={{ gap: 6 }}>
                                  <button className="btn btn-primary btn-sm" onClick={saveSale} disabled={savingSale}>
                                    <Save size={13} /> {savingSale ? 'Salvando…' : 'Salvar'}
                                  </button>
                                  <button className="btn btn-ghost btn-sm" onClick={cancelEdit} disabled={savingSale}>
                                    Cancelar
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <>
                                <div className="sale-info">
                                  <p className="sale-value">{formatBRL(s.value_cents)}</p>
                                  <p className="text-muted" style={{ fontSize: 11 }}>
                                    {formatSP(s.sold_at)}
                                    {/* Venda antiga não tem forma de pagamento:
                                        some em vez de mostrar um travessão. */}
                                    {s.payment_method && ` · ${paymentLabel(s.payment_method)}`}
                                  </p>
                                </div>
                                {s.refunded_at && (
                                  <button
                                    type="button"
                                    className="badge badge-red"
                                    style={{ border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                                    onClick={() => setDetalheReembolso(s.id)}
                                    title={`Reembolsada em ${formatSP(s.refunded_at)} (ver notas e anexos)`}
                                  >
                                    {s.refunded_cents != null ? `Reembolso de ${formatBRL(s.refunded_cents)}` : 'Reembolsada'}
                                  </button>
                                )}
                                <button
                                  className="icon-btn"
                                  onClick={() => startEdit(s)}
                                  disabled={savingSale}
                                  aria-label={`Editar venda de ${formatBRL(s.value_cents)}`}
                                >
                                  <Pencil size={13} />
                                </button>
                                <button
                                  className="icon-btn"
                                  onClick={() => askRefund(s)}
                                  disabled={savingSale}
                                  title={s.refunded_at ? 'Alterar ou desfazer reembolso' : 'Marcar como reembolso'}
                                  aria-label={`${s.refunded_at ? 'Alterar ou desfazer reembolso da' : 'Reembolsar'} venda de ${formatBRL(s.value_cents)}`}
                                >
                                  <RotateCcw size={13} />
                                </button>
                                <button
                                  className="icon-btn"
                                  onClick={() => setRemovendo(s)}
                                  disabled={savingSale}
                                  aria-label={`Excluir ou reembolsar venda de ${formatBRL(s.value_cents)}`}
                                >
                                  <Trash2 size={13} />
                                </button>
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                      <p className="sale-total">
                        {sales.length} venda{sales.length > 1 ? 's' : ''}
                        {' · '}
                        <strong>{formatBRL(sales.reduce((a, s) => a + s.value_cents, 0))}</strong>
                      </p>
                    </>
                  )}

                  <div className="sale-form">
                    <label>
                      <span>Data</span>
                      <DateInput value={saleDate} onChange={setSaleDate} />
                    </label>
                    <label>
                      <span>Valor</span>
                      <input
                        className="input"
                        value={saleValue}
                        onChange={(e) => setSaleValue(e.target.value)}
                        onBlur={() => setSaleValue(saleValue.trim() ? formatBRL(parseBRL(saleValue)) : '')}
                        placeholder="R$ 0,00"
                      />
                    </label>
                    <label>
                      <span>Pagamento</span>
                      <select
                        className="input"
                        value={salePayment}
                        onChange={(e) => setSalePayment(e.target.value as CrmPaymentMethod | '')}
                      >
                        <option value="">Escolha…</option>
                        {PAYMENT_METHODS.map((m) => (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                      </select>
                    </label>
                    <button className="btn btn-primary btn-sm" onClick={addSale} disabled={savingSale}>
                      <Plus size={14} /> {savingSale ? 'Salvando…' : 'Registrar'}
                    </button>
                  </div>

                  {/* Primeira venda com etapa de conversão: sem texto de ajuda. */}
                  {!(sales.length === 0 && conversionStage) && (
                  <p className="text-muted" style={{ fontSize: 11 }}>
                    {sales.length === 0
                      ? 'Nenhuma etapa está marcada como conversão: a venda fica registrada, mas o contato não entra no funil.'
                      : (fromAd
                          ? 'Recompras não movem o contato de etapa, mas cada uma avisa a Meta com o seu próprio valor: '
                            + 'cliente de anúncio manda toda compra, não só a primeira. '
                          : 'Recompras ficam só registradas aqui. Não movem o contato e não avisam a Meta. ')
                        + 'Corrigir o valor de uma venda não reenvia nada: só se o aviso dela ainda não '
                        + 'tiver saído (até 30 min), aí o valor novo vai junto. Excluir a venda antes disso cancela o aviso.'}
                  </p>
                  )}
                </>
              )}
            </section>
          )}

          {!isNew && (
            <section className="drawer-history">
              <h3><History size={14} /> Histórico de movimentações</h3>
              {history === null ? (
                <p className="text-muted" style={{ fontSize: 12 }}>Carregando…</p>
              ) : history.length === 0 ? (
                <p className="text-muted" style={{ fontSize: 12 }}>Nenhuma movimentação registrada.</p>
              ) : (
                <ol className="timeline">
                  {history.map((h) => {
                    const from = stageById(h.from_stage_id)
                    const to = stageById(h.to_stage_id)
                    return (
                      <li key={h.id}>
                        <span
                          className="timeline-dot"
                          style={{ background: to?.color ?? STAGE_COLORS[0] }}
                        />
                        <div>
                          <p>
                            {from ? <>{from.name} → <strong>{to?.name ?? '—'}</strong></> : <>Entrou em <strong>{to?.name ?? '—'}</strong></>}
                          </p>
                          <p className="text-muted" style={{ fontSize: 11 }}>
                            {formatSP(h.created_at)} · {SOURCE_LABEL[h.source] ?? h.source}
                          </p>
                        </div>
                      </li>
                    )
                  })}
                </ol>
              )}
            </section>
          )}
        </div>

        <footer className="drawer-foot">
          {!isNew && (
            <button className="btn btn-ghost btn-danger-ghost" onClick={remove} disabled={busy}>
              <Trash2 size={15} /> Excluir
            </button>
          )}
          {/* Unificar cadastros: apaga um contato e mexe no que já foi para a
              Meta, então segue a mesma régua das credenciais (054) e das
              campanhas ignoradas (059) — admin, e mais ninguém. */}
          {!isNew && isAdmin && (
            <button
              className="btn btn-ghost"
              onClick={() => setMerging(true)}
              disabled={busy}
              title="O mesmo cliente tem dois cadastros? Junte os dois num só."
            >
              <Merge size={15} /> Unificar
            </button>
          )}
          <div className="flex" style={{ marginLeft: 'auto', gap: 8 }}>
            <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancelar</button>
            <button className="btn btn-primary" onClick={() => save()} disabled={busy}>
              <Save size={15} /> {busy ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </footer>
      </aside>

      {merging && contact && (
        <MergeContactsDialog
          contact={contact}
          onClose={() => setMerging(false)}
          onMerged={afterMerge}
        />
      )}

      {removendo && (
        <Modal title="Excluir venda" onClose={() => setRemovendo(null)} variant="dialog" small>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 18 }}>
            Venda de <strong>{formatBRL(removendo.value_cents)}</strong> em {formatSP(removendo.sold_at)}.
            O que deseja fazer?
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            {removendo.refunded_at ? (
              <button className="btn btn-ghost" style={{ justifyContent: 'flex-start' }} onClick={() => undoRefund(removendo)}>
                <Undo2 size={15} /> Desfazer reembolso
                <span className="text-muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
                  {removendo.refunded_cents != null ? `${formatBRL(removendo.refunded_cents)} em ` : 'reembolsada em '}
                  {formatSP(removendo.refunded_at)}
                </span>
              </button>
            ) : (
              <button className="btn btn-primary" style={{ justifyContent: 'flex-start' }} onClick={() => askRefund(removendo)} autoFocus>
                <RotateCcw size={15} /> Apenas marcar como reembolso
              </button>
            )}
            {!removendo.refunded_at && (
              <p className="text-muted" style={{ fontSize: 12, lineHeight: 1.5, margin: '-4px 0 6px' }}>
                A venda continua no sistema e nenhum sistema externo é avisado. No
                relatório de vendas o valor devolvido (total ou parcial) sai do
                líquido do período de hoje.
              </p>
            )}
            <button className="btn btn-danger" style={{ justifyContent: 'flex-start' }} onClick={() => removeSale(removendo, 'excluir')}>
              <Trash2 size={15} /> Excluir de todos os sistemas
            </button>
            <p className="text-muted" style={{ fontSize: 12, lineHeight: 1.5, margin: '-4px 0 6px' }}>
              A venda é apagada. A conversão já enviada para a Meta não é desfeita.
            </p>
            <button className="btn btn-ghost" onClick={() => setRemovendo(null)}>Cancelar</button>
          </div>
        </Modal>
      )}

      {reembolsando && contact && (
        <RefundEditDialog
          sale={reembolsando}
          onClose={() => setReembolsando(null)}
          onSaved={() => syncAfterSale(contact.id)}
        />
      )}

      {detalheReembolso && (
        <RefundDetailDialog
          saleId={detalheReembolso}
          onClose={() => setDetalheReembolso(null)}
          onEdit={(d) => askRefund(refundTargetFromDetail(d))}
        />
      )}

      {moverVendas && contact && sales && (
        <MoveSalesChannelDialog
          contact={contact}
          sales={sales}
          channelOptions={channelOptions}
          fixedChannel={moverVendas.canalFixo}
          onClose={() => {
            // Veio da troca de canal e desistiu: o campo volta ao valor do
            // cadastro. Deixá-lo com o destino digitado faria a próxima
            // tentativa de salvar reabrir esta tela sem o usuário ter pedido.
            if (moverVendas.canalFixo) setChannel(contact.channel ?? '')
            setMoverVendas(null)
          }}
          // Só existe na porta do campo Canal: todas as vendas mudando de
          // dono é o contato inteiro mudando de número, e aí vale o caminho
          // de sempre — inclusive a oferta de unificar quando o canal de
          // destino já tem cadastro deste número.
          onAllSelected={moverVendas.canalFixo ? () => {
            setMoverVendas(null)
            void save(true)
          } : undefined}
          onMoved={async () => {
            setMoverVendas(null)
            // O CADASTRO FICA NO CANAL DELE. Quem mudou de dono foram as
            // vendas escolhidas; as que sobraram continuam sendo deste canal,
            // e é por isso que o campo volta atrás. O resto do que o usuário
            // editou é salvo — perder o nome corrigido porque ele também
            // mexeu no canal seria castigo sem motivo.
            if (moverVendas.canalFixo) {
              setChannel(contact.channel ?? '')
              try {
                const resto = patchDoQueMudou(contact)
                delete resto.channel
                if (Object.keys(resto).length > 0) {
                  await crmService.updateContact(contact.id, resto)
                }
              } catch (err) {
                toast.error(err instanceof Error ? err.message
                  : 'Vendas movidas, mas as outras alterações do contato não foram salvas')
              }
            }
            onSaved()
            onClose()
          }}
        />
      )}
    </>,
    document.body,
  )
}
