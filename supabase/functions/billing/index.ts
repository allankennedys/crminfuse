/**
 * Edge Function: billing  (JWT; só administrador da organização)
 *
 * Cartão pelo Stripe (cobrança automática todo mês) e Pix registrado à mão
 * pelo dono da plataforma. O cartão é digitado na página do Stripe: o sistema
 * nunca vê dados de cartão.
 *
 *   { action: 'configured' }                    → { configured }
 *   { action: 'checkout', plan_id }             → { url }  assinar (ou trocar de plano) no cartão
 *   { action: 'portal' }                        → { url }  trocar cartão, ver faturas, cancelar
 *   { action: 'cancel' }                        → { ok }   cancela no fim do período pago
 *   { action: 'pix', plan_id }                  → { ok }   escolhe pagar por Pix (o dono confirma o pagamento)
 *
 * Secrets: STRIPE_SECRET_KEY (sk_test_… ou sk_live_…), APP_URL (volta do pagamento).
 * Sem a chave, o teste e os limites seguem funcionando e o cartão responde
 * "cobrança não configurada".
 */
import { createClient } from 'npm:@supabase/supabase-js@2'
import Stripe from 'npm:stripe@17.7.0'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
}

const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY, { httpClient: Stripe.createFetchHttpClient() }) : null
const APP_URL_FIXO = (Deno.env.get('APP_URL') ?? '').replace(/\/+$/, '')

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
})

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Método não permitido' }, 405)

  try {
    const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
      auth: { persistSession: false },
    })
    const { data: { user } } = await userClient.auth.getUser()
    if (!user) throw new HttpError(401, 'Não autenticado')
    const { data: perfil } = await userClient.from('users').select('organization_id, role, is_active').eq('id', user.id).single()
    if (!perfil?.is_active || perfil.role !== 'admin') throw new HttpError(403, 'Só administradores gerenciam a assinatura')
    const org = perfil.organization_id as string

    const body = await req.json().catch(() => ({}))
    const action = String(body?.action ?? '')
    if (action === 'configured') return json({ configured: Boolean(stripe) })

    const { data: sub } = await admin.from('subscriptions').select('*').eq('organization_id', org).maybeSingle()
    if (!sub) throw new HttpError(404, 'Assinatura não encontrada')

    const base = APP_URL_FIXO || (req.headers.get('origin') ?? '').replace(/\/+$/, '')

    // Plano escolhido (cartão ou Pix): confere se o uso atual cabe nele.
    const planoEscolhido = async () => {
      const planId = String(body?.plan_id ?? '')
      const { data: plano } = await admin.from('plans').select('*').eq('id', planId).eq('active', true).maybeSingle()
      if (!plano) throw new HttpError(400, 'Plano inválido')
      const { data: uso } = await admin.rpc('org_uso', { p_org: org })
      if ((uso?.whatsapps ?? 0) > plano.max_whatsapps) {
        throw new HttpError(400, `Você usa ${uso.whatsapps} números e o plano ${plano.name} permite ${plano.max_whatsapps}. Remova números antes de trocar.`)
      }
      if ((uso?.agents ?? 0) > plano.max_agents) {
        throw new HttpError(400, `Você tem ${uso.agents} atendentes e o plano ${plano.name} permite ${plano.max_agents}. Desative atendentes antes de trocar.`)
      }
      return plano as { id: string; name: string; price_cents: number }
    }

    // ---------- Pix (registrado à mão) ----------
    if (action === 'pix') {
      const plano = await planoEscolhido()
      // Quem tinha cartão agendado para cancelar no fim do período não é cobrado de novo.
      if (stripe && sub.stripe_subscription_id) {
        await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true }).catch(() => null)
      }
      await admin.from('subscriptions').update({
        plan_id: plano.id, payment_mode: 'pix', updated_at: new Date().toISOString(),
      }).eq('organization_id', org)
      return json({ ok: true })
    }

    // ---------- Cartão (Stripe) ----------
    if (!stripe) throw new HttpError(503, 'O pagamento por cartão ainda não foi configurado. Fale com o suporte.')
    if (!base) throw new HttpError(500, 'Endereço do sistema não configurado (secret APP_URL).')

    if (action === 'portal') {
      if (!sub.stripe_customer_id) throw new HttpError(400, 'Você ainda não assinou no cartão.')
      const s = await stripe.billingPortal.sessions.create({
        customer: sub.stripe_customer_id, return_url: `${base}/crm`,
      })
      return json({ url: s.url })
    }

    if (action === 'cancel') {
      if (!sub.stripe_subscription_id) throw new HttpError(400, 'Não há assinatura no cartão para cancelar.')
      await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true })
      await admin.from('subscriptions').update({ cancel_at_period_end: true, updated_at: new Date().toISOString() }).eq('organization_id', org)
      return json({ ok: true })
    }

    if (action === 'checkout') {
      const plano = await planoEscolhido()

      // Cliente no Stripe (uma vez).
      let customer = sub.stripe_customer_id as string | null
      if (!customer) {
        const c = await stripe.customers.create({
          name: sub.billing_name || undefined,
          email: sub.billing_email || undefined,
          metadata: { organization_id: org, doc: sub.billing_doc ?? '' },
        })
        customer = c.id
        await admin.from('subscriptions').update({ stripe_customer_id: customer }).eq('organization_id', org)
      }

      const priceData = (product?: string) => ({
        currency: 'brl',
        unit_amount: plano.price_cents,
        recurring: { interval: 'month' as const },
        ...(product ? { product } : { product_data: { name: `Infuse CRM · plano ${plano.name}` } }),
      })

      // Já assina no cartão: troca o valor (proporcional) em vez de abrir outro pagamento.
      if (sub.stripe_subscription_id) {
        const atual = await stripe.subscriptions.retrieve(sub.stripe_subscription_id)
        if (atual.status !== 'canceled') {
          const item = atual.items.data[0]
          const produto = typeof item.price.product === 'string' ? item.price.product : item.price.product.id
          await stripe.subscriptions.update(atual.id, {
            items: [{ id: item.id, price_data: priceData(produto) }],
            cancel_at_period_end: false,
            proration_behavior: 'create_prorations',
          })
          await admin.from('subscriptions').update({
            plan_id: plano.id, payment_mode: 'cartao', cancel_at_period_end: false, updated_at: new Date().toISOString(),
          }).eq('organization_id', org)
          return json({ url: `${base}/crm` })
        }
      }

      // Primeira assinatura: o que sobrou do teste grátis vira o período de teste do Stripe,
      // então o cartão fica cadastrado e a primeira cobrança só vem no fim do teste.
      const diasTeste = sub.trial_ends_at && sub.status === 'trial'
        ? Math.ceil((new Date(sub.trial_ends_at).getTime() - Date.now()) / 86_400_000)
        : 0

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer,
        client_reference_id: org,
        payment_method_types: ['card'],
        locale: 'pt-BR',
        line_items: [{ quantity: 1, price_data: priceData() }],
        subscription_data: {
          metadata: { organization_id: org, plan_id: plano.id },
          ...(diasTeste >= 1 ? { trial_period_days: Math.min(diasTeste, 730) } : {}),
        },
        success_url: `${base}/crm?assinatura=ok`,
        cancel_url: `${base}/crm?assinatura=cancelada`,
      })
      // O plano (limites) vale já; o pagamento confirma o acesso depois do teste.
      await admin.from('subscriptions').update({
        plan_id: plano.id, payment_mode: 'cartao', updated_at: new Date().toISOString(),
      }).eq('organization_id', org)
      if (!session.url) throw new HttpError(502, 'O Stripe não devolveu a página de pagamento.')
      return json({ url: session.url })
    }

    throw new HttpError(400, 'Ação desconhecida')
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status)
    if (err instanceof Stripe.errors.StripeError) {
      console.error('[billing] stripe', err.type, err.message)
      return json({ error: `Pagamento: ${err.message}` }, 502)
    }
    console.error('[billing]', err instanceof Error ? err.message : err)
    return json({ error: 'Erro interno. Tente de novo.' }, 500)
  }
})
