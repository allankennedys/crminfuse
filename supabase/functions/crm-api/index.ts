/**
 * Edge Function: crm-api
 *
 * Endpoint HTTP para automações externas (n8n, bots, integrações) criarem
 * e moverem contatos sem passar pelo painel.
 *
 *   POST /functions/v1/crm-api
 *   Header: x-api-key: phc_...
 *
 * As ações de leitura (lookup, metrics) aceitam também GET com os parâmetros
 * na query string, para quem só sabe buscar uma URL (Google Sheets, Looker
 * Studio, um cron com curl). As que escrevem exigem POST.
 *
 * Oito ações:
 *
 *   lookup — o contato já existe? (só leitura)
 *     { "action": "lookup", "phone": "5511999999999" }
 *
 *     Responde { exists: false } ou, existindo, os dados do contato mais
 *     hasPurchased/nextSaleIsFirst — atalhos para a automação decidir entre
 *     primeira venda e recompra sem interpretar números.
 *
 *   metrics — números de vendas do período (só leitura)
 *     { "action": "metrics", "from": "2026-07-01", "to": "2026-07-31" }
 *
 *     GET /functions/v1/crm-api?action=metrics&from=2026-07-01&to=2026-07-31
 *     (por GET, metrics é o padrão: a URL sem parâmetro nenhum já responde)
 *
 *     from/to são dias em São Paulo, formato AAAA-MM-DD, ambos inclusive.
 *     Omitidos, a janela é dos últimos 30 dias. channel filtra por canal do
 *     contato e vale também para o histórico.
 *
 *     Responde dois blocos. "periodo" é o fluxo da janela; "historico" é tudo
 *     que já foi vendido, ignorando from/to. Em cada um:
 *       avgTicketCents = receita ÷ VENDAS    — quanto vale uma venda
 *       ltvCents       = receita ÷ CLIENTES  — quanto vale um cliente
 *     Os dois só coincidem quando ninguém recompra; a diferença é a recompra.
 *
 *     Use historico.ltvCents como LTV — é o único que enxerga o cliente
 *     inteiro. O equivalente do período chama-se revenuePerClientCents
 *     justamente porque não é LTV: só conta o que coube na janela.
 *
 *     Todo valor vem em CENTAVOS, inteiro. Nada de float em dinheiro.
 *
 *   move (padrão no POST) — muda o contato de etapa
 *     { "conversationId": "...", "stageName": "Ganho" }
 *     { "contactId": "...",      "stageId": "..." }
 *
 *   sale — registra uma venda do contato
 *     { "action": "sale", "phone": "5511999999999",
 *       "creatives": 3, "value": 1500.00, "tags": ["cliente"],
 *       "soldAt": "2026-07-28", "externalId": "pedido-9912",
 *       "paymentMethod": "pix" }
 *
 *     paymentMethod aceita pix, credito, debito ou boleto (sem acento, sem
 *     caixa). Omitido, a venda fica "não informada" — o painel exige, a
 *     automação não, porque nem todo fluxo sabe como o cliente pagou.
 *
 *     tags SUBSTITUI as etiquetas do contato (mesma regra do upsert): [] as
 *     apaga, omitir deixa como estão.
 *
 *     Localiza o contato pelo TELEFONE — a chave que sempre existe. Aceita
 *     também contactId (id interno, tem precedência) e conversationId, que
 *     é opcional e fica como último recurso.
 *     A PRIMEIRA venda do cliente move o contato para a etapa de conversão —
 *     é o trigger do banco (031) que faz isso, o mesmo caminho da tela. As
 *     demais ficam registradas sem mexer no funil. Para a Meta vai CADA
 *     venda de contato de anúncio, com o valor dela (072); quem não veio de
 *     anúncio não gera evento nenhum (032/033/071).
 *
 *     externalId é a chave de idempotência: reenviar o mesmo id devolve a
 *     venda que já existe, sem lançar de novo. Use SEMPRE que o número do
 *     pedido existir do outro lado — n8n repete request em timeout.
 *
 *     kirvanoSaleId (opcional, aqui e no upsert) é o id da venda na Kirvano
 *     (105). É por ele que o refund acha a venda quando o reembolso chega de
 *     lá. Também é único: reenviar o mesmo devolve a venda que já existe.
 *
 *   sales — as vendas do cliente, uma a uma (só leitura)
 *     { "action": "sales", "phone": "5511999999999" }
 *     { "action": "sales", "externalId": "pedido-9912" }
 *     { "action": "sales", "saleId": "..." }
 *     { "action": "sales", "kirvanoSaleId": "..." }
 *
 *     Pelo telefone, traz as vendas de TODOS os cadastros do número — PH e
 *     Pedro juntos, cada venda dizendo o canal dela. Mandando channel, só
 *     daquele cadastro. externalId, saleId e kirvanoSaleId trazem aquela
 *     venda só.
 *     Responde found:false com 200 quando não acha nada.
 *
 *     Cada venda vem com a situação do reembolso: refunded (true/false),
 *     refundType ("total", "parcial" ou null), refundedCents (quanto foi
 *     devolvido — no total é o valor da venda), refundedAt e refundNote.
 *     Os totais da resposta: totalCents é o bruto, refundedTotalCents o
 *     devolvido e netCents o que ficou.
 *
 *   refund — marca a venda como reembolsada (101–103)
 *     { "action": "refund", "kirvanoSaleId": "...",
 *       "phone": "5511999999999", "netValue": 296.01 }                  total
 *     { "action": "refund", "saleId": "...", "value": 200.00,
 *       "note": "cliente desistiu de 1 criativo" }                       parcial
 *     { "action": "refund", "externalId": "pedido-9912", "undo": true } desfaz
 *
 *     Como a venda é achada, nesta ordem:
 *       1. saleId ou externalId, quando vierem — apontam a venda, sem busca;
 *       2. kirvanoSaleId, na venda que o guardou (105);
 *       3. phone + netValue (o valor LÍQUIDO lançado no CRM, em reais; ou
 *          netValueCents), entre as vendas do número SEM id da Kirvano —
 *          uma venda que tem outro id da Kirvano não é esta. Achando por
 *          aqui com kirvanoSaleId no corpo, o id fica gravado na venda.
 *     Dois candidatos no passo 3 (o cliente comprou duas vezes o mesmo
 *     valor) e a API não escolhe: prefere o que ainda não foi reembolsado e,
 *     se ainda sobrar mais de um, não registra. Reembolsar a venda errada
 *     mexe na comissão de alguém.
 *
 *     Não achou: responde 200 com reembolso_registrado:false e o motivo —
 *     o n8n segue o fluxo sem tratar erro. Achou: reembolso_registrado:true
 *     e matchedBy ("saleId", "externalId", "kirvanoSaleId" ou "phoneValue").
 *     Erro de corpo (valor inválido, maior que a venda) continua 400.
 *
 *     value (reais) ou valueCents é quanto foi DEVOLVIDO; omitido, ou igual
 *     ao valor da venda, é reembolso total. Maior que a venda é recusado —
 *     não mande o bruto da Kirvano aqui, a venda do CRM guarda o líquido.
 *     note omitida ou vazia mantém a nota que já existe.
 *
 *     É o mesmo update da tela, então tudo o que a tela dispara acontece
 *     igual, no banco: a data é a de agora (102), o evento da Meta e a
 *     UTMify pendentes são segurados no total, e o sistema de comissão é
 *     avisado (104). O n8n NÃO recebe aviso deste reembolso (088).
 *
 *     Pode repetir: mandar de novo o mesmo valor não muda nada (changed:
 *     false) e não avisa a comissão outra vez. Valor diferente numa venda
 *     já reembolsada CORRIGE o valor — não soma — e mantém a data original.
 *     undo desfaz (a nota fica guardada, como na tela).
 *
 *   portfolio — o cliente entrou no portfólio (091)
 *     { "action": "portfolio", "phone": "5511999999999", "channel": "PH" }
 *     { "action": "portfolio", "phone": "5511...", "enteredAt": "2026-09-11T14:05:00-03:00" }
 *
 *     É o que monta o degrau do Portfólio na aba Jornada — a etiqueta da
 *     conversa não conta mais. Um registro por TELEFONE, o primeiro:
 *     mandar de novo não duplica nem mexe na data, e a resposta traz
 *     duplicate:true com o enteredAt de antes. Pode reenviar à vontade.
 *
 *     enteredAt é opcional (data ou ISO completa, como soldAt); sem ele vale
 *     a hora da chamada. channel é opcional e só serve para achar o cadastro
 *     certo quando o número existe nos dois WhatsApps — o registro vale para
 *     o número. Número sem cadastro no CRM também é registrado (contactId
 *     null na resposta): o portfólio pode ir antes do cadastro.
 *
 *   upsert — cria o contato, ou atualiza se já existir
 *     { "action": "upsert", "conversationId": "abc-123", "name": "Fulano",
 *       "phone": "5511...", "email": "...", "tags": ["quente"],
 *       "channel": "WhatsApp Vendas", "value": 250.00,
 *       "ctwaclid": "ARAj...", "source_id": "camp-42", "origem": "Instagram Ads",
 *       "stageName": "Em qualificação" }
 *
 *     LEAD QUE VEIO DE LANDING PAGE (anúncio → site → WhatsApp): mande o que
 *     o pixel capturou na visita, e a venda dele sai atribuída ao anúncio
 *     como evento de site (071):
 *       { "action": "upsert", "phone": "5533...", "name": "Fulano",
 *         "channel": "Pedro",
 *         "fbc": "fb.1.1786664257902.PAcGRv...", "fbp": "fb.1.1786664257902.22371",
 *         "client_ip": "177.128.81.164", "user_agent": "Mozilla/5.0 (iPhone...)",
 *         "landing_url": "https://site.com.br/quiz/?fbclid=...",
 *         "campaign_id": "120257296041130779", "adset_id": "...", "ad_id": "..." }
 *
 *     fbc é o que atribui (é o clique no anúncio); campaign_id é o que prova
 *     que o clique foi de mídia paga — o fbclid também aparece em link
 *     orgânico do Instagram. Sem os dois juntos o lead só vai para a Meta se
 *     a origem declarar anúncio, e aí sem atribuição.
 *
 *     client_ip e user_agent têm de ser os do NAVEGADOR do lead, capturados
 *     na landing. Mandar os do servidor que faz esta chamada piora o
 *     casamento em vez de ajudar.
 *
 *     Esse bloco só é gravado quando vem PREENCHIDO: string vazia não apaga
 *     (ao contrário de origem/ctwaclid). O upsert é reenviado a cada passo
 *     da automação do WhatsApp, que não conhece esses campos — um "" ali
 *     apagaria a única atribuição que o lead tem, e ninguém veria.
 *
 *     Mandando creatives junto, o upsert TAMBÉM lança a venda (com value):
 *       { "action": "upsert", "phone": "5511...", "name": "Fulano",
 *         "creatives": 3, "value": 1500.00 }
 *
 *     Trava contra duplicata: sem externalId (nem kirvanoSaleId), a venda só
 *     é lançada se o contato ainda não tiver nenhuma — porque o upsert é
 *     reenviado a cada passo da automação. Recompra vai por action:"sale",
 *     com externalId. kirvanoSaleId vale como chave do mesmo jeito.
 *
 *     Localiza o contato pelo conversationId quando informado; senão, pelo
 *     phone. Informe pelo menos um dos dois. O conversationId é opcional — dá
 *     pra criar sem ele (ex.: BotConversa indisponível) e, quando o ID chegar
 *     num upsert seguinte com o mesmo telefone, ele é gravado no contato.
 *
 *     O número é reconhecido em qualquer grafia: com ou sem o 55, com ou sem
 *     o 9 do celular. Duas chamadas simultâneas para o mesmo número não criam
 *     dois contatos — procurar e criar acontecem numa transação só, no banco
 *     (crm_contact_claim, 069). A resposta traz matchedBy dizendo por onde o
 *     contato foi reconhecido: "conversation", "phone" ou "created".
 *
 *     CANAL SEPARA CADASTRO. O mesmo número falando com o WhatsApp da PH e
 *     com o do Pedro são dois contatos legítimos, um por canal — mande
 *     sempre o channel para o lead cair no lugar certo. Sem channel a chamada
 *     reaproveita o cadastro que existir para aquele número, seja qual for o
 *     canal dele. Vale igual para lookup e sale.
 *
 *     O ANÚNCIO ATRAVESSA O CANAL (081). Cadastro que nasce sem nenhum dado
 *     de anúncio herda o do cadastro do MESMO número em outro canal:
 *     ctwaclid, source_id e o bloco do site, os dez campos juntos. É o que
 *     mantém atribuível a venda do cliente que voltou pelo outro WhatsApp.
 *     Mandando atribuição no corpo, nada é herdado — o dado desta chamada é
 *     o que vale, e um bloco herdado antes é apagado inteiro para não se
 *     misturar com ele. A resposta traz adsInheritedFrom com o cadastro de
 *     onde veio a cópia, ou null.
 *
 * O upsert é parcial: só os campos presentes no corpo são alterados. Omitir
 * stageName/stageId num contato novo o deixa FORA do funil — ele aparece em
 * Contatos sem ocupar coluna no kanban.
 *
 * Autenticação por chave de API por organização (tabela crm_api_keys,
 * guardada como sha256). A chave identifica a org — nenhum dado de outra
 * organização é alcançável mesmo com o service role, porque todo acesso
 * abaixo filtra por organization_id explicitamente.
 *
 * O histórico da movimentação e o evento de conversão NÃO são criados
 * aqui: quem faz isso é o trigger crm_track_stage_change no banco, o mesmo
 * que roda quando o card é arrastado na tela. Um caminho só, sem divergência.
 *
 * Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-api-key',
}

/** Formas de pagamento aceitas — espelho do check da migration 070. */
const PAYMENT_METHODS = ['pix', 'credito', 'debito', 'boleto']

/**
 * Captura do pixel na landing (071). Nomes iguais aos das colunas de
 * crm_contacts de propósito: um nome só do formulário ao evento na Meta.
 */
const WEB_ATTRIBUTION = [
  'fbc', 'fbp', 'client_ip', 'user_agent', 'landing_url',
  'campaign_id', 'adset_id', 'ad_id',
] as const

/**
 * Os campos que são SINAL DE ANÚNCIO — espelho de crm_contact_has_ad_data
 * (081). fbp, client_ip, user_agent e landing_url ficam de fora de propósito:
 * a landing os captura de todo visitante, inclusive do orgânico, e contá-los
 * como anúncio faria o lead que passou pelo site nunca herdar nada.
 */
const AD_SIGNAL = ['ctwaclid', 'source_id', 'fbc', 'campaign_id', 'adset_id', 'ad_id'] as const

const svc = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST' && req.method !== 'GET') {
    return json({ error: 'Método não permitido' }, 405)
  }

  try {
    const apiKey = req.headers.get('x-api-key') ?? ''
    if (!apiKey) return json({ error: 'Header x-api-key ausente' }, 401)

    // Resolve chave → organização. RPC security definer: a comparação é por
    // hash e a chave em texto puro nunca é gravada em lugar nenhum.
    const { data: orgId } = await svc.rpc('crm_resolve_api_key', { p_key: apiKey })
    if (!orgId) return json({ error: 'Chave de API inválida ou revogada' }, 401)

    // No GET os parâmetros vêm da query string — é o que torna o endpoint
    // colável em Google Sheets, Looker Studio e afins, que só sabem buscar
    // uma URL. O POST continua exatamente como era.
    const isGet = req.method === 'GET'
    const body = isGet
      ? Object.fromEntries(new URL(req.url).searchParams) as Record<string, unknown>
      : await req.json().catch(() => ({})) as Record<string, unknown>

    // O GET nasce em "metrics": a URL mínima, sem nenhum parâmetro, já devolve
    // os números dos últimos 30 dias.
    const action = (str(body.action) ?? (isGet ? 'metrics' : 'move')).toLowerCase()
    const conversationId = str(body.conversationId)
    const contactId = str(body.contactId)
    const stageId = str(body.stageId)
    const stageName = str(body.stageName)

    if (!['move', 'upsert', 'sale', 'lookup', 'metrics', 'portfolio', 'sales', 'refund'].includes(action)) {
      return json({
        error: `Ação desconhecida: ${action}. Use "move", "upsert", "sale", "lookup", "metrics", "portfolio", "sales" ou "refund".`,
      }, 400)
    }

    // GET só serve leitura. Escrever por GET convidaria a gravar venda por
    // link — recarregar a página lançaria de novo, e nenhum cache saberia
    // disso. Quem escreve manda POST.
    if (isGet && !['metrics', 'lookup', 'sales'].includes(action)) {
      return json({ error: `A ação "${action}" altera dados: use POST. Por GET só "metrics", "lookup" e "sales".` }, 405)
    }

    // Telefone normalizado (só dígitos). Serve de chave alternativa do upsert
    // quando não há conversationId — BotConversa fora do ar, ou contato criado
    // à mão pela interface, onde ninguém sabe o ID da conversa.
    const phone = body.phone !== undefined ? (str(body.phone) ?? '').replace(/\D/g, '') : ''

    if (action === 'move' && !conversationId && !contactId) {
      return json({ error: 'Informe conversationId ou contactId' }, 400)
    }
    if (action === 'upsert' && !conversationId && !phone) {
      return json({ error: 'Para upsert, informe conversationId ou phone — um dos dois localiza o contato.' }, 400)
    }
    if (action === 'sale' && !phone && !contactId && !conversationId) {
      return json({ error: 'Para sale, informe o phone do contato (ou contactId/conversationId).' }, 400)
    }
    if (action === 'lookup' && !phone && !contactId && !conversationId) {
      return json({ error: 'Para lookup, informe o phone (ou contactId/conversationId).' }, 400)
    }
    if (action === 'portfolio' && !phone && !contactId && !conversationId) {
      return json({ error: 'Para portfolio, informe o phone (ou contactId/conversationId).' }, 400)
    }

    // ---------- lookup: o contato já existe? ----------
    // Só leitura. Serve para a automação decidir o caminho antes de agir:
    // lead novo, lead conhecido que ainda não comprou, ou cliente com
    // recompra. Devolve exists:false com 200 — "não existe" é uma resposta
    // legítima, não um erro.
    if (action === 'lookup') {
      const found = await findContact(orgId, {
        contactId, conversationId, phone, channel: str(body.channel),
      })
      if (!found) return json({ ok: true, exists: false })

      let stageName: string | null = null
      if (found.stage_id) {
        const { data } = await svc
          .from('crm_stages')
          .select('name')
          .eq('id', found.stage_id)
          .maybeSingle()
        stageName = data?.name ?? null
      }

      const salesCount = found.sales_count ?? 0
      return json({
        ok: true,
        exists: true,
        contactId: found.id,
        name: found.name,
        phone: found.phone,
        email: found.email,
        conversationId: found.conversation_id,
        channel: found.channel,
        origem: found.origem,
        // Tem clique de anúncio guardado? É o que decide se a conversão dele
        // vai para a Meta atribuída ao anúncio — pelo Click-to-WhatsApp
        // (ctwaclid) ou pela landing (fbc + campanha, 071).
        hasCtwaclid: !!found.ctwaclid,
        hasFbc: !!found.fbc && !!found.campaign_id,
        tags: found.tags ?? [],
        stageId: found.stage_id,
        stageName,
        valueCents: found.value_cents ?? 0,
        salesCount,
        salesTotalCents: found.sales_total_cents ?? 0,
        // Atalhos para o fluxo não precisar interpretar os números.
        hasPurchased: salesCount > 0,
        nextSaleIsFirst: salesCount === 0,
        createdAt: found.created_at,
      })
    }

    // ---------- sales: as vendas do cliente, uma a uma ----------
    // Só leitura. O lookup diz quanto o cliente comprou; aqui vem cada venda,
    // com o reembolso dela — é o que o n8n confere antes de lançar um.
    if (action === 'sales') {
      const saleId = str(body.saleId)
      const externalId = str(body.externalId)
      const kirvanoSaleId = str(body.kirvanoSaleId)

      let contactIds: string[]
      let onlySale: string | null = null
      if (saleId || externalId || kirvanoSaleId) {
        const sale = await findSale(orgId, { saleId, externalId, kirvanoSaleId })
        if (!sale) return json({ ok: true, found: false, contacts: [], sales: [] })
        contactIds = [sale.contact_id]
        onlySale = sale.id
      } else if (contactId || conversationId) {
        const found = await findContact(orgId, { contactId, conversationId, phone, channel: str(body.channel) })
        contactIds = found ? [found.id] : []
      } else if (phone) {
        if (phone.length < 8) {
          return json({ error: `phone inválido: "${phone}". Mande o número com DDD, só dígitos.` }, 400)
        }
        contactIds = await contactsOfPhone(orgId, phone, str(body.channel))
      } else {
        return json({ error: 'Para sales, informe phone, externalId ou saleId.' }, 400)
      }

      if (!contactIds.length) return json({ ok: true, found: false, contacts: [], sales: [] })

      const { data: contacts, error: cErr } = await svc
        .from('crm_contacts')
        .select('id, name, phone, channel')
        .eq('organization_id', orgId)
        .in('id', contactIds)
      if (cErr) throw new ApiError(cErr.message, 500)

      let q = svc
        .from('crm_sales')
        .select(SALE_FIELDS)
        .eq('organization_id', orgId)
        .in('contact_id', contactIds)
      if (onlySale) q = q.eq('id', onlySale)
      const { data: rows, error: sErr } = await q
        .order('sold_at', { ascending: false })
        .limit(500)
      if (sErr) throw new ApiError(sErr.message, 500)

      const contactOf = new Map((contacts ?? []).map((c) => [c.id, c as ContactBrief]))
      const sales = ((rows ?? []) as unknown as SaleRow[]).map((s) => saleOut(s, contactOf.get(s.contact_id) ?? null))
      const totalCents = sales.reduce((n, s) => n + s.valueCents, 0)
      const refundedTotalCents = sales.reduce((n, s) => n + s.refundedCents, 0)

      return json({
        ok: true,
        found: true,
        contacts: (contacts ?? []).map((c) => ({
          contactId: c.id, name: c.name, phone: c.phone, channel: c.channel,
        })),
        count: sales.length,
        totalCents,
        refundedTotalCents,
        netCents: totalCents - refundedTotalCents,
        sales,
      })
    }

    // ---------- refund: marca (ou desfaz) o reembolso de uma venda ----------
    // O mesmo update que a tela faz (crmService.setSaleRefunded): quem carimba
    // a data, segura o que não saiu e avisa a comissão são as triggers da
    // 102 e da 104. Aqui só se escolhe a venda e o valor.
    if (action === 'refund') {
      // Toda resposta do refund diz se o reembolso ficou registrado: é o
      // campo que o n8n testa, inclusive nos erros de corpo.
      const reply = (registered: boolean, out: Record<string, unknown>, status = 200) =>
        json({ reembolso_registrado: registered, ...out }, status)

      const saleId = str(body.saleId)
      const externalId = str(body.externalId)
      const kirvanoSaleId = str(body.kirvanoSaleId)
      const undo = body.undo === true || body.undo === 'true'

      const netCents = moneyCents(body, 'netValue', 'netValueCents')
      if (netCents !== null && (!Number.isFinite(netCents) || netCents <= 0)) {
        return reply(false, { error: 'netValue (em reais) ou netValueCents tem de ser maior que zero.' }, 400)
      }

      if (!saleId && !externalId && !kirvanoSaleId && !(phone && netCents !== null)) {
        return reply(false, {
          error: 'Para refund, informe kirvanoSaleId, ou phone + netValue (o líquido da venda), ou saleId/externalId.',
        }, 400)
      }

      // ----- achar a venda: id explícito → Kirvano → telefone + líquido -----
      let sale: SaleRow | null = null
      let matchedBy: string | null = null
      let notFound = ''

      if (saleId || externalId) {
        sale = await findSale(orgId, { saleId, externalId })
        matchedBy = saleId ? 'saleId' : 'externalId'
        if (!sale) notFound = `Nenhuma venda com ${saleId ? `saleId ${saleId}` : `externalId ${externalId}`}`
      } else {
        if (kirvanoSaleId) {
          sale = await findSale(orgId, { kirvanoSaleId })
          if (sale) matchedBy = 'kirvanoSaleId'
        }
        if (!sale && phone && netCents !== null) {
          if (phone.length < 8) {
            return reply(false, { error: `phone inválido: "${phone}". Mande o número com DDD, só dígitos.` }, 400)
          }
          const contactIds = await contactsOfPhone(orgId, phone, str(body.channel))
          const candidates = contactIds.length ? await salesByValue(orgId, contactIds, netCents) : []
          const open = candidates.filter((s) => !s.refunded_at)
          // Repetir o pedido acha a mesma venda, agora já reembolsada.
          const pick = open.length ? open : candidates
          if (pick.length === 1) {
            sale = pick[0]
            matchedBy = 'phoneValue'
          } else if (pick.length > 1) {
            return reply(false, {
              ok: true,
              motivo: `${pick.length} vendas de ${netCents} centavos neste número, sem id da Kirvano. `
                + 'Mande o saleId da certa (veja action:"sales").',
              candidates: pick.map((s) => s.id),
            })
          }
        }
        if (!sale) {
          notFound = [
            kirvanoSaleId && `nenhuma venda com o kirvanoSaleId ${kirvanoSaleId}`,
            phone && netCents !== null
              ? `nenhuma venda de ${netCents} centavos sem id da Kirvano no número ${phone}`
              : kirvanoSaleId && 'phone + netValue não vieram para tentar pelo número',
          ].filter(Boolean).join('; ')
        }
      }

      if (!sale) return reply(false, { ok: true, motivo: notFound })

      const contact = await contactBrief(sale.contact_id)
      // Achada pelo número com o id da Kirvano no corpo: o id passa a morar
      // na venda, e a próxima chamada a acha direto.
      const stampKirvano = matchedBy === 'phoneValue' && kirvanoSaleId ? { kirvano_sale_id: kirvanoSaleId } : {}

      if (undo) {
        if (!sale.refunded_at) {
          return reply(false, { ok: true, changed: false, matchedBy, message: 'A venda não estava reembolsada', sale: saleOut(sale, contact) })
        }
        const after = await updateRefund(orgId, sale.id, { refunded_at: null, refunded_cents: null, ...stampKirvano })
        return reply(false, { ok: true, changed: true, undone: true, matchedBy, sale: saleOut(after, contact) })
      }

      // Sem valor = o pedido inteiro. Com valor, é quanto saiu do caixa.
      const cents = moneyCents(body, 'value', 'valueCents') ?? sale.value_cents
      if (!Number.isFinite(cents) || cents <= 0) {
        return reply(false, { error: 'value (em reais) ou valueCents tem de ser maior que zero. Omita para reembolso total.' }, 400)
      }
      if (cents > sale.value_cents) {
        return reply(false, {
          error: `O reembolso (${cents} centavos) passa do valor da venda (${sale.value_cents} centavos).`,
          sale: saleOut(sale, contact),
        }, 400)
      }

      // null = total (102): continua total mesmo se o valor da venda mudar.
      const partial = cents < sale.value_cents ? cents : null
      const note = str(body.note)

      if (sale.refunded_at
          && sale.refunded_cents === partial
          && (note === null || note === sale.refund_note)) {
        if (stampKirvano.kirvano_sale_id) await updateRefund(orgId, sale.id, stampKirvano)
        return reply(true, { ok: true, changed: false, matchedBy, message: 'A venda já estava reembolsada com esse valor', sale: saleOut(sale, contact) })
      }

      const before = sale.refunded_at ? saleOut(sale, contact) : null
      const after = await updateRefund(orgId, sale.id, {
        refunded_at: new Date().toISOString(),
        refunded_cents: partial,
        ...(note !== null && { refund_note: note }),
        ...stampKirvano,
      })
      return reply(true, { ok: true, changed: true, matchedBy, previous: before, sale: saleOut(after, contact) })
    }

    // ---------- portfolio: o cliente entrou no portfólio (091) ----------
    // Marco por telefone, o primeiro vale. Quem grava — e decide que um
    // repetido não grava de novo — é crm_portfolio_register, no banco: a
    // regra de "mesmo número" (crm_phone_id) mora só lá.
    if (action === 'portfolio') {
      const enteredAt = parseSoldAt(body.enteredAt)
      if (str(body.enteredAt) && !enteredAt) {
        return json({ error: 'enteredAt inválido. Use "2026-09-11" ou uma data ISO completa.' }, 400)
      }

      const channel = str(body.channel)
      const found = await findContact(orgId, { contactId, conversationId, phone, channel })
      // Sem phone no corpo, o número é o do cadastro achado por
      // contactId/conversationId — o registro é sempre por telefone.
      const numero = phone || (found?.phone ?? '').replace(/\D/g, '')
      if (numero.length < 8) {
        return json({
          error: phone
            ? `phone inválido: "${phone}". Mande o número com DDD, só dígitos.`
            : 'Contato não encontrado, ou sem telefone: mande o phone.',
        }, 400)
      }

      const { data, error } = await svc.rpc('crm_portfolio_register', {
        p_org: orgId,
        p_phone: numero,
        p_channel: channel ?? found?.channel ?? null,
        p_contact: found?.id ?? null,
        p_entered_at: enteredAt,
      })
      // O erro do supabase-js não é instância de Error: jogado cru, o catch
      // lá embaixo trocaria a mensagem do banco por "Erro inesperado".
      if (error) throw new Error(error.message)
      const row = (data as { entry_id: string; entry_at: string; created: boolean }[] | null)?.[0]
      if (!row) throw new Error('O registro do portfólio não devolveu resultado')

      return json({
        ok: true,
        recorded: row.created,
        // Já estava no portfólio: nada mudou, e enteredAt é o de antes.
        duplicate: !row.created,
        entryId: row.entry_id,
        enteredAt: row.entry_at,
        contactId: found?.id ?? null,
      })
    }

    // ---------- metrics: números de vendas do período ----------
    // Só leitura, para outro sistema puxar faturamento, ticket médio e LTV
    // sem entrar no banco. A conta é a MESMA que o painel mostra: os dois
    // chamam crm_sales_metrics (046). Fosse reimplementada aqui, um dia os
    // dois números divergiriam e ninguém saberia qual acreditar.
    if (action === 'metrics') {
      const to = parseDay(body.to) ?? spToday()
      // Janela padrão de 30 dias contando o dia final — igual ao painel.
      const from = parseDay(body.from) ?? addDays(to, -29)

      if (str(body.from) && !parseDay(body.from)) {
        return json({ error: 'from inválido: use o formato AAAA-MM-DD.' }, 400)
      }
      if (str(body.to) && !parseDay(body.to)) {
        return json({ error: 'to inválido: use o formato AAAA-MM-DD.' }, 400)
      }
      if (from > to) {
        return json({ error: `Período invertido: from (${from}) é depois de to (${to}).` }, 400)
      }

      const channel = str(body.channel)
      const { data, error } = await svc.rpc('crm_sales_metrics', {
        p_org: orgId,
        p_from: from,
        p_to: to,
        p_channel: channel,
      })
      if (error) return json({ error: `Falha ao apurar as métricas: ${error.message}` }, 500)

      const m = (data as Record<string, unknown>[] | null)?.[0] ?? {}
      const n = (k: string) => Number(m[k] ?? 0)

      return json({
        ok: true,
        // Ecoa a janela realmente usada: quem não mandou from/to precisa saber
        // qual período o número cobre antes de guardar em planilha.
        period: { from, to, channel: channel ?? null, timezone: 'America/Sao_Paulo' },
        // Vendas com sold_at dentro da janela.
        periodo: {
          sales: n('sales'),
          firstSales: n('first_sales'),
          repeatSales: n('repeat_sales'),
          clients: n('clients'),
          creatives: n('creatives'),
          revenueCents: n('revenue_cents'),
          // ÷ vendas
          avgTicketCents: n('avg_ticket_cents'),
          // ÷ clientes da janela. NÃO é o LTV do cliente: quem comprou antes
          // do from entra só com o que gastou dentro dela. Para valor de
          // cliente use historico.ltvCents.
          revenuePerClientCents: n('ltv_cents'),
        },
        // Tudo que já foi vendido, sem filtro de data (o de canal continua).
        historico: {
          sales: n('total_sales'),
          clients: n('total_clients'),
          revenueCents: n('total_revenue_cents'),
          avgTicketCents: n('total_avg_ticket_cents'),
          // O LTV médio de verdade — receita realizada por cliente, não
          // projeção: cliente novo ainda vai comprar, então entra puxando a
          // média para baixo.
          ltvCents: n('total_ltv_cents'),
        },
      })
    }

    // ---------- Etapa (opcional no upsert, obrigatória no move) ----------
    let stage: { id: string; name: string } | null = null
    if (stageId || stageName) {
      let q = svc.from('crm_stages').select('id, name').eq('organization_id', orgId)
      q = stageId ? q.eq('id', stageId) : q.ilike('name', stageName!)
      const { data } = await q.maybeSingle()
      if (!data) return json({ error: `Etapa não encontrada: ${stageId ?? stageName}` }, 404)
      stage = data
    }

    // ---------- sale: registra uma venda do contato ----------
    if (action === 'sale') {
      const contact = await findContact(orgId, {
        contactId, conversationId, phone, channel: str(body.channel),
      })
      if (!contact) {
        return json({ error: `Contato não encontrado: ${contactId ?? phone ?? conversationId}` }, 404)
      }

      // Ação explícita de venda: registra recompra também. A única trava é o
      // externalId, quando informado.
      const sale = await registerSale(orgId, contact.id, body, { onlyFirst: false })
      const appliedTags = await applyTags(orgId, contact.id, body)
      const after = await readContactTotals(contact.id)

      return json({
        ok: true,
        contactId: contact.id,
        ...sale,
        tags: appliedTags,
        ...after,
      })
    }

    // ---------- upsert: cria ou atualiza pelo conversationId ou telefone ----------
    if (action === 'upsert') {
      // creatives é o que marca "esta chamada também é uma venda". Sem ele o
      // upsert continua sendo só cadastro, como sempre foi.
      const wantsSale = body.creatives !== undefined

      // PROCURAR E CRIAR ACONTECEM NO BANCO, NUMA TRANSAÇÃO SÓ (069).
      //
      // Aqui existiam dois passos — um select e, não achando, um insert — e
      // entre eles cabia a outra automação: as duas procuravam antes de
      // qualquer uma inserir, as duas não achavam nada e as duas inseriam. O
      // resultado era o mesmo cliente virando dois contatos, cada um com sua
      // metade da história. Só o banco pode desempatar isso, porque só ele
      // enxerga as duas transações; o claim tira um advisory lock na chave do
      // número e faz as duas coisas com ele na mão.
      //
      // O canal entra na conta: o mesmo número falando com o WhatsApp da PH e
      // com o do Pedro são dois cadastros legítimos. Canal ausente = canal
      // desconhecido, que reaproveita o cadastro que existir.
      const { data: claimRows, error: claimError } = await svc.rpc('crm_contact_claim', {
        p_org: orgId,
        p_phone: phone || null,
        p_conversation_id: conversationId,
        p_name: str(body.name),
        p_stage_id: stage?.id ?? null,
        p_origem: str(body.origem),
        p_channel: str(body.channel),
      })
      if (claimError) {
        // Contato novo sem nome é erro DE QUEM CHAMOU, não do servidor.
        const semNome = /name é obrigatório/i.test(claimError.message)
        return json({ error: claimError.message }, semNome ? 400 : 500)
      }
      const claimed = (claimRows as Array<{
        contact_id: string
        created: boolean
        matched_by: string
      }> | null)?.[0]
      if (!claimed) return json({ error: 'Falha ao localizar ou criar o contato' }, 500)

      // Só os campos presentes entram no patch: um upsert que manda apenas
      // o telefone não pode apagar o nome que já estava lá.
      const fields: Record<string, unknown> = {}
      if (body.name !== undefined) fields.name = str(body.name) ?? ''
      if (body.email !== undefined) fields.email = str(body.email)
      if (body.phone !== undefined) fields.phone = (str(body.phone) ?? '').replace(/\D/g, '') || null
      if (body.description !== undefined) fields.description = str(body.description)
      // Canal de origem: de qual WhatsApp/integração o contato veio.
      if (body.channel !== undefined) fields.channel = str(body.channel)
      // Atribuição do lead (todos opcionais, texto livre). Só entram no
      // patch se vierem no corpo; string vazia limpa o campo (vira null).
      if (body.ctwaclid !== undefined) fields.ctwaclid = str(body.ctwaclid)
      if (body.source_id !== undefined) fields.source_id = str(body.source_id)
      if (body.origem !== undefined) fields.origem = str(body.origem)
      // Clique do funil de site: só grava o que vier preenchido — vazio não
      // apaga. Ver a nota do upsert no cabeçalho: a automação do WhatsApp
      // reenvia este mesmo upsert sem conhecer esses campos.
      for (const campo of WEB_ATTRIBUTION) {
        const valor = str(body[campo])
        if (valor) fields[campo] = valor
      }
      if (Array.isArray(body.tags)) {
        fields.tags = (body.tags as unknown[]).map((t) => String(t).trim()).filter(Boolean)
      }
      // valueCents é a forma canônica (inteiro, sem erro de ponto flutuante);
      // value aceita reais por conveniência do n8n.
      if (body.valueCents !== undefined) {
        fields.value_cents = Math.round(Number(body.valueCents) || 0)
      } else if (body.value !== undefined) {
        fields.value_cents = Math.round((Number(body.value) || 0) * 100)
      }
      if (stage) fields.stage_id = stage.id
      // conversation_id não entra no patch: quem grava é o claim, e só quando
      // o contato ainda não tem um — o índice único por organização não deixa
      // sobrescrever por outro ID, e sobrescrever perderia o vínculo antigo.

      const alvo = claimed.contact_id

      // ANÚNCIO PRÓPRIO CHEGANDO POR CIMA DE UM HERDADO (081).
      //
      // O cadastro pode ter herdado o clique do outro canal ao nascer, e esta
      // chamada estar trazendo o anúncio dele de verdade. Gravar o ctwaclid
      // novo por cima deixaria o clique desta conversa ao lado do campaign_id
      // da outra — a mistura que o "tudo ou nada" existe para impedir. Então
      // o bloco herdado sai INTEIRO antes do patch. Em cadastro cuja
      // atribuição é dele, a função não faz nada: chamar é seguro.
      const trazAnuncio = AD_SIGNAL.some((campo) => !!str(body[campo]))
      if (trazAnuncio) {
        const { error } = await svc.rpc('crm_contact_drop_inherited_ads', { p_contact: alvo })
        if (error) return json({ error: error.message }, 500)
      }

      if (Object.keys(fields).length > 0) {
        const { error } = await svc.from('crm_contacts')
          .update(fields).eq('id', alvo).eq('organization_id', orgId)
        if (error) return json({ error: error.message }, 500)
      }

      // O ANÚNCIO DO CLIENTE NO OUTRO CANAL (081).
      //
      // Depois do patch, de propósito: é só aqui que se sabe se esta chamada
      // trouxe atribuição própria. O mesmo número falando com o WhatsApp da
      // PH e com o do Pedro são dois cadastros, e o segundo nascia pelado —
      // a venda que saísse dele não viraria Purchase atribuído na Meta nem
      // entraria na receita por campanha, embora tenha sido o anúncio que
      // trouxe o cliente. A função se guarda sozinha: só copia para cadastro
      // sem nenhum dado de anúncio e ainda recém-criado, então chamá-la em
      // todo upsert (o n8n reenvia a cada passo) não mexe em contato antigo.
      const { data: herdouDe, error: herancaError } = await svc
        .rpc('crm_contact_inherit_ads', { p_contact: alvo })
      if (herancaError) return json({ error: herancaError.message }, 500)

      // Venda depois do patch: assim a trigger enxerga o contato já com a
      // origem/ctwaclid desta chamada ao decidir o envio para a Meta.
      const sale = wantsSale
        ? await registerSale(orgId, alvo, body, { onlyFirst: true })
        : null

      // A etapa de verdade depois de tudo: a 1ª venda move o contato para a
      // conversão por trigger, então o stage pedido não é necessariamente o
      // que ficou gravado.
      const { data: depois } = await svc
        .from('crm_contacts')
        .select('stage_id')
        .eq('id', alvo)
        .maybeSingle()

      return json({
        ok: true,
        created: claimed.created,
        changed: claimed.created || Object.keys(fields).length > 0 || !!sale,
        contactId: alvo,
        // Por onde o contato foi reconhecido: 'conversation', 'phone' ou
        // 'created'. É o que explica, do lado do n8n, por que uma chamada
        // atualizou em vez de criar.
        matchedBy: claimed.matched_by,
        // Preenchido = este cadastro herdou o anúncio do cadastro do mesmo
        // número em outro canal (081), por ter nascido sem nenhum.
        adsInheritedFrom: (herdouDe as string | null) ?? null,
        stageId: depois?.stage_id ?? stage?.id ?? null,
        stageName: stage?.name ?? null,
        ...(sale ?? {}),
        ...(sale ? await readContactTotals(alvo) : {}),
      })
    }

    // ---------- move ----------
    if (!stage) {
      return json({ error: 'Informe stageId ou stageName' }, 400)
    }

    // ---------- Contato ----------
    let contactQuery = svc
      .from('crm_contacts')
      .select('id, name, stage_id')
      .eq('organization_id', orgId)
    contactQuery = contactId
      ? contactQuery.eq('id', contactId)
      : contactQuery.eq('conversation_id', conversationId!)

    const { data: contact } = await contactQuery.maybeSingle()
    if (!contact) {
      return json({ error: `Contato não encontrado: ${contactId ?? conversationId}` }, 404)
    }

    // Já está na etapa: não faz update. Evita histórico e evento repetidos
    // quando a automação reenvia o mesmo request.
    if (contact.stage_id === stage.id) {
      return json({
        ok: true,
        changed: false,
        contactId: contact.id,
        stageId: stage.id,
        message: 'Contato já estava nesta etapa',
      })
    }

    // Não é preciso marcar a origem: aqui o service role roda sem usuário,
    // então auth.uid() é nulo e o trigger classifica a movimentação como
    // 'api' por si só.
    const { error: updateError } = await svc
      .from('crm_contacts')
      .update({ stage_id: stage.id })
      .eq('id', contact.id)
      .eq('organization_id', orgId)

    if (updateError) return json({ error: updateError.message }, 500)

    return json({
      ok: true,
      changed: true,
      contactId: contact.id,
      contactName: contact.name,
      fromStageId: contact.stage_id,
      stageId: stage.id,
      stageName: stage.name,
    })
  } catch (err) {
    if (err instanceof ApiError) return json({ error: err.message }, err.status)
    return json({ error: err instanceof Error ? err.message : 'Erro inesperado' }, 500)
  }
})

/** Erro de request com status próprio — o handler devolve como json. */
class ApiError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/**
 * Registra a venda do contato. É o mesmo caminho para as duas ações, então
 * "1ª venda entra no funil" e a idempotência valem igual nas duas.
 *
 * onlyFirst = true (upsert): sem externalId, só lança se o contato ainda não
 * tiver venda nenhuma. O upsert é chamado a cada passo da automação; sem
 * essa trava, cada reexecução viraria uma venda nova. Recompra pela API tem
 * de passar por action:"sale" (ou trazer externalId).
 */
async function registerSale(
  orgId: string,
  contactId: string,
  body: Record<string, unknown>,
  opts: { onlyFirst: boolean },
) {
  // valueCents é a forma canônica (inteiro); value aceita reais, que é o que
  // costuma vir do gateway/planilha no n8n.
  const valueCents = body.valueCents !== undefined
    ? Math.round(Number(body.valueCents) || 0)
    : Math.round((Number(body.value) || 0) * 100)
  if (!Number.isFinite(valueCents) || valueCents <= 0) {
    throw new ApiError('Para lançar venda, informe value (em reais) ou valueCents (inteiro) maior que zero')
  }

  // Quantidade de criativos vendidos. Ausente = 0 ("não informado"), que é
  // como o relatório trata as vendas importadas do histórico.
  const creatives = Math.max(0, Math.round(Number(body.creatives) || 0))

  // Forma de pagamento (070). Lista fechada no banco; validada aqui para o
  // erro sair legível em vez de um "violates check constraint" cru. Ausente =
  // não informada, que é o esperado de automação que não sabe como o cliente
  // pagou — o painel é que exige.
  const payment = (str(body.paymentMethod) ?? '').toLowerCase()
  if (payment && !PAYMENT_METHODS.includes(payment)) {
    throw new ApiError(
      `paymentMethod inválido: "${payment}". Use ${PAYMENT_METHODS.join(', ')}.`,
    )
  }

  const externalId = str(body.externalId)
  const kirvanoSaleId = str(body.kirvanoSaleId)
  const soldAt = parseSoldAt(body.soldAt)
  // Campo em branco é "não informado" (n8n manda string vazia direto de
  // expressão vazia); só texto de verdade que não vira data é erro.
  if (str(body.soldAt) !== null && soldAt === null) {
    throw new ApiError('soldAt inválido. Use "2026-07-28" ou uma data ISO completa.')
  }

  // As duas chaves da venda: qualquer uma que já exista devolve a venda de
  // antes. externalId primeiro, que é a idempotência de sempre (036).
  for (const [col, val, label] of [
    ['external_id', externalId, 'externalId'],
    ['kirvano_sale_id', kirvanoSaleId, 'kirvanoSaleId'],
  ] as const) {
    if (!val) continue
    const { data: dup } = await svc
      .from('crm_sales')
      .select('id, sold_at')
      .eq('organization_id', orgId)
      .eq(col, val)
      .maybeSingle()
    if (dup) {
      return {
        saleCreated: false, duplicate: true, saleId: dup.id,
        message: `Venda já registrada com este ${label}`,
      }
    }
  }
  if (!externalId && !kirvanoSaleId && opts.onlyFirst) {
    const { count } = await svc
      .from('crm_sales')
      .select('id', { count: 'exact', head: true })
      .eq('contact_id', contactId)
    if ((count ?? 0) > 0) {
      return {
        saleCreated: false, duplicate: false,
        message: 'Contato já tem venda registrada — use action:"sale" (com externalId) para recompra',
      }
    }
  }

  const { data: sale, error } = await svc
    .from('crm_sales')
    .insert({
      // organization_id é carimbado pela trigger a partir do contato.
      contact_id: contactId,
      creatives,
      value_cents: valueCents,
      ...(soldAt ? { sold_at: soldAt } : {}),
      note: str(body.note),
      payment_method: payment || null,
      external_id: externalId,
      kirvano_sale_id: kirvanoSaleId,
    })
    .select('id, sold_at')
    .single()

  if (error) {
    // 23505 = corrida entre dois requests com o mesmo externalId: o segundo
    // perdeu, mas a venda existe — resultado de sucesso, não erro.
    if (error.code === '23505') {
      return {
        saleCreated: false, duplicate: true,
        message: 'Venda já registrada com este externalId ou kirvanoSaleId',
      }
    }
    throw new ApiError(error.message, 500)
  }

  return {
    saleCreated: true, duplicate: false,
    saleId: sale.id, soldAt: sale.sold_at, creatives, valueCents, kirvanoSaleId,
  }
}

/**
 * Etiquetas SUBSTITUEM as do contato. Mandar [] limpa; omitir o campo deixa
 * como estão — automação não apaga etiqueta por não mandar o campo.
 */
async function applyTags(orgId: string, contactId: string, body: Record<string, unknown>) {
  if (!Array.isArray(body.tags)) return null
  const tags = (body.tags as unknown[]).map((t) => String(t).trim()).filter(Boolean)
  const { error } = await svc.from('crm_contacts')
    .update({ tags }).eq('id', contactId).eq('organization_id', orgId)
  if (error) throw new ApiError(`Falha ao gravar as etiquetas: ${error.message}`, 500)
  return tags
}

/**
 * Estado do contato depois da venda: a trigger pode tê-lo movido para a
 * etapa de conversão e recalculou os totais. A automação recebe o resultado
 * real, não o que foi pedido.
 */
async function readContactTotals(contactId: string) {
  const { data } = await svc
    .from('crm_contacts')
    .select('sales_count, sales_total_cents, stage_id')
    .eq('id', contactId)
    .maybeSingle()

  return {
    salesCount: data?.sales_count ?? null,
    salesTotalCents: data?.sales_total_cents ?? null,
    stageId: data?.stage_id ?? null,
    // true = a venda desta chamada foi a 1ª do cliente, a que entra no funil
    // de conversão. As seguintes ficam só registradas no contato.
    firstSale: (data?.sales_count ?? 0) === 1,
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/**
 * "AAAA-MM-DD" → a mesma string, se for um dia que existe. Qualquer outra
 * coisa devolve null, para o chamador responder 400 em vez de deixar o
 * Postgres recusar o argumento com uma mensagem que ninguém entende.
 *
 * A checagem de ida e volta pega 2026-02-31: o Date aceita e normaliza para
 * março, então o texto de volta não bate com o que entrou.
 */
function parseDay(v: unknown): string | null {
  const raw = str(v)
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  const d = new Date(`${raw}T12:00:00Z`)
  if (isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10) === raw ? raw : null
}

/** Hoje em São Paulo, como "AAAA-MM-DD" — o fuso de todos os relatórios. */
function spToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
}

/** Soma dias a uma data "AAAA-MM-DD". Meio-dia UTC não escorrega de dia. */
function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

/**
 * Localiza o contato. O TELEFONE é a chave do negócio: é o que sempre
 * existe, é o mesmo número que atende no WhatsApp e não depende de nenhum
 * sistema intermediário. conversationId é opcional — o contato pode ter
 * nascido sem ele (criado à mão, ou com o BotConversa fora do ar) — então
 * entra só como último recurso.
 *
 * contactId vem antes de tudo por ser o id interno: quem o envia está
 * apontando para uma linha específica, não pedindo uma busca.
 *
 * Com vários contatos no mesmo telefone, pega o mais antigo — o registro
 * original do lead, mesma regra do upsert.
 */
interface FoundContact {
  id: string
  name: string | null
  phone: string | null
  email: string | null
  conversation_id: string | null
  channel: string | null
  origem: string | null
  ctwaclid: string | null
  fbc: string | null
  campaign_id: string | null
  tags: string[] | null
  stage_id: string | null
  value_cents: number | null
  sales_count: number | null
  sales_total_cents: number | null
  created_at: string
}

const CONTACT_FIELDS =
  'id, name, phone, email, conversation_id, channel, origem, ctwaclid, fbc, '
  + 'campaign_id, tags, stage_id, value_cents, sales_count, sales_total_cents, created_at'

async function findContact(
  orgId: string,
  keys: {
    contactId: string | null
    conversationId: string | null
    phone: string
    /** De qual WhatsApp veio. Ausente = qualquer canal, como sempre foi. */
    channel?: string | null
  },
): Promise<FoundContact | null> {
  const base = () => svc
    .from('crm_contacts')
    .select(CONTACT_FIELDS)
    .eq('organization_id', orgId)

  // O cast existe porque a lista de campos vem de uma constante: o
  // supabase-js só infere o formato quando o select é literal.
  if (keys.contactId) {
    const { data } = await base().eq('id', keys.contactId).maybeSingle()
    if (data) return data as unknown as FoundContact
  }
  if (keys.phone) {
    // Pela RPC, não por igualdade: ela reconhece o número em qualquer grafia
    // — com ou sem o 55, com ou sem o 9 do celular (044/069) — e respeita o
    // canal, porque o mesmo número na PH e no Pedro são dois cadastros. A
    // regra vive só no banco: duplicar aqui seria criar duas definições de
    // "mesmo contato" para divergirem depois.
    const { data } = await svc.rpc('crm_contact_by_phone', {
      p_org: orgId,
      p_phone: keys.phone,
      p_channel: keys.channel ?? null,
    })
    const row = (data as unknown[] | null)?.[0]
    if (row) return row as FoundContact
  }
  if (keys.conversationId) {
    const { data } = await base().eq('conversation_id', keys.conversationId).maybeSingle()
    if (data) return data as unknown as FoundContact
  }
  return null
}

/**
 * soldAt do corpo → instante ISO. Ausente devolve null (o banco usa now()).
 *
 * Só a data ("2026-07-28") vira meio-dia em São Paulo: o relatório agrupa
 * por dia nesse fuso, e meio-dia nunca escorrega para o dia vizinho na
 * conversão para UTC — meia-noite escorregaria. Data ISO completa é
 * respeitada como veio.
 */
function parseSoldAt(v: unknown): string | null {
  const raw = str(v)
  if (!raw) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    // São Paulo é UTC-3 o ano todo (sem horário de verão desde 2019).
    return new Date(`${raw}T12:00:00-03:00`).toISOString()
  }
  const d = new Date(raw)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

const SALE_FIELDS =
  'id, contact_id, value_cents, creatives, payment_method, sold_at, note, external_id, '
  + 'kirvano_sale_id, refunded_at, refunded_cents, refund_note, created_at'

interface SaleRow {
  id: string
  contact_id: string
  value_cents: number
  creatives: number
  payment_method: string | null
  sold_at: string
  note: string | null
  external_id: string | null
  kirvano_sale_id: string | null
  refunded_at: string | null
  refunded_cents: number | null
  refund_note: string | null
  created_at: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Uma venda como a API devolve. refundedCents é sempre o que saiu do caixa:
 * no reembolso total o banco guarda null (102), e aqui vira o valor da venda
 * para o n8n não ter que saber dessa convenção.
 */
function saleOut(s: SaleRow, contact: ContactBrief | null) {
  const refunded = !!s.refunded_at
  return {
    saleId: s.id,
    contactId: s.contact_id,
    // Nome e telefone como estão no CRM — é o que a mensagem ao cliente cita.
    contactName: contact?.name ?? null,
    contactPhone: contact?.phone ?? null,
    channel: contact?.channel ?? null,
    soldAt: s.sold_at,
    valueCents: s.value_cents,
    creatives: s.creatives,
    paymentMethod: s.payment_method,
    externalId: s.external_id,
    kirvanoSaleId: s.kirvano_sale_id,
    note: s.note,
    refunded,
    refundType: !refunded ? null : s.refunded_cents == null ? 'total' : 'parcial',
    refundedCents: !refunded ? 0 : s.refunded_cents ?? s.value_cents,
    refundedAt: s.refunded_at,
    refundNote: refunded ? s.refund_note : null,
    createdAt: s.created_at,
  }
}

/**
 * A venda por uma das chaves, na ordem saleId → externalId → kirvanoSaleId
 * (usa a primeira que vier), sempre dentro da organização. As três são
 * únicas por organização (036, 105), então é uma venda ou nenhuma.
 */
async function findSale(
  orgId: string,
  keys: { saleId?: string | null; externalId?: string | null; kirvanoSaleId?: string | null },
): Promise<SaleRow | null> {
  const { saleId, externalId, kirvanoSaleId } = keys
  if (saleId && !UUID.test(saleId)) throw new ApiError(`saleId inválido: "${saleId}"`)
  let q = svc.from('crm_sales').select(SALE_FIELDS).eq('organization_id', orgId)
  if (saleId) q = q.eq('id', saleId)
  else if (externalId) q = q.eq('external_id', externalId)
  else if (kirvanoSaleId) q = q.eq('kirvano_sale_id', kirvanoSaleId)
  else return null
  const { data, error } = await q.maybeSingle()
  if (error) throw new ApiError(error.message, 500)
  return data as unknown as SaleRow | null
}

/**
 * As vendas destes cadastros com este valor líquido e SEM id da Kirvano — o
 * passo 3 do refund. Venda com id da Kirvano já teria sido achada por ele, e
 * se o id dela é outro, ela não é a venda deste reembolso.
 */
async function salesByValue(orgId: string, contactIds: string[], valueCents: number): Promise<SaleRow[]> {
  const { data, error } = await svc
    .from('crm_sales')
    .select(SALE_FIELDS)
    .eq('organization_id', orgId)
    .in('contact_id', contactIds)
    .eq('value_cents', valueCents)
    .is('kirvano_sale_id', null)
    .order('sold_at', { ascending: false })
    .limit(20)
  if (error) throw new ApiError(error.message, 500)
  return (data ?? []) as unknown as SaleRow[]
}

interface ContactBrief { name: string | null; phone: string | null; channel: string | null }

async function contactBrief(contactId: string): Promise<ContactBrief | null> {
  const { data } = await svc.from('crm_contacts').select('name, phone, channel').eq('id', contactId).maybeSingle()
  return data ?? null
}

/** Grava o reembolso e devolve a venda como ficou — data e valor carimbados pelo banco. */
async function updateRefund(orgId: string, saleId: string, patch: Record<string, unknown>): Promise<SaleRow> {
  const { data, error } = await svc
    .from('crm_sales')
    .update(patch)
    .eq('id', saleId)
    .eq('organization_id', orgId)
    .select(SALE_FIELDS)
    .single()
  if (error) throw new ApiError(`Falha ao gravar o reembolso: ${error.message}`, 500)
  return data as unknown as SaleRow
}

/**
 * Os cadastros de um número. Com channel, o daquele canal (a regra de
 * sempre, crm_contact_by_phone). Sem channel, um por canal: o mesmo cliente
 * na PH e no Pedro são dois cadastros, e conferir as vendas dele tem de
 * enxergar os dois.
 *
 * A regra de "mesmo número" continua só no banco: os últimos 8 dígitos
 * apenas acham os canais em que o número pode estar (phone_key tira o 9 do
 * celular, mas nunca mexe no fim), e quem decide o cadastro de cada canal é
 * a crm_contact_by_phone, em modo estrito.
 */
async function contactsOfPhone(orgId: string, phone: string, channel: string | null): Promise<string[]> {
  const byChannel = async (ch: string | null, strict: boolean) => {
    const { data, error } = await svc.rpc('crm_contact_by_phone', {
      p_org: orgId, p_phone: phone, p_channel: ch, p_strict: strict,
    })
    if (error) throw new ApiError(error.message, 500)
    return ((data as { id: string }[] | null) ?? []).map((r) => r.id)
  }
  if (channel) return byChannel(channel, false)

  const { data, error } = await svc
    .from('crm_contacts')
    .select('channel')
    .eq('organization_id', orgId)
    .like('phone_key', `%${phone.slice(-8)}`)
    .limit(100)
  if (error) throw new ApiError(error.message, 500)

  const channels = new Map<string | null, string | null>()
  for (const c of data ?? []) {
    const key = (c.channel ?? '').trim().toLowerCase() || null
    if (!channels.has(key)) channels.set(key, c.channel)
  }
  const ids = (await Promise.all([...channels.values()].map((ch) => byChannel(ch, true)))).flat()
  return [...new Set(ids)]
}

/**
 * Valor em reais (reaisKey) ou centavos (centsKey) → centavos inteiros.
 * Ausente, null ou "" é "não veio" e devolve null: o n8n manda null quando o
 * campo de origem não existe, e isso não pode virar zero (que seria recusado
 * como valor inválido). Texto que não é número devolve NaN, para o chamador
 * responder 400.
 */
function moneyCents(body: Record<string, unknown>, reaisKey: string, centsKey: string): number | null {
  const blank = (v: unknown) => v === undefined || v === null || v === ''
  if (!blank(body[centsKey])) return Math.round(Number(body[centsKey]))
  if (!blank(body[reaisKey])) return Math.round(Number(body[reaisKey]) * 100)
  return null
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
