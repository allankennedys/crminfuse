/**
 * O mesmo código é publicado em dois domínios, cada um com uma build diferente:
 *
 *   grupos.SEU-DOMINIO → VITE_APP=groups  (painel de gestão; CRM vira link externo)
 *   crm.SEU-DOMINIO    → VITE_APP=crm     (somente o módulo CRM)
 *
 * Sem as variáveis definidas (dev local) tudo cai no comportamento antigo:
 * um app só, com o CRM em /crm.
 */
export const APP_MODE: 'groups' | 'crm' =
  import.meta.env.VITE_APP === 'crm' ? 'crm' : 'groups'

export const CRM_URL = import.meta.env.VITE_CRM_URL || '/crm'
export const GROUPS_URL = import.meta.env.VITE_GROUPS_URL || '/dashboard'

// Nome propositalmente específico: um `isAbsolute` solto aqui colide com o do
// react-router no bundle e faz o rollup renomear meia dúzia de símbolos dele.
const isUrlAbsoluta = (url: string) => /^https?:\/\//i.test(url)

/** True quando o link aponta para o outro domínio, não para uma rota local. */
export const CRM_IS_EXTERNAL = isUrlAbsoluta(CRM_URL)
export const GROUPS_IS_EXTERNAL = isUrlAbsoluta(GROUPS_URL)
