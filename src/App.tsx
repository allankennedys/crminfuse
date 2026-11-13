import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { ToastContainer } from '@/components/Toast'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Loader } from '@/components/ui'
import { LoginPage } from '@/pages/Login'
import { SignupPage } from '@/pages/Signup'
import { ConvitePage } from '@/pages/Convite'
import { CRMPage } from '@/pages/CRM'

export default function App() {
  const { session, loading, initialize } = useAuthStore()

  useEffect(() => {
    initialize()
  }, [initialize])

  if (loading) return <div className="auth-page"><Loader /></div>

  if (!session) {
    return (
      <>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/cadastro" element={<SignupPage />} />
          <Route path="/convite/:token" element={<ConvitePage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
        <ToastContainer />
      </>
    )
  }

  // Este projeto é só o CRM: não existe painel de grupos. Qualquer caminho
  // cai no /crm, inclusive o que estiver salvo no navegador de antes.
  return (
    <>
      <Routes>
        <Route path="/crm" element={<CRMPage />} />
        <Route path="/convite/:token" element={<ConvitePage />} />
        <Route path="*" element={<Navigate to="/crm" replace />} />
      </Routes>
      <ToastContainer />
      <ConfirmDialog />
    </>
  )
}
