import { useCallback, useEffect, useState } from 'react'
import { BellRing, CreditCard, KeyRound, Megaphone, Plus, ShieldCheck, Trash2, Users as UsersIcon, Building2, MessageCircle } from 'lucide-react'
import { CustomFieldsSettings } from './CustomFields'
import { ReportTabsSettings } from './ReportTabsSettings'
import { AtendimentoSettings } from '@/components/atendimento/AtendimentoSettings'
import { NotificacoesSettings } from '@/components/atendimento/NotificacoesSettings'
import { PlanoCobranca } from '@/components/billing/PlanoCobranca'
import { PlataformaSettings } from '@/components/billing/PlataformaSettings'
import { useIsOwner } from '@/components/billing/useIsOwner'
import { billingService, type MySubscription } from '@/services/billingService'
import { useConfigNav } from '@/store/configNav'
import { supabase } from '@/lib/supabase'
import { crmService } from '@/services/crmService'
import { useAuthStore, useCan } from '@/store/authStore'
import { UserAccess } from '@/components/settings/UserAccess'
import { Loader } from '@/components/ui'
import { toast } from '@/store/toastStore'
import { confirmDialog } from '@/store/confirmStore'
import type { CrmAdAccount, CrmSettings as Settings } from '@/types'

const SETTINGS_TAB_ALL = [
  { id: 'plano', label: 'Plano e cobrança', icon: CreditCard },
  { id: 'plataforma', label: 'Plataforma', icon: Building2 },
  { id: 'notificacoes', label: 'Notificações', icon: BellRing },
  { id: 'org', label: 'Organização', icon: Building2 },
  { id: 'atendimento', label: 'Atendimento', icon: MessageCircle },
  { id: 'users', label: 'Usuários', icon: UsersIcon },
  { id: 'integrations', label: 'Integrações', icon: ShieldCheck },
] as const

type SettingsTab = (typeof SETTINGS_TAB_ALL)[number]['id']

/**
 * Configurações do CRM: usuários/acessos, Meta Conversion API e chaves
 * para automações, organizadas em abas.
 *
 * O access token nunca volta do servidor — a tela só sabe se existe um
 * salvo (has_token). Campo em branco mantém o token atual; para trocar,
 * digite um novo.
 */
export function CrmSettingsPanel() {
  const profile = useAuthStore((s) => s.profile)
  const isAdmin = profile?.role === 'admin'
  // Credenciais da Meta são exclusivas de admin desde a 054: token e conta de
  // anúncios decidem a quem a Meta credita receita, e trocá-los por engano
  // pararia todo o envio de conversões. A RPC recusa de qualquer forma —
  // aqui os campos só ficam desabilitados para não oferecer o que não vai dar.
  const canEditMeta = isAdmin
  // Aba de usuários só existe para admin — mesma regra que já escondia a seção.
  const can = useCan()
  const podeConfigurarAtendimento = can('atendimento.configurar')
  const isOwner = useIsOwner()
  const settingsTabs = SETTINGS_TAB_ALL.filter((t) => {
    // Plano e cobrança: administradores da organização. Plataforma: só o dono.
    if (t.id === 'plano') return isAdmin
    if (t.id === 'plataforma') return isOwner
    // Notificações: de cada pessoa, qualquer um que atende (ou é admin).
    if (t.id === 'notificacoes') return isAdmin || can('atendimento.ver')
    if (t.id === 'atendimento') return podeConfigurarAtendimento
    if (t.id === 'users' || t.id === 'org') return isAdmin
    // Integrações (Meta): só admin.
    return isAdmin
  })
  const [tab, setTab] = useState<SettingsTab>(isAdmin ? 'org' : podeConfigurarAtendimento ? 'atendimento' : 'notificacoes')
  // Assinatura (aba Plano e cobrança) e pedido de abrir direto nela (aviso do topo).
  const [assinatura, setAssinatura] = useState<MySubscription | null>(null)
  const carregarAssinatura = useCallback(() => { billingService.mySubscription().then(setAssinatura) }, [])
  useEffect(() => { if (tab === 'plano') carregarAssinatura() }, [tab, carregarAssinatura])
  const pedida = useConfigNav((n) => n.pedida)
  const consumirPedida = useConfigNav((n) => n.consumir)
  useEffect(() => {
    if (pedida && SETTINGS_TAB_ALL.some((t) => t.id === pedida)) { setTab(pedida as SettingsTab); consumirPedida() }
  }, [pedida, consumirPedida])

  const [settings, setSettings] = useState<Settings | null>(null)
  const [pixel, setPixel] = useState('')
  const [token, setToken] = useState('')
  // Mostra o campo de token só quando não há um salvo, ou quando o usuário
  // pede pra trocar — evita o input mascarado + placeholder-dica ocioso.
  const [editingToken, setEditingToken] = useState(false)
  const [testCode, setTestCode] = useState('')
  // Página do Facebook dos anúncios: sem ela a venda de quem clicou no
  // anúncio não é aceita pela Meta (o clique é validado contra a Página).
  const [pageId, setPageId] = useState('')
  // Leitura dos anúncios (Marketing API). As CONTAS moram em tabela própria
  // e têm seção própria (AdAccountsSection) — aqui fica só o token da
  // organização, que serve de padrão para as contas sem token próprio. Ele é
  // separado do da Conversion API porque o que já está salvo e funcionando
  // pode não ter ads_read — trocá-lo para ganhar o relatório derrubaria o
  // envio das conversões.
  const [adsToken, setAdsToken] = useState('')
  const [editingAdsToken, setEditingAdsToken] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)

  const loadSettings = useCallback(() => {
    crmService.getSettings()
      .then((s) => {
        setSettings(s)
        setPixel(s.meta_pixel_id ?? '')
        setTestCode(s.meta_test_event_code ?? '')
        setPageId(s.meta_page_id ?? '')
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : 'Falha ao carregar configurações'))
  }, [])

  // Meta só para quem vê a aba: quem só configura o atendimento não tem
  // acesso e veria um erro à toa.
  const veIntegracoes = isAdmin
  useEffect(() => {
    if (!veIntegracoes) return
    loadSettings()
  }, [loadSettings, veIntegracoes])

  async function saveSettings() {
    setSavingSettings(true)
    try {
      // Campo de token em branco = "não mexa no que já está salvo": a tela
      // nunca recebe o token, então vazio não pode significar "apague".
      // adAccount fica de fora: as contas são gravadas por AdAccountsSection,
      // e mandar o campo aqui sobrescreveria o espelho que o banco mantém.
      await crmService.saveSettings(pixel.trim(), {
        token: token.trim() || undefined,
        testCode: testCode.trim(),
        adsToken: adsToken.trim() || undefined,
      })
      if (pageId.replace(/\D/g, '') !== (settings?.meta_page_id ?? '')) {
        await crmService.savePageId(pageId)
      }
      toast.success('Configurações salvas')
      setToken('')
      setAdsToken('')
      setEditingToken(false)
      setEditingAdsToken(false)
      loadSettings()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar')
    } finally {
      setSavingSettings(false)
    }
  }

  return (
    <div className="crm-settings">
      <div className="crm-tabs" style={{ marginBottom: 4 }}>
        {settingsTabs.map((t) => (
          <button
            key={t.id}
            className={`crm-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {/* ---------- Usuários e acessos ----------
          Só para admin da organização. Usuários "crm_only" nunca são admin,
          então a gestão de acessos não aparece para eles (a aba nem existe). */}
      {tab === 'notificacoes' && <NotificacoesSettings />}

      {tab === 'plano' && isAdmin && (assinatura
        ? <PlanoCobranca sub={assinatura} onChanged={carregarAssinatura} />
        : <Loader />)}
      {tab === 'plataforma' && isOwner && <PlataformaSettings />}

      {tab === 'org' && isAdmin && <OrganizationSection />}
      {tab === 'org' && isAdmin && <ReportTabsSettings />}
      {tab === 'org' && isAdmin && <CustomFieldsSettings />}

      {tab === 'atendimento' && podeConfigurarAtendimento && <AtendimentoSettings />}

      {tab === 'users' && isAdmin && (
        <section className="card">
          <UserAccess crm />
        </section>
      )}

      {/* ---------- Meta Conversion API ---------- */}
      {tab === 'integrations' && settings === null && <Loader />}
      {tab === 'integrations' && settings !== null && (
      <section className="card">
        <h3 className="card-title"><ShieldCheck size={15} /> Aviso de vendas para a Meta</h3>
        <p className="text-muted" style={{ fontSize: 12, marginBottom: 16 }}>
          Cada venda de cliente que veio de anúncio é avisada à Meta sozinha: a
          primeira e as recompras. É assim que ela sabe quais anúncios estão dando
          venda e passa a procurar mais gente parecida. Na Meta isso se chama
          Conversions API.
        </p>

        <div className="field">
          <label>Pixel ID</label>
          <input
            className="input mono"
            value={pixel}
            onChange={(e) => setPixel(e.target.value)}
            placeholder="123456789012345"
            disabled={!canEditMeta}
          />
          <p className="text-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
            É o mesmo pixel que você já usa nos anúncios. O número fica no
            Gerenciador de Eventos da Meta, ao lado do nome dele.
          </p>
        </div>

        <div className="field">
          <label>
            ID da Página do Facebook
            {settings.meta_page_id && (
              <span className="badge badge-green" style={{ marginLeft: 8 }}>Configurada</span>
            )}
          </label>
          <input
            className="input mono"
            value={pageId}
            onChange={(e) => setPageId(e.target.value)}
            placeholder="102938475610293"
            inputMode="numeric"
            disabled={!canEditMeta}
          />
          <p className="text-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
            A Página que aparece como anunciante nos anúncios de mensagem para o
            WhatsApp. Sem ela, a Meta não aceita o aviso das vendas de quem clicou
            no anúncio. Elas ficam guardadas e saem sozinhas assim que a Página
            for salva. O número fica no Facebook, na Página → <em>Sobre</em> →{' '}
            <em>Transparência da Página</em> (ou no Meta Business Suite, em
            Configurações → Página).
          </p>
        </div>

        <div className="field">
          <label>
            Access Token
            {settings.has_token && (
              <span className="badge badge-green" style={{ marginLeft: 8 }}>Configurado</span>
            )}
          </label>
          {settings.has_token && !editingToken ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setEditingToken(true)}
              disabled={!canEditMeta}
            >
              <KeyRound size={13} /> Atualizar token
            </button>
          ) : (
            <div className="flex" style={{ gap: 8 }}>
              <input
                className="input mono"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="EAAG..."
                disabled={!canEditMeta}
                autoComplete="new-password"
                autoFocus
              />
              {settings.has_token && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => { setEditingToken(false); setToken('') }}
                >
                  Cancelar
                </button>
              )}
            </div>
          )}
          <p className="text-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
            Você gera esse código no Gerenciador de Eventos da Meta, nas
            configurações do pixel. Depois de salvo ele nunca mais aparece na
            tela. Para trocar, cole um novo por cima.
          </p>
        </div>

        <div className="field">
          <label>Código de teste <span className="text-muted">(opcional)</span></label>
          <input
            className="input mono"
            value={testCode}
            onChange={(e) => setTestCode(e.target.value)}
            placeholder="TEST12345"
            disabled={!canEditMeta}
          />
          <p className="text-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
            Serve só para conferir se os avisos estão chegando: com ele
            preenchido, eles aparecem na aba <em>Testar eventos</em> do
            Gerenciador de Eventos. No dia a dia, deixe vazio.
          </p>
        </div>

        {/* ---------- Leitura dos anúncios ----------
            Mesma seção e mesmo botão de salvar: são credenciais da mesma
            integração, e dois formulários com dois "Salvar" na mesma tela
            só criam a dúvida de qual deles guarda o quê. */}
        <div className="settings-divider">
          <Megaphone size={14} /> Relatório de anúncios
        </div>
        <p className="text-muted" style={{ fontSize: 12, marginBottom: 16 }}>
          É o que preenche a aba <strong>Meta ADS</strong> dos relatórios: quanto
          cada campanha gastou e entregou. Sem isso, a aba mostra as vendas do
          CRM, mas não tem como calcular custo, ROAS nem CAC.
        </p>

        <AdAccountsSection canEdit={canEditMeta} />

        <div className="field">
          <label>
            Token para ler os anúncios <span className="text-muted">(opcional)</span>
            {settings.has_ads_token && (
              <span className="badge badge-green" style={{ marginLeft: 8 }}>Configurado</span>
            )}
          </label>
          {settings.has_ads_token && !editingAdsToken ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setEditingAdsToken(true)}
              disabled={!canEditMeta}
            >
              <KeyRound size={13} /> Atualizar token de leitura
            </button>
          ) : (
            <div className="flex" style={{ gap: 8 }}>
              <input
                className="input mono"
                type="password"
                value={adsToken}
                onChange={(e) => setAdsToken(e.target.value)}
                placeholder="EAAG…"
                disabled={!canEditMeta}
                autoComplete="new-password"
              />
              {settings.has_ads_token && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => { setEditingAdsToken(false); setAdsToken('') }}
                >
                  Cancelar
                </button>
              )}
            </div>
          )}
          <p className="text-muted" style={{ fontSize: 11.5, marginTop: 6 }}>
            Este só lê números, não envia nada. Na hora de gerar na Meta, marque
            a permissão de leitura de anúncios (<code>ads_read</code>). Ele vale
            para todas as contas que não tiverem um token próprio. Se deixar em
            branco, o sistema tenta usar o Access Token de cima, o que só
            funciona se aquele já tiver essa permissão. Os dois campos são
            separados de propósito: trocar o de cima só para arrumar o relatório
            derrubaria o aviso de vendas.
          </p>
        </div>

        {canEditMeta ? (
          <button className="btn btn-primary" onClick={saveSettings} disabled={savingSettings}>
            {savingSettings ? 'Salvando…' : 'Salvar configurações'}
          </button>
        ) : (
          <p className="text-muted" style={{ fontSize: 12 }}>
            Apenas administradores podem alterar estas configurações.
          </p>
        )}
      </section>
      )}

      {/* ---------- Chaves de API ---------- */}
    </div>
  )
}

/** Conta em edição. `id` ausente = linha nova ainda não salva. */
interface AdAccountDraft {
  id?: string
  accountId: string
  label: string
  token: string
}

/**
 * Lista de contas de anúncios da organização.
 *
 * Uma linha por conta porque o relatório soma as três (058). O token é por
 * conta e opcional: contas do mesmo Business Manager são alcançadas pelo
 * token da organização, e só quem tem conta em outro BM precisa preencher.
 *
 * O token nunca volta do servidor — a lista só sabe que existe um
 * (has_token). Campo em branco na edição mantém o que está salvo; para
 * voltar ao token da organização existe um botão próprio, senão não haveria
 * como dizer "apague" sem que branco significasse duas coisas.
 */
function AdAccountsSection({ canEdit }: { canEdit: boolean }) {
  const [accounts, setAccounts] = useState<CrmAdAccount[] | null>(null)
  const [draft, setDraft] = useState<AdAccountDraft | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    crmService.listAdAccounts()
      .then(setAccounts)
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : 'Falha ao carregar as contas de anúncios')
        setAccounts([])
      })
  }, [])

  useEffect(() => { load() }, [load])

  async function save() {
    if (!draft) return
    setSaving(true)
    try {
      await crmService.saveAdAccount({
        id: draft.id,
        accountId: draft.accountId,
        label: draft.label,
        // Em branco numa conta que já tem token = não mexer. Em branco numa
        // conta nova = usar o token da organização, que é o mesmo efeito de
        // gravar nulo.
        token: draft.token.trim() || undefined,
      })
      toast.success(draft.id ? 'Conta atualizada' : 'Conta adicionada')
      setDraft(null)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar a conta')
    } finally {
      setSaving(false)
    }
  }

  async function clearToken(account: CrmAdAccount) {
    const ok = await confirmDialog({
      title: 'Usar o token padrão',
      message: `A conta ${account.label ?? account.account_id} passa a ser lida com o `
        + 'token padrão, o que vale para todas. Se ele não tiver acesso a esta '
        + 'conta, o relatório para de trazer os números dela.',
      confirmLabel: 'Remover token próprio',
    })
    if (!ok) return
    try {
      await crmService.saveAdAccount({
        id: account.id,
        accountId: account.account_id,
        label: account.label ?? '',
        token: '',
      })
      toast.success('Token próprio removido')
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao remover o token')
    }
  }

  async function remove(account: CrmAdAccount) {
    const ok = await confirmDialog({
      title: 'Remover conta',
      message: `Remover ${account.label ?? account.account_id} do relatório? O `
        + 'gasto dela sai dos totais de Meta ADS. Na Meta nada muda, nada é '
        + 'apagado lá.',
      confirmLabel: 'Remover',
      danger: true,
    })
    if (!ok) return
    try {
      await crmService.deleteAdAccount(account.id)
      toast.success('Conta removida')
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao remover a conta')
    }
  }

  return (
    <div className="field">
      <label>Contas de anúncios</label>
      <p className="text-muted" style={{ fontSize: 11.5, marginBottom: 10 }}>
        Uma linha por conta. O relatório soma todas e também mostra cada uma
        separada. O número é o que aparece como <code>act_XXXXXXXX</code> no
        Gerenciador de Anúncios; pode colar com ou sem o <code>act_</code>. O
        apelido é só para você reconhecer a conta aqui.
      </p>

      {accounts === null ? (
        <Loader />
      ) : accounts.length === 0 && !draft ? (
        <p className="text-muted" style={{ fontSize: 12, marginBottom: 10 }}>
          Nenhuma conta cadastrada. A aba Meta ADS mostra as vendas, mas sem o
          gasto não dá para calcular custo, ROAS nem CAC.
        </p>
      ) : (
        <div className="ad-accounts">
          {accounts.map((a) => (
            draft?.id === a.id ? (
              <AdAccountForm
                key={a.id}
                draft={draft}
                setDraft={setDraft}
                onSave={save}
                onCancel={() => setDraft(null)}
                saving={saving}
                temToken={a.has_token}
              />
            ) : (
              <div className="ad-account-row" key={a.id}>
                <div className="ad-account-id">
                  <span className="ad-account-label">{a.label ?? a.account_id}</span>
                  {a.label && <span className="mono text-muted">{a.account_id}</span>}
                </div>
                {a.has_token && <span className="badge badge-green">token próprio</span>}
                {canEdit && (
                  <div className="ad-account-actions">
                    {a.has_token && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => clearToken(a)}
                        title="Voltar a usar o token de leitura da organização"
                      >
                        Usar token da org
                      </button>
                    )}
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setDraft({
                        id: a.id,
                        accountId: a.account_id,
                        label: a.label ?? '',
                        token: '',
                      })}
                    >
                      Editar
                    </button>
                    <button className="icon-btn" onClick={() => remove(a)} aria-label="Remover conta">
                      <Trash2 size={14} />
                    </button>
                  </div>
                )}
              </div>
            )
          ))}

          {draft && !draft.id && (
            <AdAccountForm
              draft={draft}
              setDraft={setDraft}
              onSave={save}
              onCancel={() => setDraft(null)}
              saving={saving}
              temToken={false}
            />
          )}
        </div>
      )}

      {canEdit && !draft && (
        <button
          className="btn btn-ghost btn-sm"
          style={{ marginTop: 10 }}
          onClick={() => setDraft({ accountId: '', label: '', token: '' })}
        >
          <Plus size={14} /> Adicionar conta
        </button>
      )}
    </div>
  )
}

/** Formulário de uma conta — o mesmo para nova e para edição. */
function AdAccountForm({ draft, setDraft, onSave, onCancel, saving, temToken }: {
  draft: AdAccountDraft
  setDraft: (d: AdAccountDraft) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  temToken: boolean
}) {
  return (
    <div className="ad-account-form">
      <div className="ad-account-form-fields">
        <input
          className="input"
          value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          placeholder="Apelido (ex.: Principal)"
          autoFocus
        />
        <input
          className="input mono"
          value={draft.accountId}
          onChange={(e) => setDraft({ ...draft, accountId: e.target.value })}
          placeholder="act_123456789012345"
        />
        <input
          className="input mono"
          type="password"
          value={draft.token}
          onChange={(e) => setDraft({ ...draft, token: e.target.value })}
          placeholder={temToken ? 'Token salvo. Deixe em branco para manter' : 'Token próprio (opcional)'}
          autoComplete="new-password"
        />
      </div>
      <div className="ad-account-actions">
        <button className="btn btn-primary btn-sm" onClick={onSave} disabled={saving}>
          {saving ? 'Salvando…' : 'Salvar'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  )
}

/**
 * Nome da organização — o que aparece ao lado da logo no cabeçalho. Só
 * admin (a aba nem existe para os outros; a RPC org_rename recusa de novo).
 */
function OrganizationSection() {
  const current = useAuthStore((s) => s.organizationName)
  const setOrganizationName = useAuthStore((s) => s.setOrganizationName)
  const [name, setName] = useState(current ?? '')
  const [saving, setSaving] = useState(false)

  useEffect(() => { setName(current ?? '') }, [current])

  const trimmed = name.trim()
  const valid = trimmed.length >= 2 && trimmed.length <= 60

  async function save() {
    if (!valid) return
    setSaving(true)
    try {
      const { data, error } = await supabase.rpc('org_rename', { p_name: trimmed })
      if (error) throw error
      setOrganizationName((data as string | null) ?? trimmed)
      toast.success('Nome da organização atualizado')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar o nome')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="card">
      <h3 className="card-title"><Building2 size={15} /> Organização</h3>
      <p className="text-muted" style={{ fontSize: 12, marginBottom: 16 }}>
        O nome aparece no topo do CRM, ao lado da logo, para todos os usuários da organização.
      </p>
      <form
        className="field"
        onSubmit={(e) => { e.preventDefault(); save() }}
        style={{ maxWidth: 420 }}
      >
        <label htmlFor="org-name">Nome</label>
        <div className="flex">
          <input
            id="org-name"
            className="input"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Infuse"
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || !valid || trimmed === (current ?? '')}
          >
            {saving ? <span className="spinner" /> : 'Salvar'}
          </button>
        </div>
      </form>
    </section>
  )
}

