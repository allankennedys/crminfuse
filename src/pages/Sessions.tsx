import { useCallback, useEffect, useState } from 'react'
import { Plus, QrCode, RefreshCw, Trash2, Smartphone, Unplug, AlertTriangle } from 'lucide-react'
import { sessionService } from '@/services/sessionService'
import { useAuthStore } from '@/store/authStore'
import { confirmDialog } from '@/store/confirmStore'
import { useRealtime } from '@/hooks/useRealtime'
import { Modal, Loader, EmptyState, StatusBadge } from '@/components/ui'
import type { WhatsAppSession } from '@/types'
import { formatDistanceToNow } from 'date-fns'
import { ptBR } from 'date-fns/locale'

export function SessionsPage() {
  const profile = useAuthStore((s) => s.profile)
  const [sessions, setSessions] = useState<WhatsAppSession[] | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [qrSession, setQrSession] = useState<WhatsAppSession | null>(null)
  const [qrCode, setQrCode] = useState<string | null>(null)
  const [instanceName, setInstanceName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [rowError, setRowError] = useState('')

  const refresh = useCallback(() => {
    sessionService.list().then(setSessions).catch(console.error)
  }, [])

  useEffect(refresh, [refresh])
  useRealtime('whatsapp_sessions', refresh)

  async function handleCreate() {
    if (!profile || !instanceName.trim()) return
    setBusy(true)
    setError('')
    try {
      const session = await sessionService.create(profile.organization_id, instanceName.trim().replace(/\s+/g, '-'))
      setShowCreate(false)
      setInstanceName('')
      refresh()
      openQR(session)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao criar sessão')
    } finally {
      setBusy(false)
    }
  }

  async function openQR(session: WhatsAppSession) {
    setQrSession(session)
    setQrCode(null)
    // Logo depois de um logout o socket ainda está reiniciando e o connect
    // volta sem base64. Uma segunda tentativa evita o spinner eterno.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const qr = await sessionService.getQRCode(session)
        if (qr.base64) {
          setQrCode(qr.base64)
          return
        }
      } catch {
        // segue para a próxima tentativa
      }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1500))
    }
    setQrCode(null)
  }

  async function handleRefreshStatus(session: WhatsAppSession) {
    await sessionService.refreshStatus(session)
    refresh()
  }

  async function handleReconnect(session: WhatsAppSession) {
    await sessionService.reconnect(session)
    refresh()
  }

  async function handleDisconnect(session: WhatsAppSession) {
    const ok = await confirmDialog({
      title: 'Desconectar número',
      message:
        `Encerrar a sessão de "${session.instance_name}"? O aparelho sai de "Aparelhos conectados" ` +
        'no celular e será preciso ler um novo QR Code com o MESMO número para voltar a enviar. ' +
        'Os grupos e as associações do número são preservados.',
      confirmLabel: 'Desconectar',
      danger: true,
    })
    if (!ok) return
    setRowError('')
    try {
      await sessionService.disconnect(session)
      refresh()
      openQR(session)
    } catch (err) {
      setRowError(err instanceof Error ? err.message : 'Falha ao desconectar')
    }
  }

  async function handleDelete(session: WhatsAppSession) {
    const ok = await confirmDialog({
      title: 'Remover número',
      message: `Remover "${session.instance_name}" do painel? O número continua conectado no WhatsApp e pode ser adicionado novamente depois.`,
      confirmLabel: 'Remover',
      danger: true,
    })
    if (!ok) return
    await sessionService.remove(session)
    refresh()
  }

  if (!sessions) return <Loader />

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Números WhatsApp</h1>
          <p>Conecte e gerencie os números que fazem os envios</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          <Plus /> Conectar número
        </button>
      </div>

      <div className="sessions-warn">
        <AlertTriangle />
        <div>
          <strong>Estas conexões são compartilhadas com outras automações</strong>
          <p>
            Desconectar um número aqui pode afetar o funcionamento dele em outros sistemas
            conectados.
          </p>
        </div>
      </div>

      {rowError && <p className="error-text">{rowError}</p>}

      {sessions.length === 0 ? (
        <div className="card">
          <EmptyState icon={<Smartphone />} text="Nenhum número conectado. Clique em “Conectar número” para gerar o QR Code." />
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Telefone</th>
                <th>Status</th>
                <th>Envios/min</th>
                <th>Última verificação</th>
                <th style={{ textAlign: 'right' }}>Ações</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="mono" style={{ color: 'var(--text)' }}>{s.instance_name}</td>
                  <td>{s.phone_number ?? '—'}</td>
                  <td><StatusBadge status={s.status} pulse={s.status === 'connected'} /></td>
                  <td>{s.rate_limit_per_min}/min</td>
                  <td>
                    {s.last_seen_at
                      ? formatDistanceToNow(new Date(s.last_seen_at), { addSuffix: true, locale: ptBR })
                      : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="flex" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn btn-ghost btn-sm" title="QR Code" onClick={() => openQR(s)}><QrCode /></button>
                      <button className="btn btn-ghost btn-sm" title="Verificar status" onClick={() => handleRefreshStatus(s)}><RefreshCw /></button>
                      <button className="btn btn-ghost btn-sm" title="Reconectar" onClick={() => handleReconnect(s)}>Reconectar</button>
                      <button
                        className="btn btn-ghost btn-sm"
                        title="Encerrar a sessão e gerar um novo QR Code"
                        onClick={() => handleDisconnect(s)}
                      >
                        <Unplug /> Desconectar
                      </button>
                      <button className="btn btn-danger btn-sm" title="Remover" onClick={() => handleDelete(s)}><Trash2 /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <Modal title="Conectar novo número" onClose={() => setShowCreate(false)}>
          <div className="field">
            <label>Nome de identificação</label>
            <input
              className="input"
              value={instanceName}
              onChange={(e) => setInstanceName(e.target.value)}
              placeholder="ex: comercial-01"
              autoFocus
            />
          </div>
          {error && <p className="error-text">{error}</p>}
          <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
            <button className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancelar</button>
            <button className="btn btn-primary" onClick={handleCreate} disabled={busy || !instanceName.trim()}>
              {busy ? <span className="spinner" /> : 'Criar e gerar QR'}
            </button>
          </div>
        </Modal>
      )}

      {qrSession && (
        <Modal title={`Conectar: ${qrSession.instance_name}`} onClose={() => setQrSession(null)}>
          {qrCode ? (
            <>
              <p className="text-secondary" style={{ fontSize: 13 }}>
                Abra o WhatsApp → Aparelhos conectados → Conectar aparelho e escaneie:
              </p>
              <div className="qr-box">
                <img src={qrCode} alt="QR Code de conexão" />
              </div>
            </>
          ) : (
            <Loader />
          )}
          <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn btn-ghost" onClick={() => openQR(qrSession)}><RefreshCw /> Gerar novo QR</button>
            <button
              className="btn btn-primary"
              onClick={async () => { await handleRefreshStatus(qrSession); setQrSession(null) }}
            >
              Já escaneei
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}
