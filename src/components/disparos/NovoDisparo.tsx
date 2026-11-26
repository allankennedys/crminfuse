import { useEffect, useMemo, useRef, useState } from 'react'
import { Clock, FileText, Image as ImageIcon, Mic, Paperclip, Send, Trash2, Users } from 'lucide-react'
import { Modal } from '@/components/ui'
import { VoiceComposer } from '@/components/atendimento/VoiceComposer'
import { useVoiceRecorder } from '@/components/atendimento/useVoiceRecorder'
import { atendimentoService } from '@/services/atendimentoService'
import { broadcastService, kindOfFile, type Audience } from '@/services/broadcastService'
import { nowSPDatetimeLocal, spWallTimeToUtcISO } from '@/lib/datetime'
import { toast } from '@/store/toastStore'
import { confirmDialog } from '@/store/confirmStore'
import type { CrmStage } from '@/types'
import { WhatsAppPreview } from './WhatsAppPreview'
import { AvisoRisco, avisoJaLido } from './AvisoRisco'

type Sessao = { id: string; instance_name: string; phone_number: string | null; status: string }
type Quem = 'ids' | 'todos'

const LIMITE_ARQUIVO = 64 * 1024 * 1024
const RITMOS = [
  { v: 4, label: 'Rápido (≈4 s entre contatos)' },
  { v: 8, label: 'Normal (≈8 s) — recomendado' },
  { v: 15, label: 'Seguro (≈15 s) — números novos' },
]

/**
 * Nova campanha de envio em massa. `contatos` vem preenchido quando a pessoa marcou
 * contatos na lista; sem ele, só há a opção "todos" (com filtro de etapa).
 */
export function NovoDisparo({ contatos, stages, onClose, onCreated }: {
  contatos?: { id: string; name: string }[]
  stages: CrmStage[]
  onClose: () => void
  onCreated: () => void
}) {
  const [ciente, setCiente] = useState(avisoJaLido)
  const [nome, setNome] = useState('')
  const [sessoes, setSessoes] = useState<Sessao[]>([])
  const [sessionId, setSessionId] = useState('')
  const [quem, setQuem] = useState<Quem>(contatos?.length ? 'ids' : 'todos')
  const [etapa, setEtapa] = useState('')
  const [totalTodos, setTotalTodos] = useState<number | null>(null)
  const [texto, setTexto] = useState('')
  const [arquivo, setArquivo] = useState<File | null>(null)
  const [ritmo, setRitmo] = useState(8)
  const [quando, setQuando] = useState<'agora' | 'agendar'>('agora')
  const [dataHora, setDataHora] = useState('')
  const [enviando, setEnviando] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const arquivoRef = useRef<HTMLInputElement>(null)
  const audioRef = useRef<HTMLInputElement>(null)

  const voice = useVoiceRecorder(
    (audio) => setArquivo(audio),
    (e) => toast.error(
      e === 'sem-permissao' ? 'Permita o uso do microfone no navegador para gravar áudio.'
        : e === 'sem-suporte' ? 'Este navegador não grava áudio. Use Chrome, Edge ou Firefox atualizados.'
        : 'Áudio muito curto. Grave pelo menos 1 segundo.',
    ),
  )

  useEffect(() => {
    atendimentoService.startSessions().then((l) => {
      setSessoes(l)
      const conectada = l.find((s) => s.status === 'connected') ?? l[0]
      if (conectada) setSessionId(conectada.id)
    }).catch(() => toast.error('Não foi possível carregar os números.'))
  }, [])

  useEffect(() => {
    if (quem !== 'todos') return
    setTotalTodos(null)
    broadcastService.countAudience(etapa || undefined).then(setTotalTodos).catch(() => setTotalTodos(null))
  }, [quem, etapa])

  const kind = arquivo ? kindOfFile(arquivo) : 'text'
  const nDestinos = quem === 'ids' ? (contatos?.length ?? 0) : totalTodos
  const primeiroNome = (contatos?.[0]?.name ?? 'Maria').trim().split(/\s+/)[0]
  // A prévia mostra o texto já com o nome de um contato de exemplo.
  const textoPrevia = useMemo(() => texto.replace(/\{nome\}/gi, primeiroNome), [texto, primeiroNome])

  function escolherArquivo(f: File | undefined) {
    if (!f) return
    if (f.size > LIMITE_ARQUIVO) { toast.error('Arquivo grande demais (máx. 64 MB).'); return }
    setArquivo(f)
  }

  function inserirNome() {
    const el = areaRef.current
    const pos = el?.selectionStart ?? texto.length
    setTexto(texto.slice(0, pos) + '{nome}' + texto.slice(el?.selectionEnd ?? pos))
    setTimeout(() => { el?.focus(); el?.setSelectionRange(pos + 6, pos + 6) }, 0)
  }

  const semConteudo = !arquivo && !texto.trim()
  const dataInvalida = quando === 'agendar' && (!dataHora || dataHora < nowSPDatetimeLocal())
  const podeEnviar = !enviando && nome.trim().length >= 2 && !!sessionId && !semConteudo && !dataInvalida && (nDestinos ?? 0) > 0

  async function enviar() {
    if (!podeEnviar) return
    const quemTxt = `${nDestinos} contato${nDestinos === 1 ? '' : 's'}`
    const quandoTxt = quando === 'agora' ? 'agora' : `em ${dataHora.replace('T', ' às ')}`
    if (!(await confirmDialog({
      title: 'Confirmar envio em massa',
      message: `Enviar para ${quemTxt} ${quandoTxt}? As mensagens saem uma a uma, com pausa entre elas, e não dá para desfazer o que já foi enviado.`,
      confirmLabel: quando === 'agora' ? 'Enviar agora' : 'Agendar',
    }))) return

    setEnviando(true)
    try {
      const media = arquivo ? await broadcastService.uploadMedia(arquivo) : undefined
      const audience: Audience = quem === 'ids'
        ? { mode: 'ids', ids: (contatos ?? []).map((c) => c.id) }
        : { mode: 'all', stage_id: etapa || undefined }
      const r = await broadcastService.create({
        name: nome.trim(), session_id: sessionId, kind, body: texto.trim(), media,
        scheduled_at: quando === 'agendar' ? spWallTimeToUtcISO(dataHora) : undefined,
        delay_seconds: ritmo, audience,
      })
      toast.success(
        (quando === 'agora' ? `Envio iniciado para ${r.total} contatos.` : `Envio agendado para ${r.total} contatos.`)
        + (r.sem_telefone ? ` ${r.sem_telefone} sem telefone válido ficaram de fora.` : ''),
      )
      onCreated()
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Não foi possível criar o envio')
      setEnviando(false)
    }
  }

  if (!ciente) return <AvisoRisco onCiente={() => setCiente(true)} onClose={onClose} />

  return (
    <Modal title="Novo envio em massa" onClose={onClose} variant="dialog" wide>
      <div className="disparo-grid">
        <div className="disparo-form">
          <div className="field">
            <label htmlFor="dp-nome">Nome da campanha (só para você)</label>
            <input id="dp-nome" className="input" value={nome} onChange={(e) => setNome(e.target.value)} maxLength={80} placeholder="Ex.: Promoção de novembro" />
          </div>

          <div className="field">
            <label htmlFor="dp-num">Enviar pelo número</label>
            <select id="dp-num" className="input" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
              {sessoes.length === 0 && <option value="">Nenhum número ligado ao atendimento</option>}
              {sessoes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.phone_number ?? s.instance_name}{s.status !== 'connected' ? ' (desconectado)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label><Users size={13} /> Para quem</label>
            {contatos?.length ? (
              <label className="disparo-radio">
                <input type="radio" checked={quem === 'ids'} onChange={() => setQuem('ids')} />
                {contatos.length} contato{contatos.length === 1 ? '' : 's'} selecionado{contatos.length === 1 ? '' : 's'}
              </label>
            ) : null}
            <label className="disparo-radio">
              <input type="radio" checked={quem === 'todos'} onChange={() => setQuem('todos')} />
              Todos os contatos com telefone{quem === 'todos' && totalTodos !== null ? ` (${totalTodos.toLocaleString('pt-BR')})` : ''}
            </label>
            {quem === 'todos' && (
              <select className="input" value={etapa} onChange={(e) => setEtapa(e.target.value)} aria-label="Etapa do funil">
                <option value="">Todas as etapas</option>
                {stages.map((s) => <option key={s.id} value={s.id}>Só da etapa: {s.name}</option>)}
              </select>
            )}
          </div>

          <div className="field">
            <label htmlFor="dp-msg">Mensagem</label>
            {voice.phase !== 'idle' ? (
              <VoiceComposer voice={voice} />
            ) : (
              <>
                <textarea
                  id="dp-msg" ref={areaRef} className="input" rows={6} value={texto}
                  onChange={(e) => setTexto(e.target.value)} maxLength={4096}
                  placeholder={arquivo ? 'Legenda (opcional)' : 'Digite a mensagem. Use *negrito*, _itálico_ e {nome}.'}
                />
                <div className="flex" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={inserirNome} title="Vira o primeiro nome de cada contato">+ {'{nome}'}</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => arquivoRef.current?.click()}><Paperclip size={13} /> Imagem, vídeo ou arquivo</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => audioRef.current?.click()}><FileText size={13} /> Áudio (arquivo)</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={voice.start}><Mic size={13} /> Gravar áudio</button>
                  <span className="text-muted" style={{ fontSize: 12, marginLeft: 'auto' }}>{texto.length}/4096</span>
                </div>
              </>
            )}
            <input ref={arquivoRef} type="file" hidden accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.zip"
              onChange={(e) => { escolherArquivo(e.target.files?.[0]); e.target.value = '' }} />
            <input ref={audioRef} type="file" hidden accept="audio/*"
              onChange={(e) => { escolherArquivo(e.target.files?.[0]); e.target.value = '' }} />
            {arquivo && (
              <div className="disparo-anexo">
                {kind === 'image' ? <ImageIcon size={14} /> : kind === 'audio' ? <Mic size={14} /> : <Paperclip size={14} />}
                <span className="truncate">{arquivo.name}</span>
                <button type="button" className="icon-btn" onClick={() => setArquivo(null)} aria-label="Remover anexo"><Trash2 size={14} /></button>
              </div>
            )}
            {kind === 'audio' && texto.trim() && (
              <p className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>O WhatsApp não tem legenda em áudio: o texto vai como mensagem antes do áudio.</p>
            )}
          </div>

          <div className="field">
            <label htmlFor="dp-ritmo">Ritmo</label>
            <select id="dp-ritmo" className="input" value={ritmo} onChange={(e) => setRitmo(Number(e.target.value))}>
              {RITMOS.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
            </select>
            <p className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>Mandar rápido demais aumenta o risco de o WhatsApp restringir o número.</p>
          </div>

          <div className="field">
            <label><Clock size={13} /> Quando</label>
            <label className="disparo-radio"><input type="radio" checked={quando === 'agora'} onChange={() => setQuando('agora')} /> Enviar agora</label>
            <label className="disparo-radio"><input type="radio" checked={quando === 'agendar'} onChange={() => { setQuando('agendar'); if (!dataHora) setDataHora(nowSPDatetimeLocal()) }} /> Agendar (horário de Brasília)</label>
            {quando === 'agendar' && (
              <input type="datetime-local" className="input" value={dataHora} min={nowSPDatetimeLocal()} onChange={(e) => setDataHora(e.target.value)} />
            )}
          </div>

          <div className="flex" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={onClose} disabled={enviando}>Cancelar</button>
            <button className="btn btn-primary" onClick={enviar} disabled={!podeEnviar}>
              {enviando ? <span className="spinner" /> : <><Send size={14} /> {quando === 'agora' ? 'Enviar agora' : 'Agendar envio'}</>}
            </button>
          </div>
        </div>

        <div className="disparo-previa">
          <WhatsAppPreview
            mediaType={kind}
            text={textoPrevia}
            caption={textoPrevia}
            file={arquivo}
            groupName={primeiroNome}
          />
          <p className="text-muted" style={{ fontSize: 12, textAlign: 'center', marginTop: 8 }}>
            Prévia para um contato{contatos?.length ? '' : ' de exemplo'}. A quebra de linha pode variar no celular.
          </p>
        </div>
      </div>
    </Modal>
  )
}
