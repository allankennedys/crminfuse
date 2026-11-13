import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Upload } from 'lucide-react'
import { Modal } from '@/components/ui'
import { crmService } from '@/services/crmService'
import { toast } from '@/store/toastStore'
import { toCSV, downloadCSV } from '@/lib/csv'
import {
  analisar, lerArquivo, montarLinhas, type Destino, type Planilha, type Rejeitada, type Sugestao,
} from '@/lib/importContatos'
import type { CrmCustomField, CrmStage, UserProfile } from '@/types'

const LOTE = 1000
const ROTULO: Record<string, string> = {
  nome: 'Nome', telefone: 'Telefone', email: 'E-mail', etiquetas: 'Etiquetas', valor: 'Valor', observacao: 'Observação',
}

type Passo = 'arquivo' | 'colunas' | 'resumo' | 'pronto'

export function ImportarContatos({ stages, onClose, onDone }: { stages: CrmStage[]; onClose: () => void; onDone: () => void }) {
  const [passo, setPasso] = useState<Passo>('arquivo')
  const [planilha, setPlanilha] = useState<Planilha | null>(null)
  const [sugestoes, setSugestoes] = useState<Sugestao[]>([])
  const [mapa, setMapa] = useState<Destino[]>([])
  const [confirmadas, setConfirmadas] = useState<Set<number>>(new Set())
  const [campos, setCampos] = useState<CrmCustomField[]>([])
  const [usuarios, setUsuarios] = useState<UserProfile[]>([])
  const [etapa, setEtapa] = useState('')
  const [etiqueta, setEtiqueta] = useState(`Importado ${new Date().toLocaleDateString('pt-BR')}`)
  const [responsavel, setResponsavel] = useState('')
  const [nomeArquivo, setNomeArquivo] = useState('')
  const [erro, setErro] = useState('')
  const [ocupado, setOcupado] = useState(false)
  const [resumo, setResumo] = useState<{ novos: number; existentes: number; invalidosServidor: Rejeitada[] } | null>(null)
  const [final, setFinal] = useState<{ criados: number; existentes: number } | null>(null)

  useEffect(() => {
    void crmService.listCustomFields().then(setCampos)
    void crmService.listOrgUsers().then(setUsuarios).catch(() => setUsuarios([]))
  }, [])

  async function escolher(arq: File | undefined) {
    if (!arq) return
    setErro('')
    try {
      const p = await lerArquivo(arq)
      if (p.cabecalhos.length === 0 || p.linhas.length === 0) throw new Error('O arquivo está vazio ou sem linhas de contatos.')
      if (p.linhas.length > 20000) throw new Error('O arquivo tem mais de 20 mil linhas. Divida em partes.')
      const s = analisar(p, campos)
      setPlanilha(p); setSugestoes(s); setMapa(s.map((x) => x.destino)); setConfirmadas(new Set())
      setNomeArquivo(arq.name); setPasso('colunas')
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível ler o arquivo.')
    }
  }

  const calculo = useMemo(
    () => (planilha ? montarLinhas(planilha, mapa, campos) : null),
    [planilha, mapa, campos],
  )

  // Colunas que o sistema não tem certeza e a pessoa ainda não confirmou.
  const pendentes = mapa.map((d, i) => (d && sugestoes[i]?.confianca === 'confirmar' && mapa[i] === sugestoes[i].destino && !confirmadas.has(i) ? i : -1)).filter((i) => i >= 0)
  const faltaNome = !mapa.includes('nome')
  const faltaTel = !mapa.includes('telefone')
  const duplicados = (['nome', 'telefone', 'email', 'etiquetas', 'valor', 'observacao'] as const).filter((d) => mapa.filter((m) => m === d).length > 1)
  const podeConferir = !faltaNome && !faltaTel && pendentes.length === 0 && duplicados.length === 0 && (calculo?.prontas.length ?? 0) > 0

  function trocar(i: number, d: Destino) {
    setMapa((m) => m.map((x, k) => (k === i ? d : x)))
    setConfirmadas((c) => new Set(c).add(i))
  }

  const opcoes = { stageId: etapa || null, tag: etiqueta.trim(), assignedTo: responsavel || null }

  async function conferir() {
    if (!calculo) return
    setOcupado(true); setErro('')
    try {
      let novos = 0, existentes = 0
      const inval: Rejeitada[] = []
      for (let i = 0; i < calculo.prontas.length; i += LOTE) {
        const r = await crmService.importContacts(calculo.prontas.slice(i, i + LOTE), { ...opcoes, dry: true })
        novos += r.created; existentes += r.duplicates
        r.invalid.forEach((x) => inval.push({ n: x.n, nome: '', telefone: '', motivo: x.reason }))
      }
      setResumo({ novos, existentes, invalidosServidor: inval })
      setPasso('resumo')
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível conferir.')
    } finally { setOcupado(false) }
  }

  async function importar() {
    if (!calculo) return
    setOcupado(true); setErro('')
    try {
      let criados = 0, existentes = 0
      for (let i = 0; i < calculo.prontas.length; i += LOTE) {
        const r = await crmService.importContacts(calculo.prontas.slice(i, i + LOTE), { ...opcoes, dry: false })
        criados += r.created; existentes += r.duplicates
      }
      setFinal({ criados, existentes })
      setPasso('pronto')
      toast.success(`${criados} contato${criados === 1 ? '' : 's'} importado${criados === 1 ? '' : 's'}.`)
      onDone()
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Falha ao importar. Parte dos contatos pode ter sido criada; rode de novo, os repetidos são pulados.')
    } finally { setOcupado(false) }
  }

  function baixarRejeitadas() {
    if (!calculo) return
    const todas = [...calculo.rejeitadas, ...(resumo?.invalidosServidor ?? [])]
    downloadCSV('contatos-nao-importados.csv', toCSV(['Linha', 'Nome', 'Telefone', 'Motivo'], todas.map((r) => [r.n, r.nome, r.telefone, r.motivo])))
  }

  const rejeitadasTotal = (calculo?.rejeitadas.length ?? 0) + (resumo?.invalidosServidor.length ?? 0)

  return (
    <Modal title="Importar contatos" onClose={onClose} variant="dialog" wide>
      {passo === 'arquivo' && (
        <div className="imp-drop">
          <FileSpreadsheet size={34} />
          <p><strong>Escolha uma planilha de contatos</strong></p>
          <p className="text-muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
            Arquivo CSV ou Excel (.xlsx), com uma linha de cabeçalho. Precisa ter ao menos o nome e o telefone.
            Quem já está cadastrado (mesmo telefone) é pulado.
          </p>
          <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
            <Upload size={15} /> Escolher arquivo
            <input type="file" accept=".csv,.txt,.xlsx" style={{ display: 'none' }} onChange={(e) => { void escolher(e.target.files?.[0]); e.target.value = '' }} />
          </label>
          {erro && <p className="error-text">{erro}</p>}
        </div>
      )}

      {passo === 'colunas' && planilha && calculo && (
        <>
          <p className="text-secondary" style={{ marginBottom: 12, fontSize: 13 }}>
            <strong>{nomeArquivo}</strong> · {planilha.linhas.length} linhas. Confira o que cada coluna representa.
          </p>

          <div className="imp-tabela">
            {planilha.cabecalhos.map((h, i) => {
              const s = sugestoes[i]
              const duvida = mapa[i] && s?.confianca === 'confirmar' && mapa[i] === s.destino && !confirmadas.has(i)
              return (
                <div key={i} className={`imp-col${duvida ? ' duvida' : ''}`}>
                  <div className="imp-col-info">
                    <strong>{h || `Coluna ${i + 1}`}</strong>
                    <span className="text-muted">{planilha.linhas.slice(0, 3).map((l) => l[i]).filter(Boolean).join(' · ') || '—'}</span>
                  </div>
                  <div className="imp-col-ctl">
                    <select className="input" value={mapa[i]} onChange={(e) => trocar(i, e.target.value as Destino)}>
                      <option value="">Ignorar esta coluna</option>
                      {Object.entries(ROTULO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      {campos.map((cf) => <option key={cf.id} value={`custom:${cf.id}`}>{cf.name} (campo)</option>)}
                    </select>
                    {duvida && (
                      <div className="imp-aviso">
                        <AlertTriangle size={13} /> <span>{s.motivo || 'Sugerido pelo conteúdo. Confirme.'}</span>
                        <button type="button" className="link-btn" onClick={() => setConfirmadas((c) => new Set(c).add(i))}>Está certo</button>
                      </div>
                    )}
                    {!mapa[i] && s?.motivo && <div className="imp-aviso suave">{s.motivo}</div>}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="imp-opcoes">
            <div className="field">
              <label>Etapa do funil</label>
              <select className="input" value={etapa} onChange={(e) => setEtapa(e.target.value)}>
                <option value="">Fora do funil</option>
                {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Etiqueta desta importação</label>
              <input className="input" value={etiqueta} onChange={(e) => setEtiqueta(e.target.value)} maxLength={40} placeholder="(nenhuma)" />
            </div>
            <div className="field">
              <label>Responsável</label>
              <select className="input" value={responsavel} onChange={(e) => setResponsavel(e.target.value)}>
                <option value="">Sem responsável</option>
                {usuarios.map((u) => <option key={u.id} value={u.id}>{u.full_name || u.username || u.email}</option>)}
              </select>
            </div>
          </div>

          <p className="text-muted" style={{ fontSize: 13 }}>
            {calculo.prontas.length} linhas prontas
            {calculo.rejeitadas.length > 0 && <> · <strong>{calculo.rejeitadas.length}</strong> com problema (sem nome ou telefone inválido)</>}
            {calculo.repetidasNoArquivo > 0 && <> · {calculo.repetidasNoArquivo} repetidas no arquivo</>}
          </p>
          {faltaNome && <p className="error-text">Escolha qual coluna é o nome.</p>}
          {faltaTel && <p className="error-text">Escolha qual coluna é o telefone.</p>}
          {duplicados.length > 0 && <p className="error-text">Mais de uma coluna marcada como {duplicados.map((d) => ROTULO[d].toLowerCase()).join(', ')}. Deixe só uma.</p>}
          {pendentes.length > 0 && <p className="error-text">Confirme as colunas marcadas com o aviso antes de continuar.</p>}
          {erro && <p className="error-text">{erro}</p>}

          <div className="flex" style={{ justifyContent: 'space-between', marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => setPasso('arquivo')}>Trocar arquivo</button>
            <button className="btn btn-primary" disabled={!podeConferir || ocupado} onClick={conferir}>
              {ocupado ? <span className="spinner" /> : 'Conferir'}
            </button>
          </div>
        </>
      )}

      {passo === 'resumo' && resumo && calculo && (
        <>
          <div className="imp-resumo">
            <div><b>{resumo.novos}</b><span>contatos novos</span></div>
            <div><b>{resumo.existentes + calculo.repetidasNoArquivo}</b><span>já existem (pulados)</span></div>
            <div><b>{rejeitadasTotal}</b><span>com problema</span></div>
          </div>
          {rejeitadasTotal > 0 && <button className="link-btn" onClick={baixarRejeitadas}>Baixar a lista dos que não serão importados</button>}
          <p className="text-muted" style={{ fontSize: 13, marginTop: 12, lineHeight: 1.5 }}>
            Os contatos entram {etapa ? `na etapa “${stages.find((s) => s.id === etapa)?.name}”` : 'fora do funil'}
            {etiqueta.trim() ? <> com a etiqueta <strong>{etiqueta.trim()}</strong> (dá para filtrar por ela depois)</> : ''}.
            Nenhuma mensagem é enviada.
          </p>
          {erro && <p className="error-text">{erro}</p>}
          <div className="flex" style={{ justifyContent: 'space-between', marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => setPasso('colunas')} disabled={ocupado}>Voltar</button>
            <button className="btn btn-primary" disabled={resumo.novos === 0 || ocupado} onClick={importar}>
              {ocupado ? <span className="spinner" /> : `Importar ${resumo.novos} contato${resumo.novos === 1 ? '' : 's'}`}
            </button>
          </div>
        </>
      )}

      {passo === 'pronto' && final && (
        <div className="imp-drop">
          <CheckCircle2 size={36} style={{ color: 'var(--success, #22a06b)' }} />
          <p><strong>{final.criados} contato{final.criados === 1 ? '' : 's'} importado{final.criados === 1 ? '' : 's'}</strong></p>
          {(final.existentes > 0 || rejeitadasTotal > 0) && (
            <p className="text-muted" style={{ fontSize: 13 }}>
              {final.existentes > 0 && `${final.existentes} já existiam e foram pulados. `}
              {rejeitadasTotal > 0 && <button className="link-btn" onClick={baixarRejeitadas}>Baixar os {rejeitadasTotal} que tiveram problema</button>}
            </p>
          )}
          <button className="btn btn-primary" onClick={onClose}>Fechar</button>
        </div>
      )}
    </Modal>
  )
}
