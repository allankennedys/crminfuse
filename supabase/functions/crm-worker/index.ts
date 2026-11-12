/**
 * Edge Function: crm-worker
 *
 * Entrega os eventos de conversão do CRM para a Meta Conversion API.
 * Acionada pelo pg_cron a cada 30 minutos (043), até BATCH_SIZE eventos por
 * execução, dos mais antigos para os mais novos. Roda com service role e
 * processa todas as organizações.
 *
 * A cadência é folgada de propósito: enquanto o evento está na fila, corrigir
 * a venda no painel corrige o valor que vai sair (042). Depois de enviado não
 * há conserto possível do lado da Meta.
 *
 * Só sai daqui conversão de contato que veio de anúncio (migrations 032/033/
 * 071), por um de três caminhos, marcados pelo banco em payload.ad_source:
 *
 *   ctwa   — clique de anúncio abriu o WhatsApp. Atribuído pelo ctwa_clid,
 *            como mensageria (business_messaging + page_id).
 *   site   — o anúncio caiu numa landing e o lead veio de lá para o
 *            WhatsApp. Atribuído pelo fbc (o clique gravado pelo pixel),
 *            como evento de site (website + event_source_url).
 *   origem — anúncio declarado só no cadastro, sem clique nenhum
 *            capturado. Vai como system_generated, sem afirmar anúncio.
 *
 * Conversão que não é de anúncio não é enviada — inflaria o total de
 * Purchase do pixel sem que nenhuma mídia tenha gerado a venda.
 *
 * Desde a 072 o evento é de uma VENDA, não do contato: cliente de anúncio
 * que compra de novo gera um Purchase novo, com o valor daquela compra e o
 * mesmo clique da aquisição. Quem garante que cada venda sai uma vez só é
 * o banco; aqui o event_id (id da linha da fila) e o order_id (id da venda)
 * são as duas barreiras do lado da Meta.
 *
 * Por que existe uma fila (crm_events) em vez de chamar a Meta na hora:
 *  - o trigger do banco não pode fazer HTTP de forma confiável;
 *  - a Meta pode estar fora do ar — com fila, o evento é reprocessado;
 *  - arrastar o card fica instantâneo na tela, sem esperar rede externa;
 *  - o mesmo caminho serve para eventos vindos da UI e da API HTTP.
 *
 * Auth: header x-worker-secret, igual ao worker de mensagens.
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WORKER_SECRET
 */

import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-worker-secret',
}

const META_API_VERSION = 'v21.0'
const BATCH_SIZE = 25
/** Depois disso o evento para de ser tentado e fica como falha visível. */
const MAX_ATTEMPTS = 5

const svc = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

interface CrmEvent {
  id: string
  organization_id: string
  contact_id: string | null
  event_type: string
  attempts: number
  payload: Record<string, unknown>
  created_at: string
}

interface OrgSettings {
  meta_pixel_id: string | null
  meta_access_token: string | null
  meta_test_event_code: string | null
  /** Página que veicula os anúncios: exigida pela Meta em eventos de CTWA. */
  meta_page_id: string | null
}

/** Caminho pelo qual a conversão vai para a Meta. Ver cabeçalho. */
type AdPath = 'ctwa' | 'site' | 'origem'

/** Campo de texto do payload, já aparado. Ausente ou não-string vira ''. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Qual caminho este evento usa — null quando ele não deve sair.
 *
 * A marca vem do banco (crm_enqueue_conversion). Evento sem marca é fila
 * antiga, de antes da 033: nela só o clique de CTWA ia para a Meta, então
 * é isso que ele continua valendo. Sem nem isso, não sai.
 */
function adPath(payload: Record<string, unknown>): AdPath | null {
  const declared = payload.ad_source
  if (declared === 'ctwa' || declared === 'site' || declared === 'origem') return declared
  return text(payload.ctwaclid) ? 'ctwa' : null
}

/**
 * A Meta exige os dados pessoais em sha256, minúsculos e sem espaços.
 * Telefone vai só com dígitos (com DDI), e-mail em minúsculas.
 */
async function hash(value: string): Promise<string> {
  const normalized = value.trim().toLowerCase()
  const bytes = new TextEncoder().encode(normalized)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Até onde a Conversions API aceita um evento no passado. Sete dias é o
 * limite da Meta; um segundo além disso e a resposta é erro permanente.
 */
const JANELA_META_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Quando a compra aconteceu, na régua da Meta.
 *
 * O padrão é a data da VENDA (`payload.sold_at`, gravado no enfileiramento
 * pela 077). Venda lançada com atraso — ou que só agora encontrou o cadastro
 * certo, numa unificação de contatos — precisa cair no dia em que o dinheiro
 * entrou, que é o mesmo dia que o relatório de Vendas mostra. Sem isto ela
 * entraria no Gerenciador com a data de hoje, e as duas telas divergiriam sem
 * explicação.
 *
 * FORA DA JANELA, A DATA REAL NÃO É OPÇÃO. Passando de 7 dias a Meta recusa
 * de vez, e o evento morre com erro permanente — a venda não chegaria de
 * jeito nenhum. Aí vale o instante do enfileiramento: a compra entra no
 * dataset com a data errada, mas entra. O mesmo caminho serve para evento
 * anterior à 077, que não tem `sold_at` no payload.
 */
function eventTime(event: { created_at: string; payload: Record<string, unknown> }): number {
  const agora = Date.now()
  const bruto = text(event.payload.sold_at)
  if (bruto) {
    const venda = new Date(bruto).getTime()
    // Data futura também é recusada pela Meta — e uma venda com data de
    // amanhã é erro de digitação, não motivo para perder a conversão.
    if (Number.isFinite(venda) && venda <= agora && agora - venda < JANELA_META_MS) {
      return Math.floor(venda / 1000)
    }
  }
  return Math.floor(new Date(event.created_at).getTime() / 1000)
}

/** DDD → UF. Cobre todos os DDDs em uso no Brasil. */
const UF_POR_DDD: Record<string, string> = {}
for (const [uf, ddds] of Object.entries({
  sp: '11 12 13 14 15 16 17 18 19', rj: '21 22 24', es: '27 28',
  mg: '31 32 33 34 35 37 38', pr: '41 42 43 44 45 46', sc: '47 48 49',
  rs: '51 53 54 55', df: '61', go: '62 64', to: '63', mt: '65 66',
  ms: '67', ac: '68', ro: '69', ba: '71 73 74 75 77', se: '79',
  pe: '81 87', al: '82', pb: '83', rn: '84', ce: '85 88', pi: '86 89',
  ma: '98 99', pa: '91 93 94', am: '92 97', ap: '96', rr: '95',
})) {
  for (const d of ddds.split(' ')) UF_POR_DDD[d] = uf
}

/**
 * UF a partir do DDD do telefone. Sem IP (CTWA e conversão de origem) é a
 * única localização que temos. Aproximada: o DDD diz onde a linha foi
 * habilitada, não onde a pessoa está agora.
 */
function ufDoTelefone(phone: string): string {
  // Com DDI (55 + DDD + 8/9 dígitos = 12/13) ou sem (DDD + 8/9 = 10/11).
  const nacional = phone.length >= 12 && phone.startsWith('55') ? phone.slice(2) : phone
  if (nacional.length < 10 || nacional.length > 11) return ''
  // Celular brasileiro tem 9 depois do DDD. Barra número estrangeiro de 11
  // dígitos (ex.: EUA), cujos dois primeiros dígitos poderiam bater com um DDD.
  if (nacional.length === 11 && nacional[2] !== '9') return ''
  return UF_POR_DDD[nacional.slice(0, 2)] ?? ''
}

/** Monta o user_data já hasheado, omitindo o que o contato não tiver. */
async function buildUserData(payload: Record<string, unknown>) {
  const userData: Record<string, string[]> = {}

  const email = typeof payload.email === 'string' ? payload.email : ''
  if (email) userData.em = [await hash(email)]

  const phone = typeof payload.phone === 'string' ? payload.phone.replace(/\D/g, '') : ''
  if (phone) {
    userData.ph = [await hash(phone)]
    const uf = ufDoTelefone(phone)
    if (uf) {
      userData.st = [await hash(uf)]
      userData.country = [await hash('br')]
    }
  }

  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  if (name) {
    const [first, ...rest] = name.split(/\s+/)
    if (first) userData.fn = [await hash(first)]
    if (rest.length) userData.ln = [await hash(rest.join(' '))]
  }

  return userData
}

interface MetaError {
  message?: string
  error_subcode?: number
  error_user_title?: string
  error_user_msg?: string
  fbtrace_id?: string
}

/**
 * `message` sozinho é quase sempre "Invalid parameter", que não diz nada —
 * o motivo real vem em error_user_msg/error_subcode. Guardar só a mensagem
 * já custou uma investigação inteira para descobrir que faltava o WABA ID.
 */
function formatMetaError(err: MetaError | undefined, status: number): string {
  if (!err) return `HTTP ${status}`

  const parts = [err.message ?? `HTTP ${status}`]
  if (err.error_subcode) parts.push(`subcode ${err.error_subcode}`)
  if (err.error_user_msg) parts.push(err.error_user_msg)
  else if (err.error_user_title) parts.push(err.error_user_title)
  if (err.fbtrace_id) parts.push(`fbtrace ${err.fbtrace_id}`)

  return parts.join(' | ')
}

async function sendToMeta(event: CrmEvent, settings: OrgSettings, path: AdPath) {
  const userData: Record<string, unknown> = await buildUserData(event.payload)

  const landingUrl = text(event.payload.landing_url)
  const userAgent = text(event.payload.user_agent)

  if (path === 'ctwa') {
    // ctwa_clid = ID do clique no anúncio Click-to-WhatsApp. É por ele que a
    // Meta atribui a conversão ao anúncio/campanha certos. Vai SEM hash, como
    // string (diferente de e-mail/telefone/nome, que são hasheados).
    userData.ctwa_clid = text(event.payload.ctwaclid)
    // O clique sozinho não basta: a Meta exige saber de qual ativo do
    // negócio veio a conversa (subcode 2804116) e valida que o ctwa_clid
    // nasceu nessa Página (subcode 2804072 quando não bate). Página errada
    // falha alto — não vira atribuição silenciosa para o anúncio errado.
    userData.page_id = settings.meta_page_id
  } else {
    // Funil de site. O fbc é o equivalente do ctwa_clid aqui: carrega o
    // fbclid do clique no anúncio e vai sem hash. Os outros três não
    // atribuem nada sozinhos — melhoram o casamento do usuário, e o par
    // IP + User-Agent tem de ser o do NAVEGADOR do lead, nunca o desta
    // função (seria o mesmo par para todo mundo e pioraria o casamento).
    const fbc = text(event.payload.fbc)
    const fbp = text(event.payload.fbp)
    const clientIp = text(event.payload.client_ip)
    if (fbc) userData.fbc = fbc
    if (fbp) userData.fbp = fbp
    if (clientIp) userData.client_ip_address = clientIp
    if (userAgent) userData.client_user_agent = userAgent
  }

  // Evento de site exige User-Agent e URL de origem; sem os dois a Meta
  // recusa. Faltando algum, o evento ainda sai — com o fbc no user_data e
  // como conversão gerada pelo sistema, que é o que dá para afirmar.
  const asWebsite = path === 'site' && userAgent !== '' && landingUrl !== ''

  // Sem NENHUM identificador não há evento possível: a Meta rejeita e
  // insistir não muda nada. Falha definitiva em vez de gastar as 5
  // tentativas em algo que nunca passa.
  if (Object.keys(userData).length === 0) {
    return {
      ok: false,
      permanent: true,
      error: 'Contato sem identificador (e-mail, telefone, nome ou clique do pixel) para o evento',
    }
  }

  const valueCents = Number(event.payload.value_cents ?? 0)
  const saleId = text(event.payload.sale_id)

  const body: Record<string, unknown> = {
    data: [{
      event_name: 'Purchase',
      event_time: eventTime(event),
      // Chave de deduplicação da própria Meta: reenviar o mesmo id é
      // ignorado do lado deles. Segunda barreira além da checagem no trigger.
      event_id: event.id,
      // Onde a conversão nasceu, na linguagem da Meta: mensageria quando o
      // clique abriu o WhatsApp, site quando o clique caiu na landing (é lá
      // que os identificadores foram coletados), e conversão gerada pelo
      // sistema quando não houve clique nenhum para amarrar.
      action_source: path === 'ctwa'
        ? 'business_messaging'
        : asWebsite ? 'website' : 'system_generated',
      ...(path === 'ctwa' ? { messaging_channel: 'whatsapp' } : {}),
      ...(asWebsite ? { event_source_url: landingUrl } : {}),
      user_data: userData,
      custom_data: {
        currency: 'BRL',
        value: valueCents / 100,
        // Id da venda no CRM. Serve de segunda chave de deduplicação do
        // lado da Meta — que passa a importar desde a 072, quando o mesmo
        // cliente virou vários Purchase: sem ela, duas vendas do mesmo dia
        // e do mesmo valor são indistinguíveis de um envio repetido.
        // Ausente na conversão que veio da etapa, sem venda registrada.
        ...(saleId ? { order_id: saleId } : {}),
      },
    }],
  }

  if (settings.meta_test_event_code) {
    body.test_event_code = settings.meta_test_event_code
  }

  const url = `https://graph.facebook.com/${META_API_VERSION}/${settings.meta_pixel_id}/events`
     + `?access_token=${encodeURIComponent(settings.meta_access_token!)}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const data = await res.json().catch(() => null) as { error?: MetaError } | null

  if (!res.ok) {
    // 4xx é erro de configuração (pixel/token errado, payload inválido):
    // insistir não resolve. 5xx e rede são temporários.
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 429
    return {
      ok: false,
      permanent,
      error: formatMetaError(data?.error, res.status),
    }
  }

  return { ok: true, permanent: false, error: null }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const secret = Deno.env.get('WORKER_SECRET')
  if (!secret || req.headers.get('x-worker-secret') !== secret) {
    return json({ error: 'Não autorizado' }, 401)
  }

  const { data: events } = await svc
    .from('crm_events')
    .select('id, organization_id, contact_id, event_type, attempts, payload, created_at')
    .eq('status', 'pending')
    .lt('attempts', MAX_ATTEMPTS)
    .order('created_at')
    .limit(BATCH_SIZE)
    .returns<CrmEvent[]>()

  if (!events?.length) return json({ ok: true, processed: 0 })

  // Configuração é por organização: busca uma vez por org, não por evento.
  const orgIds = [...new Set(events.map((e) => e.organization_id))]
  const { data: settingsRows } = await svc
    .from('crm_settings')
    .select('organization_id, meta_pixel_id, meta_access_token, meta_test_event_code, meta_page_id')
    .in('organization_id', orgIds)
    .returns<Array<OrgSettings & { organization_id: string }>>()

  const byOrg = new Map((settingsRows ?? []).map((s) => [s.organization_id, s]))

  let sent = 0
  let failed = 0
  let skipped = 0

  for (const event of events) {
    const settings = byOrg.get(event.organization_id)
    const attempts = event.attempts + 1

    // Só conversão de anúncio vai para a Meta (032/033/071), por um dos três
    // caminhos marcados pelo banco em payload.ad_source. Sem caminho, não
    // sai. Vem antes da checagem de configuração de propósito — o que não
    // pode sair não sai nem com pixel, token e Página corretos.
    const path = adPath(event.payload)
    if (!path) {
      skipped++
      await svc.from('crm_events')
        .update({
          status: 'skipped',
          error: 'Contato não veio de anúncio: conversão não é enviada à Meta',
        })
        .eq('id', event.id)
      continue
    }

    // Org sem Meta configurada: o evento fica pendente, sem gastar tentativa.
    // Assim que o usuário salvar pixel e token, a fila escoa sozinha.
    if (!settings?.meta_pixel_id || !settings.meta_access_token) continue

    // Mesma ideia para a Página: evento de CTWA sem ela seria recusado
    // (subcode 2804116) e queimaria as 5 tentativas por um problema que só
    // o usuário resolve. Fica pendente e escoa sozinho quando for salva.
    // Só vale para o caminho do clique: os outros dois não usam page_id.
    if (path === 'ctwa' && !settings.meta_page_id) continue

    let result: { ok: boolean; permanent: boolean; error: string | null }
    try {
      result = await sendToMeta(event, settings, path)
    } catch (err) {
      result = { ok: false, permanent: false, error: err instanceof Error ? err.message : 'Falha de rede' }
    }

    if (result.ok) {
      sent++
      await svc.from('crm_events')
        .update({ status: 'sent', attempts, sent_at: new Date().toISOString(), error: null })
        .eq('id', event.id)
    } else {
      failed++
      const giveUp = result.permanent || attempts >= MAX_ATTEMPTS
      await svc.from('crm_events')
        .update({ status: giveUp ? 'failed' : 'pending', attempts, error: result.error })
        .eq('id', event.id)
    }
  }

  return json({ ok: true, processed: events.length, sent, failed, skipped })
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
