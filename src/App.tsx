import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { Layout } from '@/components/Layout'
import { ToastContainer } from '@/components/Toast'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Loader } from '@/components/ui'
import { LoginPage } from '@/pages/Login'
import { DashboardPage } from '@/pages/Dashboard'
import { GroupsPage } from '@/pages/Groups'
import { SessionsPage } from '@/pages/Sessions'
import { MessagesPage } from '@/pages/Messages'
import { SchedulesPage } from '@/pages/Schedules'
import { LogsPage } from '@/pages/Logs'
import { SettingsPage } from '@/pages/Settings'
import { CRMPage } from '@/pages/CRM'
import { APP_MODE, CRM_URL, CRM_IS_EXTERNAL } from '@/lib/appMode'

export default function App() {
  const { session, profile, loading, initialize } = useAuthStore()

  useEffect(() => {
    initialize()
  }, [initialize])

  if (loading) return <div className="auth-page"><Loader /></div>

  if (!session) {
    return (
      <>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
        <ToastContainer />
      </>
    )
  }

  // Usuário "apenas CRM" que entrou pelo domínio da gestão: o CRM mora em
  // outro subdomínio, então mandamos ele para lá em vez de servir a página aqui.
  // SDR e atendente só existem dentro do CRM.
  const soCrm = profile?.role === 'sdr' || profile?.role === 'atendente'

  if (APP_MODE === 'groups' && soCrm && CRM_IS_EXTERNAL) {
    window.location.replace(CRM_URL)
    return <div className="auth-page"><Loader /></div>
  }

  // Só o módulo CRM: ou porque esta build é a do domínio do CRM, ou porque o
  // usuário só existe dentro dele. Não montamos o Layout do painel nem as
  // rotas internas — qualquer caminho cai no /crm, inclusive o /dashboard
  // para onde o login navega por padrão.
  if (APP_MODE === 'crm' || soCrm) {
    return (
      <>
        <Routes>
          <Route path="/crm" element={<CRMPage />} />
          <Route path="*" element={<Navigate to="/crm" replace />} />
        </Routes>
        <ToastContainer />
        <ConfirmDialog />
      </>
    )
  }

  return (
    <>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/groups" element={<GroupsPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/messages" element={<MessagesPage />} />
          <Route path="/schedules" element={<SchedulesPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="/crm" element={<CRMPage />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
      <ToastContainer />
      <ConfirmDialog />
    </>
  )
}
