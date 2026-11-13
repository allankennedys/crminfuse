/**
 * Edge Function: stripe-webhook  (sem JWT; confere a assinatura do Stripe)
 *
 * No painel do Stripe (Desenvolvedores → Webhooks): URL desta função e os
 * eventos abaixo; o "signing secret" (whsec_…) vai no secret STRIPE_WEBHOOK_SECRET.
 *
 *   checkout.session.completed        → liga o cliente/assinatura do Stripe à organização
 *   invoice.paid (valor > 0)          → ativa e estende o período pago
 *   invoice.payment_failed            → atrasada (só de quem já pagava)
 *   customer.subscription.updated     → marca "cancela no fim do período"
 *   customer.subscription.deleted     → cancelada
 *
 * Responde 200 para eventos que não usa (o Stripe reenviaria). 400 se a
 * assinatura não confere, 500 se a falha for nossa (ele reenvia).
 */
import { createClient } from 'npm:@supabase/supabase-js@2'
import Stripe from 'npm:stripe@17.7.0'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? 'sk_missing', { httpClient: Stripe.createFetchHttpClient() })
const SEGREDO = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
})

/** Organização pelo id da assinatura no Stripe. */
async function porAssinatura(id: string | null | undefined) {
  if (!id) return null
  const { data } = await admin
    .from('subscriptions').select('organization_id, status, overdue_since').eq('stripe_subscription_id', id).maybeSingle()
  return data
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok')
  if (!SEGREDO) return new Response('webhook não configurado', { status: 500 })

  let ev: Stripe.Event
  try {
    // O corpo precisa ser o texto original: a assinatura é calculada sobre ele.
    ev = await stripe.webhooks.constructEventAsync(await req.text(), req.headers.get('stripe-signature') ?? '', SEGREDO)
  } catch {
    return new Response('assinatura inválida', { status: 400 })
  }

  try {
    const agora = new Date().toISOString()

    if (ev.type === 'checkout.session.completed') {
      const s = ev.data.object as Stripe.Checkout.Session
      const org = s.client_reference_id
      if (org && s.subscription) {
        await admin.from('subscriptions').update({
          stripe_customer_id: typeof s.customer === 'string' ? s.customer : s.customer?.id ?? null,
          stripe_subscription_id: typeof s.subscription === 'string' ? s.subscription : s.subscription.id,
          payment_mode: 'cartao',
          updated_at: agora,
        }).eq('organization_id', org)
      }
    } else if (ev.type === 'invoice.paid') {
      const inv = ev.data.object as Stripe.Invoice & { subscription?: string | null }
      // Fatura de R$ 0 (início do teste) não é pagamento.
      if ((inv.amount_paid ?? 0) > 0) {
        const subId = inv.subscription
          ?? (inv as unknown as { parent?: { subscription_details?: { subscription?: string } } }).parent?.subscription_details?.subscription
        const sub = await porAssinatura(subId)
        if (sub) {
          const fim = inv.lines?.data?.[0]?.period?.end
          await admin.from('subscriptions').update({
            status: 'ativa', overdue_since: null, last_payment_at: agora, updated_at: agora,
            ...(fim ? { current_period_end: new Date(fim * 1000).toISOString() } : {}),
          }).eq('organization_id', sub.organization_id)
        }
      }
    } else if (ev.type === 'invoice.payment_failed') {
      const inv = ev.data.object as Stripe.Invoice & { subscription?: string | null }
      const subId = inv.subscription
        ?? (inv as unknown as { parent?: { subscription_details?: { subscription?: string } } }).parent?.subscription_details?.subscription
      const sub = await porAssinatura(subId)
      // Só quem já pagava entra em atraso; o teste que acabou segue as regras do teste.
      if (sub && sub.status === 'ativa') {
        await admin.from('subscriptions').update({
          status: 'atrasada', overdue_since: sub.overdue_since ?? agora, updated_at: agora,
        }).eq('organization_id', sub.organization_id)
      }
    } else if (ev.type === 'customer.subscription.updated') {
      const s = ev.data.object as Stripe.Subscription
      const sub = await porAssinatura(s.id)
      if (sub) {
        await admin.from('subscriptions').update({ cancel_at_period_end: s.cancel_at_period_end, updated_at: agora })
          .eq('organization_id', sub.organization_id)
      }
    } else if (ev.type === 'customer.subscription.deleted') {
      const s = ev.data.object as Stripe.Subscription
      const sub = await porAssinatura(s.id)
      if (sub) {
        await admin.from('subscriptions').update({
          status: 'cancelada', cancel_at_period_end: false, updated_at: agora,
          current_period_end: s.ended_at ? new Date(s.ended_at * 1000).toISOString() : agora,
        }).eq('organization_id', sub.organization_id)
      }
    }
    return new Response('ok')
  } catch (err) {
    console.error('[stripe-webhook]', err instanceof Error ? err.message : err)
    return new Response('erro', { status: 500 })
  }
})
