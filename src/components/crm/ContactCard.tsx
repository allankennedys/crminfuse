import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Phone } from 'lucide-react'
import { formatBRL } from '@/services/crmService'
import type { CrmContact, CrmStageAutomation } from '@/types'

function daysStalled(stageChangedAt: string): number {
  return Math.floor((Date.now() - new Date(stageChangedAt).getTime()) / 86_400_000)
}

/**
 * O que a regra de movimentação automática (050) reserva para ESTE contato:
 * quanto falta para ele sair da coluna sozinho, contado do stage_changed_at —
 * o mesmo relógio que o banco usa. Vira o title do card; no cabeçalho da
 * coluna a mesma frase seria um prazo genérico, sem dizer nada sobre quem
 * está ali dentro.
 *
 * O cron passa de hora em hora, então "vencido" não é "já foi": o texto diz
 * que a mudança acontece no próximo ciclo, e não que ela já aconteceu.
 */
function automationHint(contact: CrmContact, rule: CrmStageAutomation): string {
  const faltamMs = rule.hours * 3_600_000 - (Date.now() - new Date(contact.stage_changed_at).getTime())
  const destino = rule.to_stage_name

  if (faltamMs <= 0) return `Parado além do prazo: vai para ${destino} no próximo ciclo.`

  const horas = faltamMs / 3_600_000
  const restante = horas < 1
    ? 'menos de 1h'
    : horas < 48
      ? `${Math.round(horas)}h`
      : `${Math.round(horas / 24)} dias`
  return `Sem movimentação, vai para ${destino} em ${restante}.`
}

/**
 * Card do contato no kanban.
 *
 * `overlay` renderiza a versão que segue o cursor durante o arrasto — sem
 * listeners e sem o espaço vazio que o item original deixa na coluna.
 */
export function ContactCard({ contact, onOpen, overlay = false, hideStalled = false, automation }: {
  contact: CrmContact
  onOpen?: (contact: CrmContact) => void
  overlay?: boolean
  /** Na etapa de conversão o lead já fechou: "dias sem contato" ali é ruído. */
  hideStalled?: boolean
  /** Regra que move quem fica parado nesta etapa, se houver. */
  automation?: CrmStageAutomation
}) {
  const sortable = useSortable({
    id: contact.id,
    data: { type: 'contact', stageId: contact.stage_id },
    disabled: overlay,
  })
  const stalledDays = daysStalled(contact.stage_changed_at)
  const hasRepeat = (contact.sales_count ?? 0) > 1
  const cardValue = hasRepeat ? contact.sales_total_cents : contact.value_cents

  const style = overlay ? undefined : {
    transform: CSS.Translate.toString(sortable.transform),
    transition: sortable.transition,
    // O original some enquanto o overlay é arrastado — sem "fantasma" duplo.
    opacity: sortable.isDragging ? 0 : 1,
  }

  return (
    <article
      ref={overlay ? undefined : sortable.setNodeRef}
      style={style}
      className={`kanban-card${overlay ? ' dragging' : ''}`}
      {...(overlay ? {} : sortable.attributes)}
      {...(overlay ? {} : sortable.listeners)}
      onClick={() => onOpen?.(contact)}
      title={automation ? automationHint(contact, automation) : undefined}
    >
      <header>
        <h4>{contact.name}</h4>
        {/* Com recompra o card mostra o total vendido: value_cents é só a 1ª
            venda (a que converteu) e sozinho subestimaria o cliente. */}
        {cardValue > 0 && (
          <span className="kanban-value" title={hasRepeat ? `${contact.sales_count} vendas somadas` : undefined}>
            {formatBRL(cardValue)}
          </span>
        )}
      </header>

      {hasRepeat && (
        <p className="kanban-sales">{contact.sales_count} vendas</p>
      )}

      {contact.phone && (
        <p className="kanban-phone"><Phone size={11} /> {contact.phone}</p>
      )}

      {contact.channel && (
        <p className="kanban-channel">{contact.channel}</p>
      )}

      {!hideStalled && stalledDays >= 3 && (
        <span className={`badge ${stalledDays >= 7 ? 'badge-red' : 'badge-yellow'}`} style={{ marginBottom: 6 }}>
          {stalledDays}d sem contato
        </span>
      )}

      {contact.tags.length > 0 && (
        <div className="tag-list" style={{ marginTop: 8 }}>
          {/* Card é estreito: mostra as 3 primeiras e resume o resto em "+N". */}
          {contact.tags.slice(0, 3).map((t) => (
            <span key={t} className="tag-chip tag-chip-sm">{t}</span>
          ))}
          {contact.tags.length > 3 && (
            <span className="tag-chip tag-chip-sm tag-chip-more">+{contact.tags.length - 3}</span>
          )}
        </div>
      )}
    </article>
  )
}
