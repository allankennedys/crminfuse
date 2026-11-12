import { useCallback, useEffect, useState } from 'react'
import { ScrollText } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { groupService } from '@/services/groupService'
import { useRealtime } from '@/hooks/useRealtime'
import { Loader, EmptyState, StatusBadge } from '@/components/ui'
import type { Group, MessageLog, LogStatus } from '@/types'
import { formatSP } from '@/lib/datetime'

interface LogRow extends MessageLog {
  groups: Pick<Group, 'name'> | null
}

const MEDIA_LABEL: Record<string, string> = {
  text: 'Texto', image: 'Imagem', audio: 'Áudio', video: 'Vídeo', document: 'Documento',
}

export function LogsPage() {
  const [logs, setLogs] = useState<LogRow[] | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [filterGroup, setFilterGroup] = useState('')
  const [filterStatus, setFilterStatus] = useState<LogStatus | ''>('')
  const [filterFrom, setFilterFrom] = useState('')
  const [filterTo, setFilterTo] = useState('')

  const refresh = useCallback(() => {
    let query = supabase
      .from('message_logs')
      .select('*, groups(name)')
      .order('created_at', { ascending: false })
      .limit(200)

    if (filterGroup) query = query.eq('group_id', filterGroup)
    if (filterStatus) query = query.eq('status', filterStatus)
    if (filterFrom) query = query.gte('created_at', new Date(filterFrom).toISOString())
    if (filterTo) query = query.lte('created_at', new Date(`${filterTo}T23:59:59`).toISOString())

    query.returns<LogRow[]>().then(({ data }) => setLogs(data ?? []))
  }, [filterGroup, filterStatus, filterFrom, filterTo])

  useEffect(() => {
    refresh()
    groupService.list().then(setGroups)
  }, [refresh])

  useRealtime('message_logs', refresh)

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Histórico de envios</h1>
          <p>Acompanhe todos os envios realizados</p>
        </div>
      </div>

      <div className="card mb-16">
        <div className="flex" style={{ flexWrap: 'wrap', gap: 12 }}>
          <select className="input" style={{ width: 'auto', minWidth: 160 }} value={filterGroup} onChange={(e) => setFilterGroup(e.target.value)}>
            <option value="">Todos os grupos</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <select className="input" style={{ width: 'auto', minWidth: 140 }} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as LogStatus | '')}>
            <option value="">Todos os status</option>
            <option value="sent">Enviado</option>
            <option value="failed">Falhou</option>
            <option value="queued">Na fila</option>
            <option value="retrying">Retry</option>
          </select>
          <input className="input" style={{ width: 'auto' }} type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} />
          <span className="text-muted">até</span>
          <input className="input" style={{ width: 'auto' }} type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} />
        </div>
      </div>

      {!logs ? (
        <Loader />
      ) : logs.length === 0 ? (
        <div className="card">
          <EmptyState icon={<ScrollText />} text="Nenhum log encontrado para os filtros selecionados." />
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Data/hora</th>
                <th>Grupo</th>
                <th>Tipo</th>
                <th>Status</th>
                <th>Detalhe</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                    {formatSP(log.created_at, { withSeconds: true })}
                  </td>
                  <td>{log.groups?.name ?? '—'}</td>
                  <td>{MEDIA_LABEL[log.media_type] ?? log.media_type}</td>
                  <td><StatusBadge status={log.status} /></td>
                  <td className="mono" style={{ fontSize: 11.5, maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {log.detail ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
