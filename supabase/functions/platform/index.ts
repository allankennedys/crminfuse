/**
 * Edge Function: platform  (JWT; só o dono da plataforma, secret OWNER_EMAIL)
 *
 *   { action: 'orgs' }                                   → { orgs: [...] }  organizações, plano, status e uso
 *   { action: 'plans' }                                  → { plans: [...] }
 *   { action: 'save_plan', plan }                        → { ok }           cria/edita plano
 *   { action: 'set_subscription', organization_id, ... } → { ok }           plano, status, cortesia, dias de teste a somar
 *   { action: 'register_payment', organization_id, months? } → { ok }       Pix recebido: ativa e estende o período
 *   { action: 'pix_settings' } / { action: 'save_pix_settings', pix_key, pix_holder, pix_contact }
 */
import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
}
const OWNER_EMAIL = (Deno.env.get('OWNER_EMAIL') ?? '').toLowerCase()

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
})

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
    if (!user) return json({ error: 'Não autenticado' }, 401)
    if (!OWNER_EMAIL || (user.email ?? '').toLowerCase() !== OWNER_EMAIL) {
      return json({ error: 'Só o dono da plataforma' }, 403)
    }

    const body = await req.json().catch(() => ({}))
    const action = String(body?.action ?? '')

    if (action === 'pix_settings') {
      const { data } = await admin.from('platform_settings').select('key, value').in('key', ['pix_key', 'pix_holder', 'pix_contact'])
      return json({ settings: Object.fromEntries((data ?? []).map((r) => [r.key, r.value])) })
    }

    if (action === 'save_pix_settings') {
      const rows = (['pix_key', 'pix_holder', 'pix_contact'] as const)
        .map((k) => ({ key: k, value: String(body?.[k] ?? '').trim().slice(0, 200) }))
        .filter((r) => r.value !== '')
      const vazios = (['pix_key', 'pix_holder', 'pix_contact'] as const).filter((k) => !String(body?.[k] ?? '').trim())
      if (vazios.length) await admin.from('platform_settings').delete().in('key', vazios)
      if (rows.length) {
        const { error } = await admin.from('platform_settings').upsert(rows)
        if (error) return json({ error: 'Falha ao salvar.' }, 500)
      }
      return json({ ok: true })
    }

    if (action === 'register_payment') {
      const org = String(body?.organization_id ?? '')
      const meses = Math.min(12, Math.max(1, Math.round(Number(body?.months ?? 1)) || 1))
      const { data: s } = await admin.from('subscriptions').select('current_period_end').eq('organization_id', org).maybeSingle()
      if (!s) return json({ error: 'Organização sem assinatura' }, 404)
      // Pagou antes de vencer: soma ao período que já tinha; vencido: conta de hoje.
      const base = s.current_period_end && new Date(s.current_period_end).getTime() > Date.now() ? new Date(s.current_period_end) : new Date()
      base.setUTCMonth(base.getUTCMonth() + meses)
      const agora = new Date().toISOString()
      const { error } = await admin.from('subscriptions').update({
        status: 'ativa', payment_mode: 'pix', overdue_since: null, cancel_at_period_end: false,
        current_period_end: base.toISOString(), last_payment_at: agora, updated_at: agora,
      }).eq('organization_id', org)
      if (error) return json({ error: 'Falha ao registrar.' }, 500)
      return json({ ok: true, current_period_end: base.toISOString() })
    }

    if (action === 'plans') {
      const { data } = await admin.from('plans').select('*').order('position')
      return json({ plans: data ?? [] })
    }

    if (action === 'save_plan') {
      const p = body?.plan ?? {}
      const row = {
        id: String(p.id ?? '').trim().toLowerCase(),
        name: String(p.name ?? '').trim(),
        price_cents: Math.round(Number(p.price_cents)),
        max_whatsapps: Math.round(Number(p.max_whatsapps)),
        max_agents: Math.round(Number(p.max_agents)),
        position: Math.round(Number(p.position ?? 0)),
        active: p.active !== false,
      }
      if (!/^[a-z0-9_-]{2,30}$/.test(row.id) || !row.name) return json({ error: 'Plano inválido (identificador e nome).' }, 400)
      if (![row.price_cents, row.max_whatsapps, row.max_agents].every(Number.isFinite) || row.price_cents < 0 || row.max_whatsapps < 1 || row.max_agents < 0) {
        return json({ error: 'Valores do plano inválidos.' }, 400)
      }
      const { error } = await admin.from('plans').upsert(row)
      if (error) return json({ error: 'Falha ao salvar o plano.' }, 500)
      return json({ ok: true })
    }

    if (action === 'orgs') {
      const { data: orgs } = await admin
        .from('organizations')
        .select('id, name, created_at, subscriptions(plan_id, status, trial_ends_at, overdue_since, courtesy, billing_email, payment_mode, current_period_end, last_payment_at)')
        .order('created_at', { ascending: false })
      const out = []
      for (const o of orgs ?? []) {
        const { data: uso } = await admin.rpc('org_uso', { p_org: o.id })
        const { data: acesso } = await admin.rpc('org_acesso', { p_org: o.id })
        // deno-lint-ignore no-explicit-any
        const s: any = Array.isArray(o.subscriptions) ? o.subscriptions[0] : o.subscriptions
        out.push({ id: o.id, name: o.name, created_at: o.created_at, subscription: s ?? null, uso, acesso })
      }
      return json({ orgs: out })
    }

    if (action === 'set_subscription') {
      const org = String(body?.organization_id ?? '')
      if (!org) return json({ error: 'Organização não informada' }, 400)
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (typeof body?.plan_id === 'string') {
        const { data: pl } = await admin.from('plans').select('id').eq('id', body.plan_id).maybeSingle()
        if (!pl) return json({ error: 'Plano inexistente' }, 400)
        patch.plan_id = body.plan_id
      }
      if (['trial', 'ativa', 'atrasada', 'cancelada'].includes(body?.status)) {
        patch.status = body.status
        if (body.status === 'ativa') patch.overdue_since = null
      }
      if (typeof body?.courtesy === 'boolean') patch.courtesy = body.courtesy
      if (['cartao', 'pix'].includes(body?.payment_mode)) patch.payment_mode = body.payment_mode
      const dias = Number(body?.add_trial_days)
      if (Number.isFinite(dias) && dias > 0 && dias <= 365) {
        const { data: s } = await admin.from('subscriptions').select('trial_ends_at').eq('organization_id', org).maybeSingle()
        const base = s?.trial_ends_at && new Date(s.trial_ends_at).getTime() > Date.now() ? new Date(s.trial_ends_at) : new Date()
        base.setUTCDate(base.getUTCDate() + Math.round(dias))
        patch.trial_ends_at = base.toISOString()
        patch.status = patch.status ?? 'trial'
      }
      const { error } = await admin.from('subscriptions').update(patch).eq('organization_id', org)
      if (error) return json({ error: 'Falha ao salvar.' }, 500)
      return json({ ok: true })
    }

    return json({ error: 'Ação desconhecida' }, 400)
  } catch (err) {
    console.error('[platform]', err instanceof Error ? err.message : err)
    return json({ error: 'Erro interno' }, 500)
  }
})
