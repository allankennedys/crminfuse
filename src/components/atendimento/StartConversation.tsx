import { useEffect, useState, type FormEvent } from 'react'
import { MessageCirclePlus, Search, UserPlus, UserRound } from 'lucide-react'
import { Loader, Modal } from '@/components/ui'
import { toast } from '@/store/toastStore'
import { atendimentoService, formatPhone } from '@/services/atendimentoService'
import type { ContatoParaConversa } from '@/store/conversaStore'

type Sessao = { id: string; instance_name: string; phone_number: string | null; status: string }

/** Número digitado com cara de telefone: 10+ dígitos (com ou sem 55). */
const pareceTelefone = (t: string) => t.replace(/\D/g, '').length >= 10

/**
 * Janela de "iniciar conversa" (126). Com contato já escolhido (lista de
 * contatos, cartão), só pede o número da empresa; sem, busca o contato ou
 * aceita um número digitado.
 */
export function StartConversation({ initialContact, onClose, onStarted }: {
  initialContact?: ContatoParaConversa
  onClose: () => void
  onStarted: (conversationId: string) => void
}) {
  const [sessoes, setSessoes] = useState<Sessao[] | null>(null)
  const [sessionId, setSessionId] = useState('')
  const [contato, setContato] = useState<ContatoParaConversa | null>(initialContact ?? null)
  const [termo, setTermo] = useState('')
  const [resultados, setResultados] = useState<ContatoParaConversa[] | null>(null)
  const [busy, setBusy] = useState(false)
  // Número que não é de nenhum contato: pede o nome e cria o contato ao iniciar.
  const [criando, setCriando] = useState(false)
  const [nome, setNome] = useState('')

  useEffect(() => {
    atendimentoService.startSessions()
      .then((list) => {
        setSessoes(list)
        if (list.length >= 1) setSessionId(list[0].id)
      })
      .catch(() => setSessoes([]))
  }, [])

  // Busca com pausa de digitação e mínimo de 2 letras.
  useEffect(() => {
    if (contato) return
    const t = termo.trim()
    if (t.length < 2) { setResultados(null); return }
    let vivo = true
    const timer = setTimeout(() => {
      atendimentoService.searchContacts(t)
        .then((r) => { if (vivo) setResultados(r) })
        .catch(() => { if (vivo) setResultados([]) })
    }, 300)
    return () => { vivo = false; clearTimeout(timer) }
  }, [termo, contato])

  const numeroDigitado = !contato && pareceTelefone(termo) ? termo.replace(/\D/g, '') : null
  // O número já é de um contato da lista? (compara pelos 8 últimos dígitos, que
  // ignoram o 55 e o 9 a mais.) Enquanto a busca não voltou, não sugere nada.
  const jaExiste = numeroDigitado !== null && (resultados ?? []).some(
    (r) => (r.phone ?? '').replace(/\D/g, '').endsWith(numeroDigitado.slice(-8)),
  )
  const sugerirCriar = numeroDigitado !== null && resultados !== null && !jaExiste

  const iniciar = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!sessionId || (!contato && !numeroDigitado)) return
    // Enter na busca com um número novo: leva ao passo de criar o contato.
    if (!contato && !criando) {
      if (sugerirCriar) { setCriando(true); setNome('') }
      return
    }
    setBusy(true)
    try {
      const id = await atendimentoService.startConversation({
        sessionId,
        contactId: contato?.id,
        phone: contato ? undefined : numeroDigitado ?? undefined,
        name: !contato && nome.trim() ? nome.trim() : undefined,
      })
      onStarted(id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível iniciar a conversa')
      setBusy(false)
    }
  }

  const sessaoLabel = (s: Sessao) => (s.phone_number ? formatPhone(s.phone_number) : s.instance_name)

  return (
    <Modal title="Nova conversa" onClose={onClose} variant="dialog">
      {sessoes === null ? <Loader /> : sessoes.length === 0 ? (
        <p className="text-secondary">
          Nenhum número de WhatsApp está ligado ao atendimento. Um administrador liga em
          Atendimento → Números.
        </p>
      ) : (
        <form onSubmit={iniciar}>
          {contato ? (
            <div className="sc-escolhido">
              <UserRound size={18} />
              <div>
                <strong>{contato.name}</strong>
                <span className="text-secondary">{contato.phone ? formatPhone(contato.phone) : 'sem telefone'}</span>
              </div>
              {!initialContact && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setContato(null)}>Trocar</button>
              )}
            </div>
          ) : criando && numeroDigitado ? (
            <div className="field">
              <label htmlFor="sc-novo-nome">Novo contato</label>
              <div className="sc-escolhido">
                <UserPlus size={18} />
                <div>
                  <strong>{formatPhone(numeroDigitado.length <= 11 ? `55${numeroDigitado}` : numeroDigitado)}</strong>
                  <span className="text-secondary">ainda não está nos seus contatos</span>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCriando(false)}>Trocar</button>
              </div>
              <input
                id="sc-novo-nome"
                className="input"
                style={{ marginTop: 8 }}
                value={nome}
                maxLength={100}
                onChange={(e) => setNome(e.target.value)}
                placeholder="Nome do contato (opcional)"
                autoFocus
              />
              <span className="text-muted" style={{ fontSize: 12 }}>
                O contato é criado ao iniciar a conversa. Sem nome, ele fica com o número até o cliente responder.
              </span>
            </div>
          ) : (
            <div className="field">
              <label htmlFor="sc-busca">Cliente</label>
              <label className="crm-search crm-search-block">
                <input
                  id="sc-busca"
                  value={termo}
                  onChange={(e) => setTermo(e.target.value)}
                  placeholder="Nome ou telefone do cliente, ou um número novo"
                  autoFocus
                />
                <Search size={14} />
              </label>
              <div className="sc-resultados">
                {sugerirCriar && (
                  <button type="button" className="sc-item" onClick={() => { setCriando(true); setNome('') }}>
                    <UserPlus size={15} />
                    <span>
                      Criar contato com <strong>{formatPhone(numeroDigitado.length <= 11 ? `55${numeroDigitado}` : numeroDigitado)}</strong> e iniciar conversa
                    </span>
                  </button>
                )}
                {resultados?.map((r) => (
                  <button
                    type="button"
                    key={r.id}
                    className="sc-item"
                    onClick={() => setContato(r)}
                    disabled={!r.phone}
                  >
                    <UserRound size={15} />
                    <span>
                      <strong>{r.name}</strong>
                      <span className="text-secondary"> · {r.phone ? formatPhone(r.phone) : 'sem telefone'}</span>
                    </span>
                  </button>
                ))}
                {resultados && resultados.length === 0 && !numeroDigitado && (
                  <p className="text-muted" style={{ fontSize: 12.5 }}>
                    Nenhum contato encontrado. Digite o número completo, com DDD, para conversar com alguém novo.
                  </p>
                )}
              </div>
            </div>
          )}

          {sessoes.length > 1 && (
            <div className="field">
              <label htmlFor="sc-numero">Enviar pelo número</label>
              <select id="sc-numero" className="input" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
                {sessoes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {sessaoLabel(s)}{s.status !== 'connected' ? ' (desconectado)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancelar</button>
            <button type="submit" className="btn btn-primary" disabled={busy || !sessionId || (!contato && !(criando && numeroDigitado))}>
              {busy ? <span className="spinner" /> : <><MessageCirclePlus size={15} /> Iniciar conversa</>}
            </button>
          </div>
        </form>
      )}
    </Modal>
  )
}
