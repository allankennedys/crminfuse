import { useEffect, useRef } from 'react'
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
import { CompletarCadastroPage, CONVITE_PENDENTE } from '@/pages/CompletarCadastro'
import { billingService } from '@/services/billingService'
import { toast } from '@/store/toastStore'
import { PrivacidadePage, TermosPage } from '@/pages/Legal'

export default function App() {
  const { session, profile, loading, initialize } = useAuthStore()

  useEffect(() => {
    initialize()
  }, [initialize])

  // Entrou com o Google a partir do link de um convite e já tem empresa: aceita o convite
  // como mais um vínculo e passa para a empresa nova (quem não tem empresa segue em Completar cadastro).
  const conviteTratado = useRef(false)
  const trocarOrganizacao = useAuthStore((s) => s.trocarOrganizacao)
  useEffect(() => {
    if (loading || !session || !profile || conviteTratado.current) return
    let token = ''
    try { token = localStorage.getItem(CONVITE_PENDENTE) ?? '' } catch { /* sem armazenamento */ }
    if (!token) return
    conviteTratado.current = true
    try { localStorage.removeItem(CONVITE_PENDENTE) } catch { /* ok */ }
    billingService.acceptInviteExisting(token)
      .then((r) => { toast.success('Convite aceito.'); return trocarOrganizacao(r.organization_id) })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Não foi possível aceitar o convite'))
  }, [loading, session, profile, trocarOrganizacao])

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

  // Entrou com o Google mas ainda não tem empresa: conclui o cadastro (ou aceita o convite).
  if (!profile) {
    return (
      <>
        <Routes>
          <Route path="/privacidade" element={<PrivacidadePage />} />
          <Route path="/termos" element={<TermosPage />} />
          <Route path="*" element={<CompletarCadastroPage />} />
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
