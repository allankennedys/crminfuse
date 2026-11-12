import { useCallback, useEffect, useMemo, useState } from 'react'
import { UserPlus, Users, KeyRound, ShieldCheck, Trash2, UserCheck, UserX } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/store/authStore'
import { Modal, Loader, EmptyState } from '@/components/ui'
import { PermissionEditor } from './PermissionEditor'
import { mergePermissions, type PermissionSystem } from '@/lib/permissions'
import { toast } from '@/store/toastStore'
import type { UserProfile, UserRole } from '@/types'

const ROLE_LABEL: Record<UserRole, string> = {
  admin: 'Admin',
  operator: 'Operador',
  gestor: 'Gestor',
  sdr: 'SDR',
  atendente: 'Atendente',
}

/** Linha da visão global (todas as orgs) — retornada pela Edge Function admin-users. */
interface OrgUserRow {
  id: string
  username: string | null
  full_name: string | null
  email: string
  role: UserRole
  is_active: boolean
  created_at: string
  organization_id: string
  organizations: { name: string } | null
}

type DeletableUser = { id: string; username: string | null; full_name: string | null }

/** Extrai a mensagem amigável de um erro de supabase.functions.invoke. */
function fnErrorMessage(fnError: unknown): string {
  const e = fnError as { message?: string; context?: { body?: unknown } }
  let msg = e.message ?? 'Erro inesperado'
  try {
    const b = e.context?.body
    const parsed = typeof b === 'string' ? JSON.parse(b) : b
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      msg = String((parsed as { error: unknown }).error)
    }
  } catch { /* mantém msg padrão */ }
  return msg
}

/**
 * Gestão de usuários e permissões da organização (criar acessos, ativar/desativar
 * e excluir). Componente reutilizável: é a tela de Configurações do painel e
 * também aparece na aba Configurações do CRM (só para admins — nunca crm_only).
 */
export function UserAccess({ crm = false }: { crm?: boolean } = {}) {
  const profile = useAuthStore((s) => s.profile)
  const isAdmin = profile?.role === 'admin'
  // De onde o componente foi montado, não de qual build está no ar: é o
  // mesmo componente nos dois sistemas, e APP_MODE não distingue o CRM
  // aberto em /crm pelo domínio da gestão.
  const sistema: PermissionSystem = crm ? 'crm' : 'painel'
  // "Dono da plataforma" é resolvido no servidor (whoami) — sem email no cliente.
  const [owner, setOwner] = useState(false)
  const [users, setUsers] = useState<UserProfile[] | null>(null)
  const [showInvite, setShowInvite] = useState(false)
  const [inviteUsername, setInviteUsername] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [invitePassword, setInvitePassword] = useState('')
  const [inviteRole, setInviteRole] = useState<UserRole>('operator')
  const [inviteNewOrg, setInviteNewOrg] = useState(false)
  const [inviteOrgName, setInviteOrgName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Permissões escolhidas JÁ NA CRIAÇÃO. Sem isto o usuário nascia com o
  // preset do cargo e só depois era possível apertá-lo — uma janela em que
  // ele já podia entrar e ver o que não era para ver.
  const [invitePermCustom, setInvitePermCustom] = useState(false)
  // Preset do cargo escolhido, lido do banco (055). Serve para dois papéis:
  // pré-marcar as caixas e, no salvamento, preservar o que é do outro sistema.
  const [invitePermBase, setInvitePermBase] = useState<string[]>([])
  const [invitePermSelected, setInvitePermSelected] = useState<Set<string>>(new Set())
  // Enquanto o preset não chega, o editor fica travado: marcar algo agora
  // seria perdido quando a resposta sobrescrevesse a seleção.
  const [invitePermLoading, setInvitePermLoading] = useState(false)
  const [invitePermError, setInvitePermError] = useState('')

  const [allUsers, setAllUsers] = useState<OrgUserRow[] | null>(null)

  // Exclusão com dupla confirmação (digitar o usuário + botão).
  const [deleteTarget, setDeleteTarget] = useState<DeletableUser | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  // Trocar a própria senha (qualquer usuário logado).
  const [showOwnPw, setShowOwnPw] = useState(false)
  const [ownPw, setOwnPw] = useState('')
  const [ownPw2, setOwnPw2] = useState('')
  const [ownPwBusy, setOwnPwBusy] = useState(false)
  const [ownPwError, setOwnPwError] = useState('')

  // Permissões personalizadas de um usuário. `permBase` guarda a lista
  // EFETIVA que ele tinha ao abrir o modal — é dela que saem as permissões
  // do OUTRO sistema na hora de salvar (ver handleSavePerms).
  const [permTarget, setPermTarget] = useState<UserProfile | null>(null)
  const [permCustom, setPermCustom] = useState(false)
  const [permSelected, setPermSelected] = useState<Set<string>>(new Set())
  const [permBase, setPermBase] = useState<string[]>([])
  // Preset do cargo do usuário aberto — o que "Voltar ao preset" restaura.
  const [permPreset, setPermPreset] = useState<string[]>([])
  const [permBusy, setPermBusy] = useState(false)
  const [permError, setPermError] = useState('')

  // Admin define/reseta a senha de outro usuário (não existe "ver senha":
  // o Supabase só guarda o hash; o controle é redefinir e repassar).
  const [pwTarget, setPwTarget] = useState<DeletableUser | null>(null)
  const [pwValue, setPwValue] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwError, setPwError] = useState('')

  // Quem só usa o Tarefas não é usuário do CRM e não entra nesta lista. Quem
  // são é o módulo de lá que diz (task_fora_do_crm, t36). Se a função falhar
  // ou ainda não existir no banco, a lista sai inteira, como sempre saiu.
  const refresh = useCallback(() => {
    Promise.all([
      supabase.from('users').select('*').order('created_at').returns<UserProfile[]>(),
      supabase.rpc('task_fora_do_crm'),
    ]).then(([{ data }, fora]) => {
      const ocultar = new Set<string>(Array.isArray(fora.data) ? fora.data : [])
      setUsers((data ?? []).filter((u) => !ocultar.has(u.id)))
    })
  }, [])

  // Só o dono vê a lista global (todas as organizações), via Edge Function.
  const refreshGlobal = useCallback(() => {
    if (!owner) return
    supabase.functions.invoke('admin-users', { body: { action: 'list' } })
      .then(({ data }) => { if (Array.isArray(data?.users)) setAllUsers(data.users as OrgUserRow[]) })
      .catch(console.error)
  }, [owner])

  // Descobre no servidor se o usuário logado é o dono da plataforma.
  useEffect(() => {
    if (!isAdmin) { setOwner(false); return }
    supabase.functions.invoke('admin-users', { body: { action: 'whoami' } })
      .then(({ data }) => setOwner(data?.is_owner === true))
      .catch(() => setOwner(false))
  }, [isAdmin, profile?.id])

  useEffect(refresh, [refresh])
  useEffect(refreshGlobal, [refreshGlobal])

  /**
   * Preset do cargo escolhido no formulário de criação, vindo do banco.
   *
   * Recarrega quando o cargo muda — inclusive descartando marcações feitas
   * antes: elas foram pensadas em cima de OUTRO preset, e mantê-las deixaria
   * a tela mostrando um "personalizado" que não corresponde a nada que o
   * admin tenha escolhido conscientemente. O texto ao lado avisa.
   */
  useEffect(() => {
    if (!showInvite || inviteNewOrg || inviteRole === 'admin') return
    let alive = true
    setInvitePermLoading(true)
    setInvitePermError('')
    // Sem preset não dá para personalizar: as caixas viriam todas vazias e
    // marcar "personalizado" a partir daí criaria um usuário sem acesso
    // nenhum sem que ninguém tenha pedido isso. A criação segue normal — o
    // usuário nasce no preset do cargo, como sempre foi.
    function falhou() {
      setInvitePermCustom(false)
      setInvitePermBase([])
      setInvitePermSelected(new Set())
      setInvitePermError('Não foi possível carregar as permissões do cargo. O usuário será criado com o preset padrão e você pode ajustá-lo depois.')
    }

    void (async () => {
      try {
        const { data, error: presetErr } = await supabase.rpc('permissions_preset', { p_role: inviteRole })
        if (!alive) return
        if (presetErr) { falhou(); return }
        const preset = (data as string[] | null) ?? []
        setInvitePermBase(preset)
        setInvitePermSelected(new Set(preset))
      } catch {
        // Rede fora do ar rejeita de verdade. Sem tratar, o editor ficaria
        // travado em "carregando" para sempre.
        if (alive) falhou()
      } finally {
        if (alive) setInvitePermLoading(false)
      }
    })()
    return () => { alive = false }
  }, [showInvite, inviteRole, inviteNewOrg])

  // Agrupa a visão global por organização, preservando a ordem de criação.
  const orgGroups = useMemo(() => {
    const map = new Map<string, { id: string; name: string; users: OrgUserRow[] }>()
    for (const u of allUsers ?? []) {
      if (!map.has(u.organization_id)) {
        map.set(u.organization_id, { id: u.organization_id, name: u.organizations?.name ?? 'Sem organização', users: [] })
      }
      map.get(u.organization_id)!.users.push(u)
    }
    return Array.from(map.values())
  }, [allUsers])

  /**
   * Abre o editor com a lista EFETIVA do usuário: a personalizada, se
   * existir, ou o preset do cargo — que vem do banco (055), não de uma cópia
   * no bundle. Sem o preset carregado, as caixas começariam todas desmarcadas
   * e tirar acesso de alguém seria acidental.
   *
   * O preset é lido SEMPRE, mesmo para quem já é personalizado: é ele que o
   * botão "Voltar ao preset" restaura, e a lista efetiva de um usuário
   * personalizado não diz nada sobre o que o cargo dá.
   */
  async function openPermissions(user: UserProfile) {
    setPermError('')
    setPermTarget(user)
    setPermBusy(true)
    try {
      const { data, error } = await supabase.rpc('permissions_preset', { p_role: user.role })
      if (error) throw error
      const preset = (data as string[] | null) ?? []
      const efetivas = user.permissions ?? preset
      setPermPreset(preset)
      setPermBase(efetivas)
      setPermSelected(new Set(efetivas))
      setPermCustom(user.permissions !== null)
    } catch (err) {
      setPermError(err instanceof Error ? err.message : 'Falha ao carregar as permissões')
    } finally {
      setPermBusy(false)
    }
  }

  /**
   * Salva preservando o que é do OUTRO sistema.
   *
   * A tela mostra só as permissões do sistema em que este build roda, mas o
   * banco guarda UMA lista por usuário. Salvar apenas o que está marcado aqui
   * apagaria, do CRM, todo o acesso que a pessoa tem no painel — e sem aviso
   * nenhum, porque a tela nunca mostrou aquelas caixas.
   */
  async function handleSavePerms() {
    if (!permTarget) return
    setPermBusy(true)
    setPermError('')
    try {
      // null devolve o usuário ao preset do cargo; a lista preserva o que
      // é do outro sistema (mergePermissions explica por quê).
      const payload = permCustom
        ? mergePermissions(permBase, permSelected, sistema)
        : null
      const { error } = await supabase.rpc('user_permissions_save', {
        p_user: permTarget.id,
        p_permissions: payload,
      })
      if (error) throw error
      toast.success(permCustom ? 'Permissões salvas' : 'Usuário voltou ao preset do cargo')
      setPermTarget(null)
      refresh()
    } catch (err) {
      setPermError(err instanceof Error ? err.message : 'Falha ao salvar')
    } finally {
      setPermBusy(false)
    }
  }

  async function handleToggleActive(user: UserProfile) {
    await supabase.from('users').update({ is_active: !user.is_active }).eq('id', user.id)
    refresh()
  }

  async function handleChangeRole(user: UserProfile, role: UserRole) {
    await supabase.from('users').update({ role }).eq('id', user.id)
    refresh()
  }

  function openDelete(user: DeletableUser) {
    setDeleteTarget(user)
    setDeleteConfirm('')
    setDeleteError('')
  }

  // Palavra que o admin precisa digitar para confirmar a exclusão.
  const deleteWord = deleteTarget?.username?.trim() || 'EXCLUIR'
  const deleteReady = deleteConfirm.trim().toLowerCase() === deleteWord.toLowerCase()

  async function handleDelete() {
    if (!deleteTarget || !deleteReady) return
    setDeleteBusy(true)
    setDeleteError('')
    try {
      const { data, error: fnError } = await supabase.functions.invoke('admin-users', {
        body: { action: 'delete', user_id: deleteTarget.id },
      })
      if (fnError) throw new Error(fnErrorMessage(fnError))
      if (data?.error) throw new Error(String(data.error))
      setDeleteTarget(null)
      setDeleteConfirm('')
      refresh()
      refreshGlobal()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Falha ao excluir usuário')
    } finally {
      setDeleteBusy(false)
    }
  }

  /** Troca a senha da própria conta (client-side; afeta só quem está logado). */
  async function handleChangeOwnPassword() {
    if (ownPw.length < 6) { setOwnPwError('A senha precisa ter ao menos 6 caracteres.'); return }
    if (ownPw !== ownPw2) { setOwnPwError('As senhas não conferem.'); return }
    setOwnPwBusy(true)
    setOwnPwError('')
    try {
      const { error } = await supabase.auth.updateUser({ password: ownPw })
      if (error) throw error
      setShowOwnPw(false)
      setOwnPw('')
      setOwnPw2('')
      toast.success('Senha alterada.')
    } catch (err) {
      setOwnPwError(err instanceof Error ? err.message : 'Falha ao alterar a senha')
    } finally {
      setOwnPwBusy(false)
    }
  }

  function openSetPassword(user: DeletableUser) {
    setPwTarget(user)
    setPwValue('')
    setPwError('')
  }

  /** Admin define uma nova senha para outro usuário e a repassa a ele. */
  async function handleSetPassword() {
    if (!pwTarget || pwValue.length < 6) return
    setPwBusy(true)
    setPwError('')
    try {
      const { data, error: fnError } = await supabase.functions.invoke('admin-users', {
        body: { action: 'set_password', user_id: pwTarget.id, password: pwValue },
      })
      if (fnError) throw new Error(fnErrorMessage(fnError))
      if (data?.error) throw new Error(String(data.error))
      setPwTarget(null)
      setPwValue('')
      toast.success('Senha definida. Repasse-a ao usuário.')
    } catch (err) {
      setPwError(err instanceof Error ? err.message : 'Falha ao definir a senha')
    } finally {
      setPwBusy(false)
    }
  }

  /**
   * Cria usuário por username. A criação roda no servidor (Edge Function
   * admin-users, com service_role): assim a sessão do admin permanece
   * intacta — usar supabase.auth.signUp() aqui logaria o admin na conta nova.
   */
  async function handleInvite() {
    const username = inviteUsername.trim().toLowerCase()
    if (!profile || !username || invitePassword.length < 6) return
    if (!/^[a-z0-9._-]+$/.test(username)) {
      setError('Usuário só pode ter letras, números, ponto, hífen ou underline.')
      return
    }
    const newOrg = owner && inviteNewOrg
    // Admin tem acesso total por definição e a RPC recusa personalizá-lo (055).
    const personalizar = invitePermCustom && !newOrg && inviteRole !== 'admin'
    setBusy(true)
    setError('')
    try {
      const { data, error: fnError } = await supabase.functions.invoke('admin-users', {
        body: {
          username,
          password: invitePassword,
          full_name: inviteName.trim() || null,
          role: newOrg ? 'admin' : inviteRole,
          new_organization: newOrg,
          organization_name: newOrg ? inviteOrgName.trim() || null : null,
        },
      })
      if (fnError) throw new Error(fnErrorMessage(fnError))
      if (data?.error) throw new Error(String(data.error))

      /**
       * Permissões logo após a criação, em duas etapas: a conta é criada com
       * service_role na Edge Function e a lista é gravada pela RPC, que é
       * quem valida "admin da mesma organização" (055).
       *
       * Se a segunda etapa falhar, o usuário EXISTE — com o preset do cargo.
       * Por isso o erro aqui não é tratado como falha da criação: some com o
       * usuário criado da tela seria pior do que dizer o que faltou fazer.
       */
      if (personalizar) {
        // Sem id não há em quem gravar. Cai no mesmo aviso da falha da RPC —
        // o silêncio aqui deixaria um usuário com mais acesso do que o
        // escolhido, achando que a tela tinha aplicado.
        const { error: permErr } = data?.id
          ? await supabase.rpc('user_permissions_save', {
            p_user: String(data.id),
            p_permissions: mergePermissions(invitePermBase, invitePermSelected, sistema),
          })
          : { error: new Error('id do usuário não veio na resposta') }
        if (permErr) {
          toast.error(
            'Usuário criado, mas as permissões personalizadas não foram salvas — '
            + 'ele está com o preset do cargo. Ajuste pelo ícone de permissões.',
          )
        } else {
          toast.success('Usuário criado com permissões personalizadas')
        }
      } else {
        toast.success('Usuário criado')
      }

      setShowInvite(false)
      setInviteUsername('')
      setInviteName('')
      setInvitePassword('')
      setInviteNewOrg(false)
      setInviteOrgName('')
      setInvitePermCustom(false)
      refresh()
      refreshGlobal()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao criar usuário')
    } finally {
      setBusy(false)
    }
  }

  if (!users) return <Loader />

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Configurações</h1>
          <p>Usuários e permissões da organização</p>
        </div>
        <div className="flex" style={{ gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => { setOwnPwError(''); setOwnPw(''); setOwnPw2(''); setShowOwnPw(true) }}>
            <KeyRound /> Trocar minha senha
          </button>
          {isAdmin && (
            <button className="btn btn-primary" onClick={() => { setError(''); setInviteNewOrg(false); setInviteOrgName(''); setInvitePermCustom(false); setShowInvite(true) }}>
              <UserPlus /> Novo usuário
            </button>
          )}
        </div>
      </div>

      {users.length === 0 ? (
        <div className="card">
          <EmptyState icon={<Users />} text="Nenhum usuário encontrado." />
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Usuário</th>
                <th>Role</th>
                <th>Status</th>
                {isAdmin && <th style={{ textAlign: 'right' }}>Ações</th>}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="cell-trunc" style={{ color: 'var(--text)', fontWeight: 500 }}>
                    {u.full_name ?? '—'}
                  </td>
                  <td className="cell-trunc">{u.username ?? '—'}</td>
                  <td>
                    {isAdmin && u.id !== profile?.id ? (
                      <select
                        className="input"
                        style={{ width: 'auto', padding: '5px 10px', fontSize: 12.5 }}
                        value={u.role}
                        onChange={(e) => handleChangeRole(u, e.target.value as UserRole)}
                      >
                        {(Object.keys(ROLE_LABEL) as UserRole[]).filter((r) => r !== 'gestor').map((r) => (
                          <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="badge badge-gray">{ROLE_LABEL[u.role]}</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${u.is_active ? 'badge-green' : 'badge-red'}`}>
                      {u.is_active ? 'Ativo' : 'Desativado'}
                    </span>
                  </td>
                  {isAdmin && (
                    <td style={{ textAlign: 'right' }}>
                      {/* Ícones, não quatro botões de texto: com rótulos a
                          célula passava de 400px e empurrava a tabela para
                          fora do card. O title/aria-label carrega o nome. */}
                      {u.id !== profile?.id && (
                        <span className="row-actions">
                          <button
                            className="icon-btn"
                            onClick={() => handleToggleActive(u)}
                            title={u.is_active ? 'Desativar usuário' : 'Ativar usuário'}
                            aria-label={u.is_active ? 'Desativar usuário' : 'Ativar usuário'}
                          >
                            {u.is_active ? <UserX size={15} /> : <UserCheck size={15} />}
                          </button>
                          <button
                            className="icon-btn"
                            onClick={() => openSetPassword(u)}
                            title="Definir senha"
                            aria-label="Definir senha"
                          >
                            <KeyRound size={15} />
                          </button>
                          {/* Admin não aparece: ele tem acesso total por
                              definição e a RPC recusa personalizar (055). */}
                          {u.role !== 'admin' && (
                            <button
                              className="icon-btn"
                              onClick={() => openPermissions(u)}
                              title="Permissões"
                              aria-label="Permissões"
                            >
                              <ShieldCheck size={15} />
                            </button>
                          )}
                          <button
                            className="icon-btn icon-btn-danger"
                            onClick={() => openDelete(u)}
                            title="Excluir usuário"
                            aria-label="Excluir usuário"
                          >
                            <Trash2 size={15} />
                          </button>
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {owner && allUsers && (
        <div style={{ marginTop: 36 }}>
          <div className="page-header" style={{ marginBottom: 16 }}>
            <div>
              <h1 style={{ fontSize: 18 }}>Todas as organizações</h1>
              <p>{orgGroups.length} organização(ões) · {allUsers.length} usuário(s) no total</p>
            </div>
          </div>

          {orgGroups.map((g) => (
            <div className="card mb-16" key={g.id}>
              <div className="flex-between" style={{ marginBottom: 12 }}>
                <div className="card-title" style={{ marginBottom: 0, color: 'var(--text)', fontSize: 15 }}>{g.name}</div>
                <span className="badge badge-gray">{g.users.length} usuário(s)</span>
              </div>
              <div className="table-wrap" style={{ border: 'none', background: 'transparent' }}>
                <table>
                  <thead>
                    <tr><th>Nome</th><th>Usuário</th><th>Role</th><th>Status</th><th style={{ textAlign: 'right' }}>Ações</th></tr>
                  </thead>
                  <tbody>
                    {g.users.map((u) => (
                      <tr key={u.id}>
                        <td style={{ color: 'var(--text)', fontWeight: 500 }}>
                          {u.full_name ?? '—'}
                        </td>
                        <td>{u.username ?? '—'}</td>
                        <td><span className="badge badge-gray">{ROLE_LABEL[u.role]}</span></td>
                        <td>
                          <span className={`badge ${u.is_active ? 'badge-green' : 'badge-red'}`}>
                            {u.is_active ? 'Ativo' : 'Desativado'}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {u.id !== profile?.id && (
                            <span className="flex" style={{ gap: 8, justifyContent: 'flex-end' }}>
                              <button className="btn btn-sm btn-ghost" onClick={() => openSetPassword(u)}>
                                Senha
                              </button>
                              <button className="btn btn-sm btn-danger" onClick={() => openDelete(u)}>
                                Excluir
                              </button>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {showInvite && (
        <Modal title="Novo usuário" onClose={() => setShowInvite(false)}>
          <div className="field">
            <label>Usuário</label>
            <input className="input" type="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={inviteUsername} onChange={(e) => setInviteUsername(e.target.value)} placeholder="ex: joao.silva" autoFocus />
          </div>
          <div className="field">
            <label>Nome (opcional)</label>
            <input className="input" type="text" value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder="João Silva" />
          </div>
          <div className="field">
            <label>Senha inicial</label>
            <input className="input" type="password" value={invitePassword} onChange={(e) => setInvitePassword(e.target.value)} minLength={6} placeholder="Mínimo 6 caracteres" />
          </div>
          {owner && (
            <div className="field">
              <label
                className="flex"
                style={{ gap: 9, alignItems: 'center', cursor: 'pointer', color: 'var(--text)' }}
              >
                <input
                  type="checkbox"
                  checked={inviteNewOrg}
                  onChange={(e) => setInviteNewOrg(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: 'var(--primary)' }}
                />
                Criar como dono de uma nova organização
              </label>
              <p className="text-muted" style={{ fontSize: 12 }}>
                {inviteNewOrg
                  ? 'Vira admin de uma organização separada (novo cliente/tenant).'
                  : 'Desligado: entra na sua organização com a role escolhida.'}
              </p>
            </div>
          )}

          {inviteNewOrg ? (
            <div className="field">
              <label>Nome da organização</label>
              <input
                className="input"
                type="text"
                value={inviteOrgName}
                onChange={(e) => setInviteOrgName(e.target.value)}
                placeholder="ex: Cliente XPTO"
              />
            </div>
          ) : (
            <div className="field">
              <label>Role</label>
              <select className="input" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as UserRole)}>
                {(Object.keys(ROLE_LABEL) as UserRole[]).filter((r) => r !== 'gestor').map((r) => (
                  <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                ))}
              </select>
            </div>
          )}

          {/* Permissões já no cadastro: o usuário entra com o acesso certo em
              vez de nascer no preset e ser ajustado depois. Igual ao editor da
              lista — só as áreas deste sistema; o outro fica intacto. */}
          {!inviteNewOrg && (
            inviteRole === 'admin' ? (
              <p className="text-muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                Admin tem acesso total por definição — não aceita permissões personalizadas.
              </p>
            ) : invitePermError ? (
              <p className="text-muted" style={{ fontSize: 12.5, marginTop: 4 }}>{invitePermError}</p>
            ) : (
              <>
                <div className="perm-head" style={{ marginTop: 4 }}>
                  <div><strong>Permissões</strong></div>
                  <span className="text-muted">
                    {sistema === 'crm'
                      ? 'Permissões do CRM. As do painel de gestão são editadas lá.'
                      : 'Permissões do painel. As do CRM são editadas lá.'}
                  </span>
                </div>
                <PermissionEditor
                  sistema={sistema}
                  custom={invitePermCustom}
                  onCustomChange={setInvitePermCustom}
                  selected={invitePermSelected}
                  onSelectedChange={setInvitePermSelected}
                  disabled={busy || invitePermLoading}
                  presetLabel={ROLE_LABEL[inviteRole]}
                  // Aqui `invitePermBase` É o preset do cargo escolhido, então
                  // desfazer é só voltar a ele.
                  onResetPreset={() => {
                    setInvitePermSelected(new Set(invitePermBase))
                    setInvitePermCustom(false)
                  }}
                />
                {invitePermCustom && (
                  <p className="text-muted" style={{ fontSize: 12, marginTop: 8 }}>
                    Trocar o cargo acima recarrega as marcações a partir do preset dele.
                  </p>
                )}
              </>
            )
          )}

          {error && <p className="error-text">{error}</p>}
          <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
            <button className="btn btn-ghost" onClick={() => setShowInvite(false)}>Cancelar</button>
            <button className="btn btn-primary" onClick={handleInvite} disabled={busy || !inviteUsername.trim() || invitePassword.length < 6}>
              {busy ? <span className="spinner" /> : 'Criar usuário'}
            </button>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <Modal title="Excluir usuário" onClose={() => setDeleteTarget(null)}>
          <p style={{ marginBottom: 8 }}>
            Você está prestes a excluir{' '}
            <strong style={{ color: 'var(--text)' }}>
              {deleteTarget.full_name || deleteTarget.username || 'este usuário'}
            </strong>
            {deleteTarget.username && <span className="text-muted"> ({deleteTarget.username})</span>}.
          </p>
          <p className="text-muted" style={{ fontSize: 13, marginBottom: 16 }}>
            Esta ação é <strong style={{ color: 'var(--danger)' }}>permanente</strong> — a conta e o acesso são removidos e não podem ser recuperados.
          </p>
          <div className="field">
            <label>
              Digite <span className="mono" style={{ color: 'var(--text)' }}>{deleteWord}</span> para confirmar
            </label>
            <input
              className="input"
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder={deleteWord}
              autoFocus
            />
          </div>
          {deleteError && <p className="error-text">{deleteError}</p>}
          <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
            <button className="btn btn-ghost" onClick={() => setDeleteTarget(null)}>Cancelar</button>
            <button className="btn btn-danger" onClick={handleDelete} disabled={deleteBusy || !deleteReady}>
              {deleteBusy ? <span className="spinner" /> : 'Excluir definitivamente'}
            </button>
          </div>
        </Modal>
      )}

      {showOwnPw && (
        <Modal title="Trocar minha senha" onClose={() => setShowOwnPw(false)}>
          <div className="field">
            <label>Nova senha</label>
            <input
              className="input"
              type="password"
              value={ownPw}
              onChange={(e) => setOwnPw(e.target.value)}
              minLength={6}
              placeholder="Mínimo 6 caracteres"
              autoComplete="new-password"
              autoFocus
            />
          </div>
          <div className="field">
            <label>Confirmar nova senha</label>
            <input
              className="input"
              type="password"
              value={ownPw2}
              onChange={(e) => setOwnPw2(e.target.value)}
              minLength={6}
              autoComplete="new-password"
            />
          </div>
          {ownPwError && <p className="error-text">{ownPwError}</p>}
          <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
            <button className="btn btn-ghost" onClick={() => setShowOwnPw(false)}>Cancelar</button>
            <button className="btn btn-primary" onClick={handleChangeOwnPassword} disabled={ownPwBusy || ownPw.length < 6 || ownPw !== ownPw2}>
              {ownPwBusy ? <span className="spinner" /> : 'Salvar senha'}
            </button>
          </div>
        </Modal>
      )}

      {pwTarget && (
        <Modal title="Definir senha" onClose={() => setPwTarget(null)}>
          <p style={{ marginBottom: 8 }}>
            Definir uma nova senha para{' '}
            <strong style={{ color: 'var(--text)' }}>
              {pwTarget.full_name || pwTarget.username || 'este usuário'}
            </strong>
            {pwTarget.username && <span className="text-muted"> ({pwTarget.username})</span>}.
          </p>
          <p className="text-muted" style={{ fontSize: 13, marginBottom: 16 }}>
            A senha atual não pode ser vista nem recuperada — esta ação a <strong style={{ color: 'var(--text)' }}>substitui</strong>.
            Anote e repasse ao usuário; ele pode trocá-la depois em "Trocar minha senha".
          </p>
          <div className="field">
            <label>Nova senha</label>
            {/* type=text de propósito: é uma senha NOVA que o admin precisa ler
                para repassar — não a senha atual de ninguém (essa nem existe em texto). */}
            <input
              className="input mono"
              type="text"
              value={pwValue}
              onChange={(e) => setPwValue(e.target.value)}
              minLength={6}
              placeholder="Mínimo 6 caracteres"
              autoComplete="off"
              autoFocus
            />
          </div>
          {pwError && <p className="error-text">{pwError}</p>}
          <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
            <button className="btn btn-ghost" onClick={() => setPwTarget(null)}>Cancelar</button>
            <button className="btn btn-primary" onClick={handleSetPassword} disabled={pwBusy || pwValue.length < 6}>
              {pwBusy ? <span className="spinner" /> : 'Definir senha'}
            </button>
          </div>
        </Modal>
      )}

      {/* ---------- Permissões personalizadas ----------
          Só as áreas do sistema em que a tela foi aberta (`sistema`): no CRM
          não faz sentido marcar acesso a Grupos. O que é do outro sistema é
          preservado no salvamento — ver mergePermissions. */}
      {permTarget && (
        <Modal title="Permissões" onClose={() => setPermTarget(null)}>
          <div className="perm-head">
            <div>
              <strong>{permTarget.full_name || permTarget.username || 'Usuário'}</strong>
              <span className="badge badge-gray">{ROLE_LABEL[permTarget.role]}</span>
            </div>
            <span className="text-muted">
              {sistema === 'crm'
                ? 'Permissões do CRM. As do painel de gestão são editadas lá e não mudam aqui.'
                : 'Permissões do painel. As do CRM são editadas lá e não mudam aqui.'}
            </span>
          </div>

          <PermissionEditor
            sistema={sistema}
            custom={permCustom}
            onCustomChange={setPermCustom}
            selected={permSelected}
            onSelectedChange={setPermSelected}
            disabled={permBusy}
            presetLabel={ROLE_LABEL[permTarget.role]}
            onResetPreset={() => {
              setPermSelected(new Set(permPreset))
              setPermCustom(false)
            }}
          />

          {permError && <p className="error-text">{permError}</p>}
          <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
            <button className="btn btn-ghost" onClick={() => setPermTarget(null)}>Cancelar</button>
            <button className="btn btn-primary" onClick={handleSavePerms} disabled={permBusy}>
              {permBusy ? <span className="spinner" /> : 'Salvar permissões'}
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}
