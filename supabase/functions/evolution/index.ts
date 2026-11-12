/**
 * Edge Function: evolution
 *
 * Proxy seguro para a Evolution API. A chave global (EVOLUTION_API_KEY)
 * vive apenas aqui — nunca no navegador.
 *
 * Validações por requisição:
 *  1. Usuário autenticado no Supabase.
 *  2. Rota na whitelist (nada além do que o painel usa).
 *  3. Permissão correspondente à rota, perguntada ao banco.
 *  4. A instância da rota pertence à organização do usuário
 *     (consulta com RLS + verificação global de posse no create).
 *
 * PERMISSÃO, NÃO CARGO
 *
 * Até aqui a regra era `role === 'gestor' → 403`, e ela ignorava tudo que a
 * 055 construiu: preset por cargo e lista personalizada por usuário. Duas
 * consequências ruins. Dar "editar grupos" a alguém na tela de usuários não
 * surtia efeito nenhum aqui — o 403 continuava, e ninguém entendia por quê.
 * E qualquer mudança de política exigia deploy de função, em vez de uma
 * migration.
 *
 * Agora cada rota declara a permissão que ela exige e quem responde é
 * current_user_can() no banco — a MESMA função que as políticas de RLS usam.
 * Assim o proxy e a tabela nunca discordam: se a Edge Function deixa passar,
 * a gravação que vem depois também passa.
 *
 * A permissão de cada rota é a da AÇÃO, não a da leitura. Buscar grupos na
 * Evolution parece leitura, mas existe para importar — e a importação grava
 * em public.groups, que exige painel.grupos.editar. Pedir menos aqui só
 * adiantaria o erro para a linha seguinte.
 *
 * EVOLUTION COMPARTILHADA (SaaS, 117)
 *
 * A chave global enxerga TODAS as instâncias do servidor, inclusive as de
 * outros sistemas. Quem isola é esta função:
 *   • criar: o nome é gerado aqui (prefixo + aleatório) e a instância NUNCA
 *     é "adotada" — se o nome já existir na Evolution, sorteia outro. Só
 *     depois de criada lá a linha entra em whatsapp_sessions, com o dono;
 *   • qualquer outra rota: a instância tem que estar em whatsapp_sessions e
 *     ser DO USUÁRIO (created_by), não só da organização.
 *
 * Secrets necessários (supabase secrets set):
 *   EVOLUTION_API_URL, EVOLUTION_API_KEY
 *   INSTANCE_PREFIX (opcional, padrão "infuse")
 */

import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface Route {
  method: string
  pattern: RegExp
  /** índice do grupo de captura com o nome da instância; -1 = sem instância */
  instanceGroup: number
  /** Permissão exigida — a mesma string da 055 e da tela de usuários. */
  perm: string
}

const ROUTES: Route[] = [
  { method: 'POST', pattern: /^\/instance\/create$/, instanceGroup: -1, perm: 'painel.numeros.editar' },
  { method: 'GET', pattern: /^\/instance\/connect\/([^/?]+)$/, instanceGroup: 1, perm: 'painel.numeros.editar' },
  // Ler o estado da conexão é leitura de verdade: a tela de Números mostra o
  // badge para quem só acompanha, e o SessionPicker depende disso para avisar
  // que o número está fora do ar antes de alguém agendar um envio.
  { method: 'GET', pattern: /^\/instance\/connectionState\/([^/?]+)$/, instanceGroup: 1, perm: 'painel.numeros.ver' },
  { method: 'POST', pattern: /^\/instance\/restart\/([^/?]+)$/, instanceGroup: 1, perm: 'painel.numeros.editar' },
  { method: 'DELETE', pattern: /^\/instance\/logout\/([^/?]+)$/, instanceGroup: 1, perm: 'painel.numeros.editar' },
  { method: 'DELETE', pattern: /^\/instance\/delete\/([^/?]+)$/, instanceGroup: 1, perm: 'painel.numeros.editar' },
  { method: 'POST', pattern: /^\/message\/send(?:Text|Media|WhatsAppAudio)\/([^/?]+)$/, instanceGroup: 1, perm: 'painel.mensagens.enviar' },
  { method: 'POST', pattern: /^\/group\/create\/([^/?]+)$/, instanceGroup: 1, perm: 'painel.grupos.editar' },
  // fetchAllGroups NÃO está aqui de propósito. É a chamada que estourava o
  // tempo desta função em número com muitos grupos; hoje quem a faz é o
  // worker, fora do pedido do usuário, e o painel lê o resultado de
  // session_groups. Ver a migration 067.
  { method: 'GET', pattern: /^\/group\/participants\/([^/?]+)\?/, instanceGroup: 1, perm: 'painel.grupos.editar' },
  { method: 'POST', pattern: /^\/group\/updateParticipant\/([^/?]+)\?/, instanceGroup: 1, perm: 'painel.grupos.editar' },
  // Só é chamada dentro da sincronização, para trocar jid por nome.
  { method: 'POST', pattern: /^\/chat\/findContacts\/([^/?]+)$/, instanceGroup: 1, perm: 'painel.grupos.editar' },
  // findChats esteve aqui e foi removida: apesar de a instância ir na URL,
  // ela devolveu conversas de OUTRAS instâncias. Enquanto isso não for
  // entendido, o painel não fala com essa rota.
  { method: 'POST', pattern: /^\/webhook\/set\/([^/?]+)$/, instanceGroup: 1, perm: 'painel.numeros.editar' },
]

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS })
  }

  try {
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    )

    const { data: { user } } = await userClient.auth.getUser()
    if (!user) return json({ ok: false, status: 401, data: { error: 'Não autenticado' } }, 401)

    const { data: profile } = await userClient
      .from('users')
      .select('organization_id, role')
      .eq('id', user.id)
      .single()

    if (!profile) {
      return json({ ok: false, status: 403, data: { error: 'Usuário sem perfil nesta organização' } }, 403)
    }

    const { path, method, body } = await req.json()
    if (typeof path !== 'string' || typeof method !== 'string') {
      return json({ ok: false, status: 400, data: { error: 'Requisição inválida' } }, 400)
    }

    const route = ROUTES.find((r) => r.method === method.toUpperCase() && r.pattern.test(path))
    if (!route) {
      return json({ ok: false, status: 403, data: { error: 'Rota não permitida' } }, 403)
    }

    // Quem responde é o banco, com o token do próprio usuário: current_user_can
    // já cobre admin (sempre sim), usuário inativo (sempre não), lista
    // personalizada e preset do cargo — nesta ordem.
    const { data: pode, error: permErro } = await userClient.rpc('current_user_can', { p_perm: route.perm })
    if (permErro) {
      return json({ ok: false, status: 500, data: { error: 'Falha ao verificar permissão' } }, 500)
    }
    if (pode !== true) {
      // A permissão vai no corpo de propósito: o 403 sozinho manda a pessoa
      // procurar problema de conexão, que foi o que já aconteceu.
      return json({
        ok: false,
        status: 403,
        data: { error: `Seu perfil não tem a permissão "${route.perm}" para esta ação` },
      }, 403)
    }

    // Cliente com service role para checagens globais entre organizações
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    if (route.instanceGroup < 0) {
      // Criar: o nome que veio do painel é ignorado de propósito.
      return json(await createInstance(adminClient, profile.organization_id, user.id))
    }

    // Rota com instância: tem que ser um número DESTE usuário.
    const instance = decodeURIComponent(path.match(route.pattern)![route.instanceGroup])
    const { data: session } = await adminClient
      .from('whatsapp_sessions')
      .select('id, organization_id, created_by, phone_number')
      .eq('instance_name', instance)
      .maybeSingle()

    const dono = session && session.organization_id === profile.organization_id && (
      session.created_by === user.id || (session.created_by === null && profile.role === 'admin')
    )
    if (!dono) {
      return json({ ok: false, status: 403, data: { error: 'Número não encontrado entre os seus' } }, 403)
    }

    const baseUrl = Deno.env.get('EVOLUTION_API_URL')!.replace(/\/+$/, '')
    const res = await fetch(`${baseUrl}${path}`, {
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        apikey: Deno.env.get('EVOLUTION_API_KEY')!,
      },
      body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
    })

    let data: unknown = null
    try {
      data = await res.json()
    } catch { /* resposta sem corpo */ }

    // Conectou e ainda não sabemos o telefone: pergunta à Evolution SÓ por
    // esta instância e guarda. O nome é gerado, então o telefone é o que o
    // usuário reconhece na lista.
    const state = (data as { instance?: { state?: string } } | null)?.instance?.state
    if (route.perm === 'painel.numeros.ver' && state === 'open' && !session!.phone_number) {
      const phone = await ownerPhone(instance)
      if (phone) await adminClient.from('whatsapp_sessions').update({ phone_number: phone }).eq('id', session!.id)
    }

    // Removida na Evolution = removida aqui. Sem isto a linha ficaria
    // apontando para um nome livre, que outro sistema poderia criar depois.
    if (path.startsWith('/instance/delete/') && (res.ok || res.status === 404)) {
      await adminClient.from('whatsapp_sessions').delete().eq('id', session!.id)
    }

    return json({ ok: res.ok, status: res.status, data })
  } catch (err) {
    return json({ ok: false, status: 500, data: { error: err instanceof Error ? err.message : 'Erro interno' } }, 500)
  }
})

// ---------------------------------------------------------------------------

function evolutionBase() {
  return Deno.env.get('EVOLUTION_API_URL')!.replace(/\/+$/, '')
}

async function evo(method: string, path: string, body?: unknown) {
  const res = await fetch(`${evolutionBase()}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', apikey: Deno.env.get('EVOLUTION_API_KEY')! },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data: unknown = null
  try { data = await res.json() } catch { /* sem corpo */ }
  return { ok: res.ok, status: res.status, data }
}

function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Cria a instância na Evolution com nome próprio e só então registra o
 * número, já com dono. Nome existente = sorteia outro; nunca reaproveita.
 */
// deno-lint-ignore no-explicit-any
async function createInstance(adminClient: any, organizationId: string, userId: string) {
  const prefix = (Deno.env.get('INSTANCE_PREFIX') ?? 'infuse').toLowerCase().replace(/[^a-z0-9]/g, '') || 'inst'

  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const name = `${prefix}-${randomSuffix()}`

    // Já existe na Evolution (de quem for)? Então não é nosso: outro nome.
    const existe = await evo('GET', `/instance/connectionState/${name}`)
    if (existe.ok) continue

    const created = await evo('POST', '/instance/create', {
      instanceName: name,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    })
    if (!created.ok) {
      // 403/409 = o nome apareceu entre a consulta e a criação. Outro nome.
      if (created.status === 403 || created.status === 409) continue
      return { ok: false, status: created.status, data: created.data }
    }

    const { data: session, error } = await adminClient.from('whatsapp_sessions').insert({
      organization_id: organizationId,
      instance_name: name,
      created_by: userId,
      status: 'connecting',
    }).select().single()

    if (error) {
      // Não deixa instância órfã no servidor compartilhado.
      await evo('DELETE', `/instance/delete/${name}`).catch(() => {})
      return { ok: false, status: 500, data: { error: 'Falha ao registrar o número' } }
    }

    const qr = (created.data as { qrcode?: { base64?: string } } | null)?.qrcode
    return { ok: true, status: 201, data: { session, qrcode: qr ?? null } }
  }

  return { ok: false, status: 409, data: { error: 'Não foi possível gerar um nome livre para o número. Tente de novo.' } }
}

/** Telefone do número conectado, perguntado só para esta instância. */
async function ownerPhone(instance: string): Promise<string | null> {
  const res = await evo('GET', `/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`).catch(() => null)
  const list = Array.isArray(res?.data) ? res!.data as Array<Record<string, unknown>> : []
  // Filtra de novo pelo nome: versões antigas ignoram o parâmetro e devolvem
  // todas as instâncias do servidor.
  const mine = list.find((i) => (i.name ?? (i.instance as Record<string, unknown> | undefined)?.instanceName) === instance)
  const jid = String(mine?.ownerJid ?? (mine?.instance as Record<string, unknown> | undefined)?.owner ?? '')
  const digits = jid.split('@')[0].replace(/\D/g, '')
  return digits.length >= 10 ? digits : null
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
