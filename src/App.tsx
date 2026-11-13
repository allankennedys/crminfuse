import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { ToastContainer } from '@/components/Toast'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Loader } from '@/components/ui'
import { LoginPage } from '@/pages/Login'
import { SignupPage } from '@/pages/Signup'
import { ConvitePage } from '@/pages/Convite'
import { ConfirmarEmailPage, EsqueciSenhaPage, RedefinirSenhaPage } from '@/pages/EmailLinks'
import { CRMPage } from '@/pages/CRM'
import { PrivacidadePage, TermosPage } from '@/pages/Legal'

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
          <Route path="/privacidade" element={<PrivacidadePage />} />
          <Route path="/termos" element={<TermosPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/cadastro" element={<SignupPage />} />
          <Route path="/convite/:token" element={<ConvitePage />} />
          <Route path="/verificar-email/:token" element={<ConfirmarEmailPage />} />
          <Route path="/confirmar-email/:token" element={<ConfirmarEmailPage troca />} />
          <Route path="/esqueci-senha" element={<EsqueciSenhaPage />} />
          <Route path="/redefinir-senha/:token" element={<RedefinirSenhaPage />} />
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
        <Route path="/privacidade" element={<PrivacidadePage />} />
        <Route path="/termos" element={<TermosPage />} />
        <Route path="/crm" element={<CRMPage />} />
        <Route path="/convite/:token" element={<ConvitePage />} />
        <Route path="/confirmar-email/:token" element={<ConfirmarEmailPage troca />} />
        <Route path="/verificar-email/:token" element={<ConfirmarEmailPage />} />
        <Route path="*" element={<Navigate to="/crm" replace />} />
      </Routes>
      <ToastContainer />
      <ConfirmDialog />
    </>
  )
}
