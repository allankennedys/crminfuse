import { useCallback, useEffect, useMemo, useState } from 'react'
import { Contact, KanbanSquare, Settings2, Plus, BarChart3, CalendarRange, LogOut, Receipt, Search, X as XIcon, MessageCircle } from 'lucide-react'
import { WhatsAppIcon } from '@/components/icons/WhatsAppIcon'
import {
  crmService, type BoardFilters, type StageStats, type ChannelCount,
} from '@/services/crmService'
import { addDaysISO, nowSPDatetimeLocal } from '@/lib/datetime'
import { useAuthStore, useCan } from '@/store/authStore'
import { useRealtime } from '@/hooks/useRealtime'
import { DateInput, Loader, EmptyState } from '@/components/ui'
import { toast } from '@/store/toastStore'
import { ContactsTable } from '@/components/crm/ContactsTable'
import { ContactDrawer } from '@/components/crm/ContactDrawer'
import { SaleDrawer } from '@/components/crm/SaleDrawer'
import { Pipeline } from '@/components/crm/Pipeline'
import { StageDialog } from '@/components/crm/StageDialog'
import { CrmSettingsPanel } from '@/components/crm/CrmSettings'
import { CrmReports } from '@/components/crm/CrmReports'
import { Atendimento } from '@/components/atendimento/Atendimento'
import { AvisosAtendimento } from '@/components/atendimento/Avisos'
import { TituloDaAba } from '@/components/atendimento/TituloDaAba'
import { PushSetup } from '@/components/PushSetup'
import { InstallBanner } from '@/components/InstallBanner'
import { desativarPush } from '@/lib/push'
import { billingService, type MySubscription } from '@/services/billingService'
import { AssinaturaBanner } from '@/components/billing/AssinaturaBanner'
import { BloqueioAssinatura } from '@/components/billing/BloqueioAssinatura'
import { useConfigNav } from '@/store/configNav'
import { Tour } from '@/components/tour/Tour'
import { useTour } from '@/store/tourStore'
import { CentralAvisos } from '@/components/atendimento/CentralAvisos'
import { LancarVendaDoContato } from '@/components/atendimento/LancarVendaDoContato'
import { StartConversation } from '@/components/atendimento/StartConversation'
import { useConversaStore } from '@/store/conversaStore'
import logoBranco from '@/assets/favicon.png'
import logoAzul from '@/assets/symbol-navy.png'
import { ThemeToggle } from '@/components/ThemeToggle'
import { useTheme } from '@/lib/theme'
import type { CrmContact, CrmStage } from '@/types'

/**
 * `perm` é a permissão que libera a aba. É espelho da RLS (055), não a
 * regra: esconder a aba evita oferecer uma tela que só carregaria vazia,
 * mas quem recusa de fato é o banco.
 *
 * Configurações aparece para quem enxerga as chaves de API — as credenciais
 * da Meta, dentro dela, são exclusivas de admin (054) e a própria seção se
 * desabilita sozinha.
 */
/**
 * Presets do recorte por data de ENTRADA. '' = todo o período e é o padrão:
 * o kanban continua sendo o funil inteiro para quem não mexer no seletor.
 *
 * `dias` só descreve os presets de "últimos N dias". Os outros três valem 0 e
 * são resolvidos por id em boardFilters: '' não filtra, 'mes' começa no dia 1
 * (janela que cresce ao longo do mês) e 'custom' vem das duas datas.
 */
const PERIODOS = [
  { id: '', label: 'Todo o período', dias: 0 },
  { id: '1', label: 'Hoje', dias: 1 },
  { id: 'mes', label: 'Este Mês', dias: 0 },
  { id: '7', label: 'Últimos 7 dias', dias: 7 },
  { id: '30', label: 'Últimos 30 dias', dias: 30 },
  { id: 'custom', label: 'Personalizado…', dias: 0 },
] as const

type BoardPeriodo = (typeof PERIODOS)[number]['id']

/** Hoje em São Paulo no formato do <input type="date">. */
function hojeSP(): string {
  return nowSPDatetimeLocal().slice(0, 10)
}

/** Dia 1 do mês corrente em São Paulo — início da janela "Este Mês". */
function inicioMesSP(): string {
  return `${hojeSP().slice(0, 7)}-01`
}

const TABS = [
  // Primeira aba e a que abre ao entrar. Também aparece para quem só tem
  // "ver todas" (ver visibleTabs).
  { id: 'atendimento', label: 'Atendimento', icon: MessageCircle, perm: 'atendimento.ver' },
  { id: 'funil', label: 'Funil', icon: KanbanSquare, perm: 'crm.funil.ver' },
  { id: 'contatos', label: 'Contatos', icon: Contact, perm: 'crm.contatos.ver' },
  { id: 'relatorios', label: 'Relatórios', icon: BarChart3, perm: 'crm.relatorios.ver' },
  { id: 'config', label: 'Configurações', icon: Settings2, perm: 'crm.chaves.ver' },
] as const

type TabId = (typeof TABS)[number]['id']

/**
 * Módulo CRM — abre em aba própria, fora do Layout do painel, para dar ao
 * kanban a largura inteira da tela.
 *
 * Etapas e contatos são carregados aqui e distribuídos para as abas: os
 * dois são necessários em quase toda tela, e um carregamento só evita
 * várias consultas repetidas ao trocar de aba.
 */
export function CRMPage() {
  const { profile, signOut } = useAuthStore()
  // Ao sair, este aparelho deixa de receber os avisos desta pessoa (quem divide
  // o aparelho não recebe os dela). A permissão do aparelho não é mexida.
  // Assinatura (147): teste, atraso e bloqueio. Recarrega ao voltar para a aba,
  // para o cliente que acabou de pagar ver o acesso voltar sem sair.
  const [assinatura, setAssinatura] = useState<MySubscription | null>(null)
  const carregarAssinatura = useCallback(() => { billingService.mySubscription().then(setAssinatura) }, [])
  useEffect(() => {
    carregarAssinatura()
    window.addEventListener('focus', carregarAssinatura)
    const i = setInterval(carregarAssinatura, 5 * 60_000)
    return () => { window.removeEventListener('focus', carregarAssinatura); clearInterval(i) }
  }, [carregarAssinatura])
  const pedirConfig = useConfigNav((s) => s.pedir)

  const sair = async () => {
    await desativarPush().catch(() => {})
    await signOut()
  }
  const organizationName = useAuthStore((s) => s.organizationName)
  const theme = useTheme((s) => s.theme)
  // Sem link de volta ao painel: os dois sistemas vivem em domínios
  // separados e sem SSO, então o "atalho" levava a uma tela de login.
  const can = useCan()
  const permissions = useAuthStore((s) => s.permissions)
  // Admin vê Configurações mesmo sem a permissão de chaves: é lá que ficam
  // as credenciais da Meta e a gestão de usuários, que são só dele.
  const isAdmin = profile?.role === 'admin'
  // useMemo porque `can` é uma função nova a cada render: sem ele o array
  // muda de identidade sempre e o efeito abaixo dispara em todo render.
  const visibleTabs = useMemo(
    () => TABS.filter((t) => {
      // Relatórios é só do admin, inclusive o de atendimento (wa_report).
      if (t.id === 'relatorios') return isAdmin
      return can(t.perm)
        || (t.id === 'config' && (isAdmin || can('atendimento.configurar') || can('atendimento.ver')))
        || (t.id === 'atendimento' && can('atendimento.ver_todas'))
        || (t.id === 'funil' && can('crm.funil.mover'))
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [permissions, isAdmin],
  )
  const [tab, setTab] = useState<TabId>('atendimento')
  // Tour de boas-vindas: no primeiro acesso do USUÁRIO (vale em qualquer aparelho,
  // guardado no banco) e quando ele pede para rever em Minha conta.
  const reverTour = useTour((s) => s.rever)
  const fecharRever = useTour((s) => s.fechar)
  const concluirTour = useAuthStore((s) => s.concluirTour)
  const primeiroAcesso = Boolean(profile) && !profile?.tour_done_at
  const mostrarTour = (primeiroAcesso || reverTour) && visibleTabs.length > 0 && assinatura?.acesso !== 'bloqueado'
  const fecharTour = () => {
    if (primeiroAcesso) void concluirTour()
    fecharRever()
  }
  // "Iniciar conversa" pedido de qualquer tela (126): a janela mora aqui e,
  // iniciada a conversa, o Atendimento abre com ela.
  const pedidoConversa = useConversaStore((s) => s.pedido)
  const fecharPedido = useConversaStore((s) => s.fechar)
  const abrirConversa = useConversaStore((s) => s.abrirConversa)

  // Modais e confirmações fazem portal para o <body>, fora do .crm-shell, e
  // .modal-page/.modal-overlay recuam pela largura da sidebar para não cobrir
  // o menu do painel. O CRM não tem sidebar: sem zerar esse recuo o modal abre
  // deslocado 248px e deixa uma faixa da tela do CRM aparecendo à esquerda.
  useEffect(() => {
    document.body.classList.add('no-sidebar')
    return () => document.body.classList.remove('no-sidebar')
  }, [])

  // A aba inicial pode não estar liberada para este usuário. Cai na primeira
  // permitida em vez de renderizar uma tela vazia que ele não pode consultar.
  useEffect(() => {
    if (visibleTabs.length === 0) return
    if (!visibleTabs.some((t) => t.id === tab)) setTab(visibleTabs[0].id)
  }, [visibleTabs, tab])

  const [stages, setStages] = useState<CrmStage[] | null>(null)
  const [contacts, setContacts] = useState<CrmContact[]>([])
  // Contagem/soma reais por etapa: o board carrega só as primeiras páginas,
  // então esses números não podem sair do que está em memória.
  const [stats, setStats] = useState<Map<string, StageStats>>(new Map())
  // Filtro de canal do funil. '' = todos. Aplicado no SERVIDOR: filtrar no
  // cliente daria resultado errado, já que o board é paginado por coluna.
  const [channel, setChannel] = useState('')
  const [channels, setChannels] = useState<ChannelCount[]>([])
  /**
   * Recorte por data de ENTRADA do lead (created_at). '' = todo o período,
   * que é o padrão — quem não mexer no seletor vê o funil de sempre.
   * 'custom' abre as duas datas; o resto é "últimos N dias".
   */
  const [periodo, setPeriodo] = useState<BoardPeriodo>('')
  const [customFrom, setCustomFrom] = useState(() => addDaysISO(hojeSP(), -29))
  const [customTo, setCustomTo] = useState(() => hojeSP())
  // Busca geral do kanban. '' = board normal (paginado). Com termo, o board
  // é substituído pelos contatos que casam, em todas as colunas de uma vez.
  const [search, setSearch] = useState('')
  // null = não está buscando; array = resultado da busca ativa.
  const [searchResults, setSearchResults] = useState<CrmContact[] | null>(null)

  // null = fechado; undefined = novo contato; objeto = editando
  const [editingContact, setEditingContact] = useState<CrmContact | null | undefined>(null)
  // null = fechado; undefined = nova etapa; objeto = editando
  const [editingStage, setEditingStage] = useState<CrmStage | null | undefined>(null)
  // Lançamento rápido de venda a partir do funil: escolhe o cliente, informa
  // o valor e a forma de pagamento.
  // true = lançamento pelo botão, cliente a escolher; contato = card arrastado
  // para a conversão, já escolhido.
  const [launchingSale, setLaunchingSale] = useState<boolean | CrmContact>(false)

  // Bump a cada recarga: a busca do funil escuta isto para refazer a consulta.
  // Com busca ativa o board mostra searchResults, que não sai do refresh —
  // sem isto, salvar um contato encontrado pela busca não atualizava o card.
  const [reloadCount, setReloadCount] = useState(0)

  // Um objeto só, usado pelo carregamento, pelo "carregar mais" e pela
  // busca — as três consultas TÊM que enxergar o mesmo recorte, senão a
  // coluna mostra card que o cabeçalho não conta.
  const boardFilters: BoardFilters = useMemo(() => {
    const dias = PERIODOS.find((p) => p.id === periodo)?.dias
    if (periodo === 'custom') {
      // Invertidas? O usuário escolheu as duas; o intervalo entre elas é o
      // que ele quis dizer.
      const [from, to] = customFrom <= customTo ? [customFrom, customTo] : [customTo, customFrom]
      return { channel: channel || undefined, from, to }
    }
    if (periodo === 'mes') {
      return { channel: channel || undefined, from: inicioMesSP(), to: hojeSP() }
    }
    if (!dias) return { channel: channel || undefined }
    return { channel: channel || undefined, from: addDaysISO(hojeSP(), -(dias - 1)), to: hojeSP() }
  }, [channel, periodo, customFrom, customTo])

  const refresh = useCallback(async () => {
    setReloadCount((n) => n + 1)
    try {
      const [stageList, contactList, statList] = await Promise.all([
        crmService.listStages(),
        crmService.listForBoard(undefined, boardFilters),
        crmService.stageStats(boardFilters),
      ])
      setStages(stageList)
      setContacts(contactList)
      setStats(new Map(statList.map((st) => [st.stage_id, st])))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao carregar o CRM')
      setStages([])
    }
  }, [boardFilters])

  // Quem só atende (cargo atendente) não enxerga nada do funil: carregar
  // etapas e contatos só daria erro na tela dele.
  const temCrm = permissions.some((p) => p.startsWith('crm.'))

  // Primeira visita da organização: cria o funil padrão antes de carregar.
  useEffect(() => {
    if (!temCrm) { setStages([]); return }
    crmService.bootstrap()
      .catch(() => { /* já existe ou sem permissão — refresh mostra o estado real */ })
      .finally(refresh)
  }, [refresh, temCrm])

  // Canais em uso — alimentam o filtro da barra do funil. Recarregam junto
  // com o board para um canal novo aparecer sem F5. (Origens e etiquetas são
  // carregadas pelo próprio drawer, que é quem as oferece.)
  useEffect(() => {
    if (!temCrm) return
    crmService.listChannels().then(setChannels).catch(() => setChannels([]))
  }, [contacts.length, temCrm])

  // Busca com debounce e piso de 2 caracteres: economiza consultas — sem
  // isso, cada tecla varreria a tabela. Só dispara ao parar de digitar.
  useEffect(() => {
    const term = search.trim()
    if (term.length < 2) { setSearchResults(null); return }
    let alive = true
    const timer = setTimeout(() => {
      crmService.searchBoard(term, boardFilters)
        .then((rows) => { if (alive) setSearchResults(rows) })
        .catch((err) => toast.error(err instanceof Error ? err.message : 'Falha na busca'))
    }, 350)
    return () => { alive = false; clearTimeout(timer) }
  }, [search, boardFilters, reloadCount])

  /** "Carregar mais" de uma coluna: busca a próxima página e anexa. */
  const loadMoreStage = useCallback(async (stageId: string, loaded: number) => {
    try {
      const more = await crmService.listStageContacts(stageId, loaded, undefined, boardFilters)
      if (!more.length) return
      setContacts((cur) => {
        // Descarta o que já está em memória: o Realtime pode ter inserido
        // algum destes cards entre o carregamento e o clique.
        const seen = new Set(cur.map((c) => c.id))
        return [...cur, ...more.filter((c) => !seen.has(c.id))]
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao carregar mais contatos')
    }
  }, [boardFilters])

  /**
   * Kanban vivo, sem refazer consulta.
   *
   * O Realtime já entrega a linha alterada no payload, então aplicamos a
   * mudança no estado local em vez de recarregar etapas e contatos inteiros.
   * Com o refetch, cada movimentação de card baixava a tabela toda em cada
   * aba aberta — o que consumia egresso proporcional a (nº de contatos ×
   * nº de abas × nº de mudanças). Aqui o custo é uma linha por evento.
   */
  useRealtime<CrmContact>('crm_contacts', (payload) => {
    setContacts((cur) => {
      if (payload.eventType === 'DELETE') {
        const gone = (payload.old as Partial<CrmContact>)?.id
        return gone ? cur.filter((c) => c.id !== gone) : cur
      }
      const row = payload.new as CrmContact
      if (!row?.id) return cur
      // Com filtro de canal ativo, um contato de outro canal não entra —
      // e se o canal dele mudou para fora do filtro, sai da lista.
      if (channel && row.channel !== channel) {
        return cur.filter((c) => c.id !== row.id)
      }
      const i = cur.findIndex((c) => c.id === row.id)
      if (i === -1) return [...cur, row]
      // Substitui no lugar: preserva a ordem já calculada da coluna.
      const next = [...cur]
      next[i] = row
      return next
    })
  })

  useRealtime<CrmStage>('crm_stages', (payload) => {
    setStages((cur) => {
      if (!cur) return cur
      if (payload.eventType === 'DELETE') {
        const gone = (payload.old as Partial<CrmStage>)?.id
        return gone ? cur.filter((s) => s.id !== gone) : cur
      }
      const row = payload.new as CrmStage
      if (!row?.id) return cur
      const i = cur.findIndex((s) => s.id === row.id)
      const next = i === -1 ? [...cur, row] : cur.map((s) => (s.id === row.id ? row : s))
      // Reordenar etapas chega como vários UPDATEs de position; manter
      // ordenado aqui evita as colunas piscarem fora de ordem no meio.
      return next.sort((a, b) => a.position - b.position)
    })
  })

  // "CRM" no cabeçalho de uma conversa: abre o mesmo drawer do funil.
  const openContactById = useCallback((id: string) => {
    crmService.getContact(id)
      .then((c) => setEditingContact(c))
      .catch((err) => toast.error(err instanceof Error ? err.message : 'Contato não encontrado'))
  }, [])

  // Contagem de todo o funil (não só do que foi carregado).
  const funnelCount = [...stats.values()].reduce((sum, st) => sum + Number(st.contact_count), 0)

  // Durante a busca, o board vem do resultado (todas as colunas) e os
  // contadores são recalculados do próprio resultado — sem "carregar mais",
  // já que a busca traz tudo o que casa.
  const searching = searchResults !== null
  const searchStats = useMemo(() => {
    const m = new Map<string, StageStats>()
    if (!searchResults) return m
    for (const c of searchResults) {
      if (!c.stage_id) continue
      const cur = m.get(c.stage_id) ?? { stage_id: c.stage_id, contact_count: 0, total_value_cents: 0 }
      cur.contact_count += 1
      cur.total_value_cents += Number(c.value_cents)
      m.set(c.stage_id, cur)
    }
    return m
  }, [searchResults])

  const boardContacts = searchResults ?? contacts
  const boardStats = searching ? searchStats : stats
  const noopLoadMore = useCallback(async () => { /* busca já traz tudo */ }, [])

  return (
    <div className="crm-shell">
      <header className="topbar crm-topbar">
        <button
          type="button"
          className="crm-brand"
          title="Ir para o Atendimento"
          aria-label={`${organizationName || 'CRM'}: ir para o Atendimento`}
          disabled={!visibleTabs.some((t) => t.id === 'atendimento')}
          onClick={() => setTab('atendimento')}
        >
          <img src={theme === 'light' ? logoAzul : logoBranco} alt="" className="logo-img" style={{ width: 24, height: 24 }} />
          <span className="topbar-title crm-org-name" title={organizationName ?? undefined}>
            {organizationName || 'CRM'}
          </span>
        </button>

        <nav className="crm-tabs">
          {visibleTabs.map(({ id, label, icon: TabIcon }) => (
            <button
              key={id}
              className={`crm-tab${tab === id ? ' active' : ''}`}
              data-tour={`tab-${id}`}
              onClick={() => setTab(id)}
            >
              <TabIcon size={15} /> {label}
            </button>
          ))}
        </nav>

        <div className="flex">
          <span className="badge badge-gray">{profile?.role}</span>
          <span className="text-secondary crm-user">
            {profile?.full_name ?? profile?.email}
          </span>
          {can('atendimento.ver') && <CentralAvisos />}
          <ThemeToggle />
          <button className="icon-btn" onClick={sair} title="Sair" aria-label="Sair">
            <LogOut size={16} />
          </button>
        </div>
      </header>

      {mostrarTour && (
        <Tour
          admin={profile?.role === 'admin'}
          abasVisiveis={visibleTabs.map((t) => t.id)}
          abrirAba={(id) => setTab(id as TabId)}
          onFechar={fecharTour}
        />
      )}

      {assinatura && (
        <AssinaturaBanner sub={assinatura} onOpenPlano={() => { pedirConfig('plano'); setTab('config') }} />
      )}
      {assinatura?.acesso === 'bloqueado' && (
        <BloqueioAssinatura sub={assinatura} onChanged={carregarAssinatura} onSignOut={sair} />
      )}

      <TituloDaAba />
      {can('atendimento.ver') && <PushSetup />}
      {can('atendimento.ver') && <AvisosAtendimento />}

      <main className={tab === 'funil' ? 'crm-main crm-main-board' : tab === 'atendimento' ? 'crm-main crm-main-chat' : 'crm-main'}>
        {tab === 'atendimento' ? (
          <Atendimento onOpenContact={openContactById} />
        ) : stages === null ? (
          <Loader />
        ) : tab === 'funil' ? (
          stages.length === 0 ? (
            <div className="crm-panel">
              <EmptyState icon={<KanbanSquare />} text="Nenhuma etapa no funil ainda." />
              <div style={{ textAlign: 'center' }}>
                <button className="btn btn-primary" onClick={() => setEditingStage(undefined)}>
                  <Plus size={15} /> Criar primeira etapa
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="crm-board-bar">
                {can('crm.vendas.editar') && (
                  <button className="btn btn-primary btn-sm" onClick={() => setLaunchingSale(true)}>
                    <Receipt size={15} /> Lançar venda
                  </button>
                )}
                <button className="btn btn-ghost btn-sm" onClick={() => setEditingContact(undefined)}>
                  <Plus size={15} /> Novo contato
                </button>
                <span className="text-muted board-count">
                  {searching
                    ? `${boardContacts.length} resultado(s)`
                    : `${funnelCount} no funil · ${stages.length} etapa(s)`}
                </span>

                <label className="crm-search">
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Buscar por nome ou número…"
                    aria-label="Buscar no funil"
                  />
                  {search && (
                    <button className="crm-search-clear" onClick={() => setSearch('')} aria-label="Limpar busca">
                      <XIcon size={13} />
                    </button>
                  )}
                  <Search size={14} />
                </label>

                {/* Recorta pela data de ENTRADA do lead — o mesmo recorte
                    que a aba Funil dos relatórios chama de "entrada", para os
                    dois números baterem no mesmo período. */}
                <label className="channel-filter" title="Filtra pela data de entrada do lead">
                  <CalendarRange size={14} />
                  <select value={periodo} onChange={(e) => setPeriodo(e.target.value as BoardPeriodo)}>
                    {PERIODOS.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </label>

                {periodo === 'custom' && (
                  <span className="board-range">
                    <DateInput
                      value={customFrom}
                      max={hojeSP()}
                      onChange={(v) => v && setCustomFrom(v)}
                      ariaLabel="Entrada a partir de"
                    />
                    <span className="text-muted">até</span>
                    <DateInput
                      value={customTo}
                      max={hojeSP()}
                      onChange={(v) => v && setCustomTo(v)}
                      ariaLabel="Entrada até"
                    />
                  </span>
                )}

                {channels.length > 0 && (
                  <label className="channel-filter">
                    <WhatsAppIcon size={14} color="var(--primary-text)" />
                    <select value={channel} onChange={(e) => setChannel(e.target.value)}>
                      <option value="">Todos os canais</option>
                      {channels.map((c) => (
                        <option key={c.channel} value={c.channel}>
                          {c.channel} ({c.contact_count})
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <Pipeline
                stages={stages}
                contacts={boardContacts}
                stats={boardStats}
                onLoadMore={searching ? noopLoadMore : loadMoreStage}
                onEditStage={(s) => setEditingStage(s)}
                onNewStage={() => setEditingStage(undefined)}
                onOpenContact={(c) => setEditingContact(c)}
                onConvertWithoutSale={(c) => setLaunchingSale(c)}
              />
            </>
          )
        ) : tab === 'contatos' ? (
          <ContactsTable stages={stages} onChanged={refresh} />
        ) : tab === 'relatorios' ? (
          <CrmReports stages={stages} />
        ) : (
          <CrmSettingsPanel />
        )}
      </main>

      <InstallBanner />

      {pedidoConversa && (
        <StartConversation
          initialContact={pedidoConversa.contact}
          onClose={fecharPedido}
          onStarted={(id) => {
            abrirConversa(id)
            setEditingContact(null)
            setTab('atendimento')
          }}
        />
      )}

      {editingContact !== null && stages && (
        <ContactDrawer
          contact={editingContact ?? null}
          stages={stages}
          onClose={() => setEditingContact(null)}
          onSaved={refresh}
        />
      )}

      {launchingSale && stages && (can('crm.vendas.editar') ? (
        <SaleDrawer
          stages={stages}
          initialContact={launchingSale === true ? undefined : launchingSale}
          onClose={() => setLaunchingSale(false)}
          onSaved={refresh}
        />
      ) : launchingSale !== true ? (
        // Sem acesso às vendas do CRM (ex.: Atendente): lança pela conversa dele.
        <LancarVendaDoContato
          contact={launchingSale}
          onClose={() => setLaunchingSale(false)}
          onSaved={refresh}
        />
      ) : null)}

      {editingStage !== null && stages && (
        <StageDialog
          stage={editingStage ?? null}
          stages={stages}
          contactCount={editingStage ? Number(stats.get(editingStage.id)?.contact_count ?? 0) : 0}
          onClose={() => setEditingStage(null)}
          onSaved={refresh}
        />
      )}
    </div>
  )
}
