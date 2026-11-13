import { areasDoSistema, type PermissionArea, type PermissionSystem } from '@/lib/permissions'

/**
 * Editor das permissões de UM usuário — o mesmo bloco no cadastro e na edição.
 *
 * Nasceu extraído do modal de permissões: repetir esse JSX no modal de criação
 * significaria duas telas com a mesma finalidade e regras de marcação que sairiam
 * do lugar na primeira mudança (a de "ver", abaixo, é fácil de esquecer numa cópia).
 *
 * NÃO EXISTE MAIS A CAIXA "USAR PERMISSÕES PERSONALIZADAS"
 *
 * Ela era um pedágio: para mexer em qualquer marcação era preciso primeiro
 * ligar um interruptor à parte. Agora as caixas são editáveis direto e mexer
 * em uma já liga a personalização (onCustomChange(true)). A distinção
 * preset/personalizado continua existindo no banco — null = segue o cargo —
 * e o caminho de volta virou um botão explícito ("Voltar ao preset"), que é
 * quando o admin realmente quer desfazer.
 *
 * Mostra só as áreas do sistema em que a tela foi montada. Quem grava é o
 * chamador — é ele que sabe se está salvando um usuário existente ou um que
 * acabou de ser criado, e é ele que preserva as permissões do outro sistema
 * (mergePermissions).
 */
export function PermissionEditor({
  sistema, custom, onCustomChange, selected, onSelectedChange,
  presetLabel, onResetPreset, disabled = false,
}: {
  sistema: PermissionSystem
  /** false = segue o preset do cargo; true = vale o que está marcado aqui. */
  custom: boolean
  onCustomChange: (custom: boolean) => void
  selected: Set<string>
  onSelectedChange: (selected: Set<string>) => void
  /** Nome do cargo, para dizer de qual preset as marcações saíram. */
  presetLabel: string
  /** Devolve as marcações ao preset do cargo. Sem isto, o botão não aparece. */
  onResetPreset?: () => void
  disabled?: boolean
}) {
  const areas = areasDoSistema(sistema)
  // Contagem do que está liberado NESTE sistema — as do outro não aparecem
  // na tela e contá-las daria um número que ninguém consegue conferir.
  const chavesDoSistema = areas.flatMap((a) => a.actions.map((x) => x.key))
  const marcadas = chavesDoSistema.filter((k) => selected.has(k)).length

  /**
   * Liga/desliga uma permissão mantendo "ver" coerente com o resto.
   *
   * As políticas de escrita das áreas sem chave de exclusão própria são
   * `for all` (055), o que na prática já deixa quem edita também ler. Em vez
   * de deixar isso como acidente, a tela impõe a regra: marcar qualquer ação
   * marca o "ver" junto, e desmarcar o "ver" desmarca a área inteira. Assim
   * não existe a configuração sem sentido de "edita mas não vê".
   */
  function togglePerm(area: PermissionArea, key: string) {
    const verKey = area.actions.find((a) => a.key.endsWith('.ver'))?.key
    // "Mover os das suas conversas" é independente de "Ver": ela mostra só os
    // contatos da própria pessoa, e marcar "Ver" junto mostraria o funil todo.
    const independente = (k: string) => k === 'crm.funil.mover'
    const next = new Set(selected)
    if (next.has(key)) {
      next.delete(key)
      if (verKey && key === verKey) {
        for (const a of area.actions) if (!independente(a.key)) next.delete(a.key)
      }
    } else {
      next.add(key)
      if (verKey && !independente(key)) next.add(verKey)
    }
    onSelectedChange(next)
    // Mexeu, personalizou. Sem isto a marcação apareceria na tela e não seria
    // gravada — o pior dos dois mundos.
    if (!custom) onCustomChange(true)
  }

  /** Marca ou limpa tudo deste sistema, sem tocar no outro. */
  function toggleTudo(ligar: boolean) {
    const next = new Set(selected)
    for (const k of chavesDoSistema) {
      if (ligar) next.add(k)
      else next.delete(k)
    }
    onSelectedChange(next)
    if (!custom) onCustomChange(true)
  }

  return (
    <>
      <div className="perm-bar">
        <span className="perm-state">
          <span className={`badge ${custom ? 'badge-blue' : 'badge-gray'}`}>
            {custom ? 'Personalizado' : `Preset de ${presetLabel}`}
          </span>
          <span className="text-muted">{marcadas} de {chavesDoSistema.length} liberadas</span>
        </span>
        <span className="perm-bar-actions">
          <button className="btn btn-ghost btn-sm" type="button" disabled={disabled} onClick={() => toggleTudo(true)}>
            Marcar tudo
          </button>
          <button className="btn btn-ghost btn-sm" type="button" disabled={disabled} onClick={() => toggleTudo(false)}>
            Limpar
          </button>
          {custom && onResetPreset && (
            <button className="btn btn-ghost btn-sm" type="button" disabled={disabled} onClick={onResetPreset}>
              Voltar ao preset
            </button>
          )}
        </span>
      </div>

      <p className="text-muted perm-note">
        {custom
          ? 'O cargo virou só um rótulo: vale exatamente o que está marcado aqui.'
          : `Seguindo o preset de ${presetLabel}: mudanças no preset valem para este usuário automaticamente. Mexer em qualquer caixa abaixo passa a valer só para ele.`}
      </p>

      <div className="perm-list">
        {areas.map((area) => (
          <div key={area.id} className="perm-row">
            <div className="perm-row-info">
              <strong>{area.label}</strong>
              <span className="text-muted">{area.hint}</span>
            </div>
            <div className="perm-row-actions">
              {area.actions.map((action) => {
                const on = selected.has(action.key)
                return (
                  <label
                    key={action.key}
                    className={`perm-check${on ? ' on' : ''}${disabled ? ' disabled' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={disabled}
                      onChange={() => togglePerm(area, action.key)}
                    />
                    {action.label}
                  </label>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
