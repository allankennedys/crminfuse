import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Trash2, Trophy, X } from 'lucide-react'
import { crmService, STAGE_COLORS } from '@/services/crmService'
import { useAuthStore } from '@/store/authStore'
import { toast } from '@/store/toastStore'
import type { CrmStage } from '@/types'

/**
 * Criação/edição de etapa. `stage === null` cria uma nova.
 *
 * Na exclusão, se a etapa tiver contatos, o usuário é obrigado a escolher
 * o destino deles — a mesma regra é aplicada no banco (crm_delete_stage),
 * então nem um bug de tela nem um acesso direto conseguem perder contatos.
 */
export function StageDialog({ stage, stages, contactCount, onClose, onSaved }: {
  stage: CrmStage | null
  stages: CrmStage[]
  /**
   * Total real de contatos na etapa, vindo do agregado do banco. Não pode
   * ser derivado da lista do kanban: ela é paginada, então uma coluna com
   * 3.000 contatos mostraria "20" e o aviso de exclusão mentiria.
   */
  contactCount: number
  onClose: () => void
  onSaved: () => void
}) {
  const profile = useAuthStore((s) => s.profile)
  const isNew = stage === null

  const [name, setName] = useState(stage?.name ?? '')
  const [color, setColor] = useState(stage?.color ?? STAGE_COLORS[1])
  const [isConversion, setIsConversion] = useState(stage?.is_conversion ?? false)
  // '' = etapa sem papel na jornada (o meio do funil, que é a maioria).
  // '' = ainda não escolheu; '__none__' = tirar do funil; uuid = mover
  const [moveTo, setMoveTo] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  const otherStages = stages.filter((s) => s.id !== stage?.id)
  const currentConversion = stages.find((s) => s.is_conversion)

  // Esc fecha o painel — comportamento esperado de drawer (igual ao de contato).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function save() {
    if (!name.trim()) {
      toast.error('Informe o nome da etapa')
      return
    }
    setBusy(true)
    try {
      if (isNew) {
        await crmService.createStage({
          organizationId: profile!.organization_id,
          name: name.trim(),
          color,
          position: stages.length,
          isConversion,
        })
        toast.success('Etapa criada')
      } else {
        await crmService.updateStage(stage.id, {
          name: name.trim(),
          color,
          is_conversion: isConversion,
          // Conversão e papel de jornada não convivem: a escada do funil
          // (060) exclui os papéis de saída, e uma etapa de conversão
          // marcada como 'perdido' desapareceria do próprio funil.
        })
        toast.success('Etapa atualizada')
      }
      onSaved()
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar a etapa')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!stage) return
    if (contactCount > 0 && !moveTo) {
      toast.error('Escolha para onde mover os contatos')
      return
    }
    setBusy(true)
    try {
      const unassign = moveTo === '__none__'
      await crmService.deleteStage(stage.id, {
        moveTo: unassign ? undefined : (moveTo || undefined),
        unassign,
      })
      toast.success(
        contactCount === 0 ? 'Etapa excluída'
          : unassign ? `Etapa excluída e ${contactCount} contato(s) tirados do funil`
          : `Etapa excluída e ${contactCount} contato(s) movidos`,
      )
      onSaved()
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao excluir a etapa')
    } finally {
      setBusy(false)
    }
  }

  // Portal no body pelo mesmo motivo do ContactDrawer: `position: fixed` só se
  // ancora na viewport se nenhum ancestral criar containing block.
  return createPortal(
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={isNew ? 'Nova etapa' : 'Editar etapa'}>
        <header className="drawer-head">
          <div>
            <h2>{isNew ? 'Nova etapa' : 'Editar etapa'}</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Fechar">
            <X size={17} />
          </button>
        </header>

        <div className="drawer-body">
          <div className="field">
            <label>Nome</label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Proposta enviada"
              autoFocus
            />
          </div>

          <div className="field">
            <label>Cor</label>
            <div className="color-picker">
              {STAGE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`color-dot${color === c ? ' active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  aria-label={`Cor ${c}`}
                />
              ))}
            </div>
          </div>

          <div className="field">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={isConversion}
                onChange={(e) => setIsConversion(e.target.checked)}
              />
              <span>
                <Trophy size={13} /> Etapa de conversão
              </span>
            </label>
            <p className="text-muted" style={{ fontSize: 11, marginTop: 4 }}>
              Quando um contato chega nesta etapa, a Meta é avisada de que a venda
              aconteceu — é isso que faz o anúncio aprender e a conversão aparecer no
              Gerenciador. Tendo venda registrada, quem avisa é cada venda, com o
              valor dela: a primeira e as recompras.
              {currentConversion && currentConversion.id !== stage?.id && isConversion && (
                <> Hoje quem ocupa esse papel é <strong>{currentConversion.name}</strong>, que deixará de ser.</>
              )}
            </p>
          </div>


          {!isNew && (
            confirmingDelete ? (
              <div className="danger-zone">
                <p style={{ fontSize: 13, marginBottom: 8 }}>
                  {contactCount > 0
                    ? `Esta etapa tem ${contactCount} contato(s). Para onde movê-los?`
                    : 'Excluir esta etapa? A ação não pode ser desfeita.'}
                </p>
                {contactCount > 0 && (
                  <select className="input" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} style={{ marginBottom: 8 }}>
                    <option value="">Selecione o destino…</option>
                    {otherStages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    <option value="__none__">Tirar do funil (continuam em Contatos)</option>
                  </select>
                )}
                <div className="flex" style={{ gap: 8 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setConfirmingDelete(false)} disabled={busy}>
                    Cancelar
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={remove} disabled={busy}>
                    Confirmar exclusão
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="btn btn-ghost btn-danger-ghost btn-sm"
                onClick={() => setConfirmingDelete(true)}
                disabled={busy || stages.length <= 1}
                title={stages.length <= 1 ? 'O funil precisa de ao menos uma etapa' : undefined}
              >
                <Trash2 size={14} /> Excluir etapa
              </button>
            )
          )}
        </div>

        <footer className="drawer-foot">
          <div className="flex" style={{ marginLeft: 'auto', gap: 8 }}>
            <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancelar</button>
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </footer>
      </aside>
    </>,
    document.body,
  )
}
