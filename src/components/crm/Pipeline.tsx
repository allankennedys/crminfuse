import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext, DragOverlay, PointerSensor, KeyboardSensor, useSensor, useSensors,
  closestCorners, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext, sortableKeyboardCoordinates, horizontalListSortingStrategy,
  verticalListSortingStrategy, useSortable, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Plus, GripVertical, Pencil, Trophy, ChevronDown } from 'lucide-react'
import { crmService, formatBRL, isAdContact, type StageStats } from '@/services/crmService'
import { toast } from '@/store/toastStore'
import { ContactCard } from './ContactCard'
import type { CrmContact, CrmStage, CrmStageAutomation } from '@/types'

/**
 * Ordem dos cards dentro de uma coluna: quem entrou na etapa por último no
 * topo. Espelha o ORDER BY de crm_board (migration 024) — stage_changed_at
 * desc, com created_at e id como desempate determinístico.
 */
function byRecentInStage(a: CrmContact, b: CrmContact): number {
  return (
    b.stage_changed_at.localeCompare(a.stage_changed_at) ||
    b.created_at.localeCompare(a.created_at) ||
    a.id.localeCompare(b.id)
  )
}

/**
 * Pipeline kanban com drag and drop de cards (entre etapas) e de colunas
 * (reordenar etapas), no mesmo DndContext — o tipo vem em `data.type`.
 *
 * As duas operações são otimistas: a tela muda na hora e o banco é
 * atualizado em seguida. Se o servidor recusar, o estado volta ao anterior
 * e um toast explica o motivo — nunca fica uma tela mentindo sobre o banco.
 */
export function Pipeline({
  stages, contacts, stats, onLoadMore, onEditStage, onNewStage, onOpenContact, onConvertWithoutSale,
}: {
  stages: CrmStage[]
  contacts: CrmContact[]
  /** Contagem e soma reais por etapa — o board carrega só as primeiras páginas. */
  stats: Map<string, StageStats>
  onLoadMore: (stageId: string, loaded: number) => Promise<void>
  onEditStage: (stage: CrmStage) => void
  onNewStage: () => void
  onOpenContact: (contact: CrmContact) => void
  /**
   * Card sem venda solto na etapa de conversão. Quem chama abre o lançamento
   * de venda; o card só muda de coluna quando a venda é gravada.
   */
  onConvertWithoutSale: (contact: CrmContact) => void
}) {
  // Cópias locais para o movimento otimista; o pai continua sendo a verdade
  // depois que onChanged recarrega.
  const [localStages, setLocalStages] = useState(stages)
  const [localContacts, setLocalContacts] = useState(contacts)
  const [dragging, setDragging] = useState<{ type: 'contact' | 'stage'; id: string } | null>(null)

  // Recarga vinda do pai (realtime, edição, novo contato) substitui o local.
  //
  // A chave do contato usa updated_at, não a lista de campos que o card
  // mostra: o trigger crm_contacts_touch carimba updated_at em QUALQUER
  // update, então editar etiqueta, telefone ou canal ressincroniza igual a
  // mudar nome ou valor. Enumerar campos aqui já deixou o kanban preso na
  // versão antiga do card até dar F5 — a edição gravava, a tela é que não
  // acompanhava.
  const [syncKey, setSyncKey] = useState('')
  const currentKey = `${stages.map((s) => s.id + s.position + s.name + s.color + s.is_conversion).join()}|${contacts.map((c) => c.id + c.stage_id + c.updated_at).join()}`
  if (currentKey !== syncKey) {
    setSyncKey(currentKey)
    setLocalStages(stages)
    setLocalContacts(contacts)
  }

  // Regras de movimentação automática (050), só para avisar na coluna quem
  // sai dela sozinho. Falhando, o funil segue sem o aviso: é informação
  // complementar, não parte do quadro.
  const [automations, setAutomations] = useState<CrmStageAutomation[]>([])
  useEffect(() => {
    crmService.listStageAutomations().then(setAutomations).catch(() => setAutomations([]))
  }, [])

  const sensors = useSensors(
    // 6px de tolerância: clicar no card para abrir o painel não vira arrasto.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // ---------- Arrastar o fundo para rolar o quadro ----------
  //
  // Com muitas etapas, chegar nas últimas exigia mirar a barra de rolagem.
  // Aqui qualquer área livre do quadro serve de "mão": segura e arrasta.
  //
  // Só ignora o que já tem gesto próprio — card (dnd-kit), alça da coluna e
  // controles. Sem essa exclusão, o pan competiria com o drag and drop.
  const boardRef = useRef<HTMLDivElement>(null)
  const pan = useRef<{ pointerX: number; scrollLeft: number } | null>(null)

  function startPan(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    const el = e.target as HTMLElement
    if (el.closest('.kanban-card, .kanban-grip, button, a, select, input, textarea')) return

    const board = boardRef.current
    if (!board || board.scrollWidth <= board.clientWidth) return

    pan.current = { pointerX: e.clientX, scrollLeft: board.scrollLeft }
    board.classList.add('panning')
    // Captura: continuar arrastando fora do quadro não interrompe o gesto.
    board.setPointerCapture(e.pointerId)
  }

  function movePan(e: React.PointerEvent<HTMLDivElement>) {
    const board = boardRef.current
    if (!pan.current || !board) return
    board.scrollLeft = pan.current.scrollLeft - (e.clientX - pan.current.pointerX)
  }

  function endPan(e: React.PointerEvent<HTMLDivElement>) {
    const board = boardRef.current
    if (!pan.current || !board) return
    pan.current = null
    board.classList.remove('panning')
    if (board.hasPointerCapture(e.pointerId)) board.releasePointerCapture(e.pointerId)
  }

  const byStage = useMemo(() => {
    const map = new Map<string, CrmContact[]>()
    for (const stage of localStages) map.set(stage.id, [])
    for (const contact of localContacts) {
      // stage_id null = fora do funil; não pertence a nenhuma coluna.
      if (contact.stage_id) map.get(contact.stage_id)?.push(contact)
    }
    // Mesma ordenação do servidor (crm_board, migration 024): quem entrou na
    // etapa por último no topo. Ordenar aqui também mantém a coluna correta
    // após um movimento otimista ou um UPDATE do Realtime, que chegam fora de
    // ordem no array local.
    for (const list of map.values()) list.sort(byRecentInStage)
    return map
  }, [localStages, localContacts])

  const activeContact = dragging?.type === 'contact'
    ? localContacts.find((c) => c.id === dragging.id)
    : undefined

  function handleDragStart(event: DragStartEvent) {
    const type = event.active.data.current?.type
    if (type === 'contact' || type === 'stage') {
      setDragging({ type, id: String(event.active.id) })
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    setDragging(null)
    if (!over) return

    const activeType = active.data.current?.type

    // ---------- Reordenar etapas ----------
    if (activeType === 'stage') {
      if (active.id === over.id) return
      const from = localStages.findIndex((s) => s.id === active.id)
      const to = localStages.findIndex((s) => s.id === over.id)
      if (from < 0 || to < 0) return

      const previous = localStages
      const reordered = arrayMove(localStages, from, to)
      setLocalStages(reordered)

      try {
        // Sem refetch: o Realtime devolve os UPDATEs de position e o pai
        // aplica no estado local.
        await crmService.reorderStages(reordered.map((s) => s.id))
      } catch (err) {
        setLocalStages(previous)
        toast.error(err instanceof Error ? err.message : 'Falha ao reordenar etapas')
      }
      return
    }

    // ---------- Mover contato ----------
    if (activeType !== 'contact') return

    const contact = localContacts.find((c) => c.id === active.id)
    if (!contact) return

    // O alvo pode ser outro card (pega a etapa dele) ou a própria coluna.
    const overType = over.data.current?.type
    const targetStageId = overType === 'contact'
      ? String(over.data.current?.stageId ?? '')
      : String(over.id)

    if (!targetStageId || targetStageId === contact.stage_id) return
    if (!localStages.some((s) => s.id === targetStageId)) return

    // CONVERSÃO SEM VENDA. Mover direto deixava o cliente na etapa de
    // conversão sem venda nenhuma: valor zero e Purchase de R$ 0 para a Meta.
    // Agora o arrasto abre o lançamento, e é a venda
    // gravada que leva o card para a coluna (trigger da 031). Cancelou, o
    // card fica onde estava. Quem já comprou move como sempre: a venda dele
    // existe, e a Meta não recebe evento de etapa de quem já tem venda.
    if (localStages.find((s) => s.id === targetStageId)?.is_conversion && contact.sales_count === 0) {
      onConvertWithoutSale(contact)
      return
    }

    const previous = localContacts
    // Carimba a entrada na etapa AGORA: o card já sobe para o topo da coluna
    // de destino (byRecentInStage), igual ao que o trigger vai gravar. Sem
    // isso, ele apareceria no meio até o Realtime confirmar a linha.
    const movedAt = new Date().toISOString()
    setLocalContacts((cur) =>
      cur.map((c) =>
        c.id === contact.id ? { ...c, stage_id: targetStageId, stage_changed_at: movedAt } : c,
      ),
    )

    try {
      // A ordem na coluna vem de stage_changed_at (o trigger carimba no
      // banco), não mais da position — por isso ela vai como 0.
      await crmService.moveContact(contact.id, targetStageId, 0)
      const target = localStages.find((s) => s.id === targetStageId)
      if (target?.is_conversion) {
        // Só anúncio gera evento na Meta: clique de Click-to-WhatsApp,
        // clique na landing ou origem declarando anúncio — migrations
        // 032/033/071. O aviso diz o que de fato aconteceu.
        const toAd = isAdContact(contact, contact.origem)
        toast.success(
          toAd
            ? `${contact.name} marcado como conversão. O aviso para a Meta está na fila.`
            : `${contact.name} marcado como conversão. Não veio de anúncio: nada é enviado à Meta.`,
        )
      }
      // Sem refetch: o estado local já reflete o movimento e o Realtime
      // confirma a linha alterada.
    } catch (err) {
      setLocalContacts(previous)
      toast.error(err instanceof Error ? err.message : 'Falha ao mover o contato')
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div
        ref={boardRef}
        className="kanban"
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <SortableContext items={localStages.map((s) => s.id)} strategy={horizontalListSortingStrategy}>
          {localStages.map((stage) => (
            <StageColumn
              key={stage.id}
              stage={stage}
              contacts={byStage.get(stage.id) ?? []}
              stats={stats.get(stage.id)}
              automation={automations.find((a) => a.from_stage_id === stage.id)}
              onLoadMore={onLoadMore}
              onEdit={() => onEditStage(stage)}
              onOpenContact={onOpenContact}
            />
          ))}
        </SortableContext>

        <button className="kanban-add-stage" onClick={onNewStage}>
          <Plus size={16} /> Nova etapa
        </button>
      </div>

      {/* Segue o cursor durante o arrasto */}
      <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
        {activeContact && (
          <ContactCard
            contact={activeContact}
            overlay
            hideStalled={localStages.find((s) => s.id === activeContact.stage_id)?.is_conversion ?? false}
          />
        )}
      </DragOverlay>
    </DndContext>
  )
}

/**
 * Valor do <option> "Sem origem" — não é uma origem real. Começa com espaço
 * inquebrável justamente para não poder colidir com nenhuma origem digitada:
 * a lista de origens só tem texto já passado por trim().
 */
const NO_ORIGIN = ' sem-origem'

/** Uma coluna do funil: cabeçalho arrastável + lista de cards. */
function StageColumn({ stage, contacts, stats, automation, onLoadMore, onEdit, onOpenContact }: {
  stage: CrmStage
  contacts: CrmContact[]
  stats?: StageStats
  /** Regra que esvazia esta coluna sozinha, se houver. */
  automation?: CrmStageAutomation
  onLoadMore: (stageId: string, loaded: number) => Promise<void>
  onEdit: () => void
  onOpenContact: (contact: CrmContact) => void
}) {
  const [loadingMore, setLoadingMore] = useState(false)
  const [originFilter, setOriginFilter] = useState('')
  const {
    setNodeRef, attributes, listeners, transform, transition, isDragging, isOver,
  } = useSortable({ id: stage.id, data: { type: 'stage' } })

  // Contagem e soma vêm do agregado do banco: mostrar contacts.length
  // mentiria assim que a coluna tivesse mais que uma página carregada.
  const count = stats?.contact_count ?? contacts.length
  const total = stats?.total_value_cents ?? 0
  const hasMore = contacts.length < count

  // Filtro rápido só enxerga o que já foi carregado nesta coluna — colunas
  // grandes com paginação podem precisar de "Carregar mais" antes de o
  // filtro achar tudo.
  const origins = useMemo(
    () => Array.from(new Set(
      contacts.map((c) => (c.origem ?? '').trim()).filter((o) => o !== ''),
    )).sort(),
    [contacts],
  )
  // "Sem origem" segue a regra do banco (crm_report_no_origem_*): campo nulo
  // ou só espaço. Vira uma opção do select em vez de valor de origem para não
  // colidir com uma origem que alguém chame literalmente de "Sem origem".
  const hasNoOrigin = contacts.some((c) => (c.origem ?? '').trim() === '')
  // Só vale filtrar quando há mais de um grupo para separar.
  const showOriginFilter = origins.length + (hasNoOrigin ? 1 : 0) > 1
  const visibleContacts = contacts.filter((c) => {
    if (!originFilter) return true
    const origem = (c.origem ?? '').trim()
    return originFilter === NO_ORIGIN ? origem === '' : origem === originFilter
  })

  async function loadMore() {
    setLoadingMore(true)
    try {
      await onLoadMore(stage.id, contacts.length)
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <section
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        '--stage': stage.color,
      } as React.CSSProperties}
      className={`kanban-col${stage.is_conversion ? ' kanban-col-conversion' : ''}${isOver ? ' over' : ''}`}
      {...attributes}
    >
      <header className="kanban-col-head">
        {/* Só o punho arrasta a coluna: o resto do cabeçalho continua clicável. */}
        <button className="kanban-grip" {...listeners} aria-label={`Reordenar ${stage.name}`}>
          <GripVertical size={14} />
        </button>
        <span className="stage-dot" />
        <h3>{stage.name}</h3>
        {stage.is_conversion && (
          <span className="conversion-flag" title="Etapa de conversão">
            <Trophy size={12} />
          </span>
        )}
        <span className="kanban-count">
          {originFilter ? `${visibleContacts.length}/${count}` : count}
        </span>
        <button className="icon-btn" onClick={onEdit} aria-label={`Editar ${stage.name}`}>
          <Pencil size={13} />
        </button>
      </header>

      {/* Total e filtro de origem em linha própria: na largura da coluna o
          select nasce do tamanho da opção mais longa e não encolhe, então
          dentro do cabeçalho ele comprimia o nome da etapa até desaparecer. */}
      {(total > 0 || showOriginFilter) && (
        <div className="kanban-col-meta">
          {/* O que este número é, dito onde ele aparece. Na coluna de
              conversão ele DIVERGE do relatório por desenho: aqui é quem está
              na coluna agora, lá é quem converteu no período — e o arquivamento
              (030) tira o convertido do funil depois de 5 dias, então a
              diferença cresce junto com a janela escolhida. */}
          {total > 0 && (
            <p
              className="kanban-col-total"
              title={stage.is_conversion
                ? 'Soma dos contatos que estão nesta coluna agora. Quem converteu sai do '
                  + 'funil 5 dias depois e deixa de somar aqui. No relatório ele continua '
                  + 'contando, porque lá a conta é por histórico de conversão, não por etapa atual.'
                : 'Soma dos contatos que estão nesta coluna agora, dentro do período selecionado.'}
            >
              {formatBRL(total)}
            </p>
          )}
          {showOriginFilter && (
            <label className="channel-filter">
              <select
                value={originFilter}
                onChange={(e) => setOriginFilter(e.target.value)}
                aria-label={`Filtrar ${stage.name} por origem`}
              >
                <option value="">Todas as origens</option>
                {origins.map((o) => <option key={o} value={o}>{o}</option>)}
                {hasNoOrigin && <option value={NO_ORIGIN}>Sem origem</option>}
              </select>
            </label>
          )}
        </div>
      )}

      <div className="kanban-col-body">
        <SortableContext items={visibleContacts.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {visibleContacts.map((contact) => (
            <ContactCard
            key={contact.id}
            contact={contact}
            onOpen={onOpenContact}
            hideStalled={stage.is_conversion}
            automation={automation}
          />
          ))}
        </SortableContext>

        {visibleContacts.length === 0 && (
          <p className="kanban-empty">
            {originFilter ? 'Nenhum contato com esse filtro' : 'Arraste contatos para cá'}
          </p>
        )}

        {hasMore && (
          <button className="kanban-more" onClick={loadMore} disabled={loadingMore}>
            <ChevronDown size={13} />
            {loadingMore ? 'Carregando…' : `Carregar mais (${count - contacts.length})`}
          </button>
        )}
      </div>
    </section>
  )
}
