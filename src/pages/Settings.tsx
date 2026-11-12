import { UserAccess } from '@/components/settings/UserAccess'

/**
 * Página de Configurações do painel (Gestão de Grupos): usuários e permissões
 * da organização. A gestão em si vive em UserAccess, reaproveitada também pela
 * aba Configurações do CRM.
 */
export function SettingsPage() {
  return <UserAccess />
}
