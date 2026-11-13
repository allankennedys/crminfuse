/**
 * Planos, assinatura e cobrança (147). Cartão: página do Stripe (cobrança
 * automática). Pix: registrado à mão pelo dono da plataforma. Aqui só se pede o
 * link e se lê o estado da assinatura.
 */
import { supabase, FunctionRegion } from '@/lib/supabase'

/** Plano único à venda por enquanto (R$ 200). Para voltar aos demais, remova o filtro em listPlans. */
const PLANO_UNICO = 'profissional'

export interface Plan {
  id: string
  name: string
  price_cents: number
  max_whatsapps: number
  max_agents: number
  position?: number
  active?: boolean
}

/** Dias de teste grátis para contas novas (0 = sem teste). Público: a tela de cadastro usa. */
export async function trialDays(): Promise<number> {
  const { data, error } = await supabase.rpc('trial_days')
  return error ? 7 : Number(data ?? 7)
}

export type SubscriptionStatus = 'trial' | 'ativa' | 'atrasada' | 'cancelada'
export type Acesso = 'total' | 'leitura' | 'bloqueado'

export interface MySubscription {
  status: SubscriptionStatus
  acesso: Acesso
  courtesy: boolean
  trial_ends_at: string | null
  /** Conta nova criada com o teste desativado: aguarda a primeira assinatura (156). */
  no_trial?: boolean
  overdue_since: string | null
  current_period_end: string | null
  plan: Plan
  uso: { whatsapps: number; agents: number }
  is_admin: boolean
  /** Já tem assinatura no cartão (Stripe). */
  has_billing: boolean
  payment_mode: 'cartao' | 'pix' | null
  cancel_at_period_end: boolean
  /** Código para o cliente informar no Pix (identifica a organização). */
  reference: string
  pix: { pix_key?: string; pix_holder?: string; pix_contact?: string } | null
  billing_name: string | null
  billing_email: string | null
  billing_doc: string | null
}

export interface SignupInput {
  organization_name: string
  full_name: string
  password: string
  email: string
  doc: string
  plan_id: string
  website: string
}

export interface PlatformOrg {
  id: string
  name: string
  created_at: string
  subscription: {
    plan_id: string; status: SubscriptionStatus; trial_ends_at: string | null
    overdue_since: string | null; courtesy: boolean; billing_email: string | null
    payment_mode: 'cartao' | 'pix' | null; current_period_end: string | null; last_payment_at: string | null
  } | null
  uso: { whatsapps: number; agents: number }
  acesso: Acesso
}

async function call<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body, region: FunctionRegion.EuWest3 })
  if (error) {
    let msg = 'Falha de comunicação com o servidor. Tente de novo.'
    try {
      const ctx = (error as { context?: Response }).context
      const j = ctx ? await ctx.json() : null
      if (j?.error) msg = j.error
    } catch { /* corpo não era JSON */ }
    throw new Error(msg)
  }
  if (data?.error) throw new Error(data.error)
  return data as T
}

export interface Invite {
  id: string
  role: 'admin' | 'atendente'
  email: string | null
  created_at: string
  expires_at: string
}

export const billingService = {
  // ---- convites (148) ----
  async createInvite(p: { role: 'admin' | 'atendente'; email: string; permissions?: string[] | null }): Promise<{ url: string; email_sent: boolean }> {
    return await call('invite', { action: 'create', ...p })
  },
  async listInvites(): Promise<Invite[]> {
    return (await call<{ invites: Invite[] }>('invite', { action: 'list' })).invites
  },
  async revokeInvite(id: string): Promise<void> {
    await call('invite', { action: 'revoke', id })
  },
  async inviteInfo(token: string): Promise<{ organization: string; role: 'admin' | 'atendente'; email: string | null }> {
    return await call('invite', { action: 'info', token })
  },
  async acceptInvite(p: { token: string; full_name: string; password: string }): Promise<{ email: string }> {
    return await call('invite', { action: 'accept', ...p })
  },

  /** Cadastro da empresa por quem entrou com o Google (a conta já existe, sem empresa). */
  async completeGoogleSignup(p: { organization_name: string; full_name: string; doc: string; plan_id: string }): Promise<void> {
    await call('signup', { action: 'google', ...p })
  },
  /** Convite aceito por quem entrou com o Google. */
  async acceptInviteGoogle(token: string): Promise<void> {
    await call('invite', { action: 'accept_google', token })
  },

  /** Planos à venda (leitura pública: a tela de cadastro também usa). */
  async listPlans(): Promise<Plan[]> {
    const { data } = await supabase.from('plans').select('*').order('position')
    // Por enquanto só o plano de R$ 200 é vendido; os outros continuam no banco.
    return ((data as Plan[] | null) ?? []).filter((p) => p.id === PLANO_UNICO)
  },

  async mySubscription(): Promise<MySubscription | null> {
    const { data, error } = await supabase.rpc('my_subscription')
    if (error) return null
    return (data as MySubscription | null) ?? null
  },

  async signup(input: SignupInput): Promise<{ email: string; email_sent: boolean }> {
    return await call('signup', input as unknown as Record<string, unknown>)
  },

  // ---- e-mail: verificação, recuperação e troca (150) ----
  async sendVerification(email: string): Promise<void> { await call('auth-email', { action: 'send_verification', email }) },
  async verifyEmail(token: string): Promise<{ email: string }> { return await call('auth-email', { action: 'verify', token }) },
  async requestReset(email: string): Promise<void> { await call('auth-email', { action: 'request_reset', email }) },
  async resetPassword(token: string, password: string): Promise<void> { await call('auth-email', { action: 'reset', token, password }) },
  async changeEmail(newEmail: string): Promise<void> { await call('auth-email', { action: 'change_email', new_email: newEmail }) },
  async confirmEmailChange(token: string): Promise<{ email: string }> { return await call('auth-email', { action: 'confirm_email_change', token }) },

  async billingConfigured(): Promise<boolean> {
    try { return (await call<{ configured: boolean }>('billing', { action: 'configured' })).configured } catch { return false }
  },

  /** Assina (ou troca de plano) no cartão: devolve a página de pagamento do Stripe. */
  async checkout(planId: string): Promise<string> {
    return (await call<{ url: string }>('billing', { action: 'checkout', plan_id: planId })).url
  },

  /** Escolhe pagar por Pix (o dono confirma o pagamento). */
  async choosePix(planId: string): Promise<void> {
    await call('billing', { action: 'pix', plan_id: planId })
  },

  /** Portal do Stripe: trocar cartão, ver faturas, cancelar. */
  async portal(): Promise<string> {
    return (await call<{ url: string }>('billing', { action: 'portal' })).url
  },

  async cancel(): Promise<void> {
    await call('billing', { action: 'cancel' })
  },

  // ---- dono da plataforma ----
  async platformOrgs(): Promise<PlatformOrg[]> {
    return (await call<{ orgs: PlatformOrg[] }>('platform', { action: 'orgs' })).orgs
  },
  async platformPlans(): Promise<Plan[]> {
    return (await call<{ plans: Plan[] }>('platform', { action: 'plans' })).plans
  },
  async savePlan(plan: Plan): Promise<void> {
    await call('platform', { action: 'save_plan', plan })
  },
  async setSubscription(p: { organization_id: string; plan_id?: string; status?: SubscriptionStatus; courtesy?: boolean; add_trial_days?: number; payment_mode?: 'cartao' | 'pix' }): Promise<void> {
    await call('platform', { action: 'set_subscription', ...p })
  },
  /** Pix recebido: ativa e estende o período em `months` meses. */
  async registerPayment(organizationId: string, months = 1): Promise<void> {
    await call('platform', { action: 'register_payment', organization_id: organizationId, months })
  },
  async trialDaysOwner(): Promise<number> {
    return (await call<{ days: number }>('platform', { action: 'trial_days' })).days
  },
  async saveTrialDays(days: number): Promise<number> {
    return (await call<{ days: number }>('platform', { action: 'save_trial_days', days })).days
  },
  async pixSettings(): Promise<{ pix_key?: string; pix_holder?: string; pix_contact?: string }> {
    return (await call<{ settings: { pix_key?: string; pix_holder?: string; pix_contact?: string } }>('platform', { action: 'pix_settings' })).settings
  },
  async savePixSettings(s: { pix_key: string; pix_holder: string; pix_contact: string }): Promise<void> {
    await call('platform', { action: 'save_pix_settings', ...s })
  },
}

export const formatPrice = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 0 })
