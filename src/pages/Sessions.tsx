import { useCallback, useEffect, useState } from 'react'
import { Plus, QrCode, RefreshCw, Trash2, Smartphone, Unplug } from 'lucide-react'
import { sessionService } from '@/services/sessionService'
import { useAuthStore } from '@/store/authStore'
import { confirmDialog } from '@/store/confirmStore'
import { useRealtime } from '@/hooks/useRealtime'
import { Modal, Loader, EmptyState, StatusBadge, sessionLabel } from '@/components/ui'
import type { WhatsAppSession } from '@/types'
import { formatDistanceToNow } from 'date-fns'
import { ptBR } from 'date-fns/locale'

export function SessionsPage() {
  const profile = useAuthStore((s) => s.profile)
  const [sessions, setSessions] = useState<WhatsAppSession[] | null>(null)
  const [qrSession, setQrSession] = useState<WhatsAppSession | null>(null)
  const [qrCode, setQrCode] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [rowError, setRowError] = useState('')

  const refresh = useCallback(() => {
    sessionService.list().then(setSessions).catch(console.error)
  }, [])

  useEffect(refresh, [refresh])
  useRealtime('whatsapp_sessions', refresh)

  // Sem nome a escolher: o servidor gera o nome da instância (117) e o
  // número passa a ser identificado pelo telefone depois do QR.
  async function handleCreate() {
    if (!profile) return
    setBusy(true)
    setError('')
    try {
      const { session, qrBase64 } = await sessionService.create()
      refresh()
      if (qrBase64) {
        setQrSession(session)
        setQrCode(qrBase64)
      } else {
        openQR(session)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao criar o número')
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
        `Encerrar a sessão de ${sessionLabel(session)}? O aparelho sai de "Aparelhos conectados" ` +
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
      message: `Remover ${sessionLabel(session)}? O aparelho é desconectado do WhatsApp e a conexão é apagada. Para usar o número de novo, conecte-o outra vez pelo QR Code.`,
      confirmLabel: 'Remover',
      danger: true,
    })
    if (!ok) return
    setRowError('')
    try {
      await sessionService.remove(session)
      refresh()
    } catch (err) {
      setRowError(err instanceof Error ? err.message : 'Falha ao remover')
    }
  }

  if (!sessions) return <Loader />

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Números WhatsApp</h1>
          <p>Conecte e gerencie os números que fazem os envios</p>
        </div>
        <button className="btn btn-primary" onClick={handleCreate} disabled={busy}>
          {busy ? <span className="spinner" /> : <Plus />} Conectar número
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}
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
                <th>Número</th>
                <th>Status</th>
                <th>Envios/min</th>
                <th>Última verificação</th>
                <th style={{ textAlign: 'right' }}>Ações</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div style={{ color: 'var(--text)', fontWeight: 600 }}>
                      {s.phone_number ? sessionLabel(s) : 'Aguardando leitura do QR'}
                    </div>
                    <div className="mono text-muted" style={{ fontSize: 11.5 }}>{s.instance_name}</div>
                  </td>
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

      {qrSession && (
        <Modal title="Conectar número" onClose={() => setQrSession(null)}>
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
