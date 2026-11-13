/**
 * Leitura de planilhas de contatos (CSV ou Excel) e reconhecimento das colunas
 * pelo nome do cabeçalho. Tudo acontece no navegador: só as linhas já limpas
 * vão para o servidor.
 */

export type Campo = 'nome' | 'telefone' | 'email' | 'etiquetas' | 'valor' | 'observacao'
export type Destino = Campo | `custom:${string}` | ''

/** Cabeçalho sem acento, em minúsculas e só com letras e números separados por espaço. */
export function normalizar(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

const SINONIMOS: Record<Campo, string[]> = {
  nome: ['nome', 'name', 'contato', 'cliente', 'nome completo', 'full name', 'fullname', 'nome do cliente', 'nome cliente',
    'nome do contato', 'nome contato', 'customer', 'customer name', 'contact', 'contact name', 'lead', 'nome do lead',
    'first name', 'primeiro nome', 'razao social', 'nome fantasia', 'pessoa', 'comprador'],
  telefone: ['telefone', 'numero', 'phone', 'phone number', 'number', 'celular', 'whatsapp', 'whats', 'zap', 'tel', 'fone',
    'numero de telefone', 'numero do telefone', 'numero whatsapp', 'whatsapp number', 'mobile', 'mobile phone', 'cell',
    'cel', 'telefone celular', 'telefone 1', 'celular 1', 'fone celular', 'contato telefone', 'nº', 'n'],
  email: ['email', 'e mail', 'mail', 'correio', 'e-mail', 'email address', 'endereco de email'],
  etiquetas: ['etiquetas', 'etiqueta', 'tags', 'tag', 'labels', 'label', 'marcadores', 'marcador', 'categorias', 'categoria'],
  valor: ['valor', 'value', 'ticket', 'valor estimado', 'preco', 'price', 'amount', 'valor total', 'receita'],
  observacao: ['observacao', 'observacoes', 'obs', 'descricao', 'notas', 'nota', 'notes', 'note', 'description',
    'comentario', 'comentarios', 'anotacao', 'anotacoes', 'detalhes'],
}
const PALAVRAS: Record<Campo, string[]> = {
  telefone: ['telefone', 'celular', 'whatsapp', 'phone', 'fone', 'whats', 'zap', 'mobile'],
  email: ['email', 'mail'],
  nome: ['nome', 'name', 'cliente', 'customer'],
  etiquetas: ['etiqueta', 'etiquetas', 'tags', 'tag'],
  valor: ['valor', 'value', 'preco'],
  observacao: ['observacao', 'observacoes', 'obs', 'descricao', 'notas'],
}
const ORDEM: Campo[] = ['telefone', 'email', 'nome', 'etiquetas', 'valor', 'observacao']

/**
 * Sugere o destino de cada coluna. Primeiro o nome exato (ou um sinônimo),
 * depois cabeçalhos que só CONTÊM a palavra ("Telefone 2", "Nome do responsável").
 * Cada campo e cada coluna são usados uma vez.
 */
export function sugerirMapa(cabecalhos: string[], campos: { id: string; name: string }[]): Destino[] {
  const norm = cabecalhos.map(normalizar)
  const mapa: Destino[] = norm.map(() => '')
  const usado = new Set<Destino>()
  const atribuir = (i: number, d: Destino) => { mapa[i] = d; usado.add(d) }

  // campos personalizados pelo nome exato
  norm.forEach((h, i) => {
    const cf = campos.find((c) => normalizar(c.name) === h)
    if (cf && !usado.has(`custom:${cf.id}`)) atribuir(i, `custom:${cf.id}`)
  })
  // nome exato / sinônimo
  for (const campo of ORDEM) {
    const i = norm.findIndex((h, k) => !mapa[k] && SINONIMOS[campo].map(normalizar).includes(h))
    if (i >= 0 && !usado.has(campo)) atribuir(i, campo)
  }
  // cabeçalho que contém a palavra
  for (const campo of ORDEM) {
    if (usado.has(campo)) continue
    const i = norm.findIndex((h, k) => !mapa[k] && h.split(' ').some((p) => PALAVRAS[campo].includes(p)))
    if (i >= 0) atribuir(i, campo)
  }
  return mapa
}

// ---------------------------------------------------------------------------
// Reconhecimento pelo CONTEÚDO da coluna
// ---------------------------------------------------------------------------

export interface Sugestao {
  destino: Destino
  /** 'alta': o nome do cabeçalho e o conteúdo concordam. 'confirmar': na dúvida, a pessoa decide. */
  confianca: 'alta' | 'confirmar' | ''
  motivo: string
}

const taxa = (valores: string[], ok: (v: string) => boolean) => {
  const cheios = valores.filter((v) => v.trim() !== '')
  return cheios.length ? cheios.filter(ok).length / cheios.length : 0
}
const pareceTelefone = (v: string) => /^[\d\s()+.-]+$/.test(v.trim()) && telefoneValido(v) !== null
const pareceEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim())
const pareceDinheiro = (v: string) => /^(r\$\s*)?-?\d{1,3}([.]\d{3})*([,]\d{1,2})?$|^(r\$\s*)?\d+([.,]\d{1,2})?$/i.test(v.trim())
const pareceNome = (v: string) => /\p{L}{2,}/u.test(v) && !/\d{3,}/.test(v) && !v.includes('@') && v.length <= 80

/**
 * Sugere o destino de cada coluna olhando o NOME do cabeçalho e o CONTEÚDO das
 * primeiras linhas. Só marca 'alta' quando os dois concordam; o resto vem como
 * 'confirmar', com o motivo, para a pessoa conferir.
 */
export function analisar(
  p: Planilha,
  campos: { id: string; name: string }[],
): Sugestao[] {
  const amostra = p.linhas.slice(0, 200)
  const valores = (i: number) => amostra.map((l) => l[i] ?? '')
  const porCabecalho = sugerirMapa(p.cabecalhos, campos)
  const res: Sugestao[] = p.cabecalhos.map((_, i) => ({ destino: porCabecalho[i], confianca: porCabecalho[i] ? 'alta' : '', motivo: '' }))

  // O cabeçalho diz uma coisa; o conteúdo CONTRADIZ? Só pergunta quando contradiz de verdade:
  // coluna vazia não conta, e nome pelo cabeçalho nunca é questionado (contato sem nome
  // costuma ter o próprio telefone como nome).
  res.forEach((s, i) => {
    const v = valores(i)
    if (v.every((x) => x.trim() === '')) return
    if (s.destino === 'telefone' && taxa(v, pareceTelefone) < 0.3) { s.confianca = 'confirmar'; s.motivo = 'Os valores não parecem telefones.' }
    if (s.destino === 'email' && taxa(v, pareceEmail) < 0.3) { s.confianca = 'confirmar'; s.motivo = 'Os valores não parecem e-mails.' }
    if (s.destino === 'valor' && taxa(v, pareceDinheiro) < 0.3) { s.confianca = 'confirmar'; s.motivo = 'Os valores não parecem dinheiro.' }
  })

  const usado = (d: Destino) => res.some((s) => s.destino === d)

  // Colunas sem destino: tenta pelo conteúdo.
  const livres = () => res.map((s, i) => (s.destino ? -1 : i)).filter((i) => i >= 0)
  if (!usado('telefone')) {
    const cand = livres().filter((i) => taxa(valores(i), pareceTelefone) >= 0.8)
    if (cand.length) { res[cand[0]] = { destino: 'telefone', confianca: 'confirmar', motivo: 'Os valores parecem telefones.' } }
  }
  if (!usado('email')) {
    const cand = livres().filter((i) => taxa(valores(i), pareceEmail) >= 0.8)
    if (cand.length) { res[cand[0]] = { destino: 'email', confianca: 'confirmar', motivo: 'Os valores parecem e-mails.' } }
  }
  if (!usado('nome')) {
    const cand = livres().filter((i) => taxa(valores(i), pareceNome) >= 0.8 && taxa(valores(i), (v) => v.trim().includes(' ')) >= 0.3)
    // Com mais de uma coluna de texto, não adivinha: deixa vazio para a pessoa escolher.
    if (cand.length === 1) res[cand[0]] = { destino: 'nome', confianca: 'confirmar', motivo: 'Parece o nome (texto com nome e sobrenome).' }
    else if (cand.length > 1) cand.forEach((i) => { res[i].motivo = 'Pode ser o nome. Escolha qual coluna.' })
  }
  return res
}

// ---------------------------------------------------------------------------
// Leitura do arquivo
// ---------------------------------------------------------------------------

export interface Planilha { cabecalhos: string[]; linhas: string[][] }

/** Tira o apóstrofo que a exportação põe antes de + - = @ (proteção contra fórmula). */
const semApostrofo = (s: string) => s.replace(/^'(?=[=+\-@])/, '')

/** CSV com ';', ',' ou tab; aspas, aspas duplas escapadas e BOM. */
export function lerCSV(texto: string): Planilha {
  const t = texto.replace(/^﻿/, '')
  const primeira = t.split(/\r?\n/, 1)[0] ?? ''
  const cont = (c: string) => primeira.split(c).length - 1
  const sep = [';', '\t', ','].sort((a, b) => cont(b) - cont(a))[0]
  const linhas: string[][] = []
  let campo = ''
  let linha: string[] = []
  let aspas = false
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (aspas) {
      if (ch === '"') { if (t[i + 1] === '"') { campo += '"'; i++ } else aspas = false } else campo += ch
    } else if (ch === '"') aspas = true
    else if (ch === sep) { linha.push(campo); campo = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++
      linha.push(campo); campo = ''
      if (linha.some((c) => c.trim() !== '')) linhas.push(linha)
      linha = []
    } else campo += ch
  }
  linha.push(campo)
  if (linha.some((c) => c.trim() !== '')) linhas.push(linha)
  const [cab = [], ...resto] = linhas
  return { cabecalhos: cab.map((c) => c.trim()), linhas: resto.map((l) => cab.map((_, i) => semApostrofo((l[i] ?? '').trim()))) }
}

export async function lerArquivo(arquivo: File): Promise<Planilha> {
  const nome = arquivo.name.toLowerCase()
  if (nome.endsWith('.xlsx')) {
    const { default: readXlsx } = await import('read-excel-file')
    const linhas = (await readXlsx(arquivo)).map((l) => l.map((c) => (c == null ? '' : c instanceof Date ? c.toISOString().slice(0, 10) : String(c).trim())))
    const cheias = linhas.filter((l) => l.some((c) => c !== ''))
    const [cab = [], ...resto] = cheias
    return { cabecalhos: cab, linhas: resto.map((l) => cab.map((_, i) => semApostrofo(l[i] ?? ''))) }
  }
  if (nome.endsWith('.xls')) throw new Error('Arquivos .xls antigos não são aceitos. Salve como .xlsx ou CSV.')
  return lerCSV(await arquivo.text())
}

// ---------------------------------------------------------------------------
// Valores
// ---------------------------------------------------------------------------

/** Mesma regra do banco: 10/11 dígitos ganham o 55; precisa ter de 12 a 15. null = inválido. */
export function telefoneValido(bruto: string): string | null {
  let d = bruto.replace(/\D/g, '')
  if (d.length === 10 || d.length === 11) d = '55' + d
  return d.length >= 12 && d.length <= 15 ? d : null
}

/** Chave para achar repetidos no arquivo (espelha crm_phone_key: tira o 9 extra do celular BR). */
export function chaveTelefone(d: string): string {
  return d.length === 13 && d.startsWith('55') && d[4] === '9' ? d.slice(0, 4) + d.slice(5) : d
}

/** "R$ 1.234,56", "1234.56", "1.234" → centavos. */
export function valorEmCentavos(s: string): number {
  const limpo = s.replace(/[^\d.,-]/g, '')
  if (!limpo) return 0
  const virgula = limpo.lastIndexOf(','), ponto = limpo.lastIndexOf('.')
  let n: string
  if (virgula > ponto) n = limpo.replace(/\./g, '').replace(',', '.')
  else if (ponto > virgula && /\.\d{1,2}$/.test(limpo)) n = limpo.replace(/,/g, '')
  else n = limpo.replace(/[.,]/g, '')
  const v = Number(n)
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : 0
}

/** Datas "31/12/2026" ou "2026-12-31" → ISO; outra coisa → vazio. */
export function dataISO(s: string): string {
  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (br) return `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : ''
}

export interface LinhaPronta {
  n: number
  name: string
  phone: string
  email: string
  tags: string[]
  value_cents: number
  description: string
  custom: Record<string, string>
}
export interface Rejeitada { n: number; nome: string; telefone: string; motivo: string }

export function montarLinhas(
  p: Planilha,
  mapa: Destino[],
  campos: { id: string; kind: string; options: string[] }[],
): { prontas: LinhaPronta[]; rejeitadas: Rejeitada[]; repetidasNoArquivo: number } {
  const col = (d: Destino) => mapa.indexOf(d)
  const iNome = col('nome'), iTel = col('telefone'), iMail = col('email'), iTag = col('etiquetas'), iVal = col('valor'), iObs = col('observacao')
  const prontas: LinhaPronta[] = []
  const rejeitadas: Rejeitada[] = []
  const vistos = new Set<string>()
  let repetidasNoArquivo = 0

  p.linhas.forEach((l, idx) => {
    const n = idx + 2 // linha na planilha (1 é o cabeçalho)
    const nome = (iNome >= 0 ? l[iNome] : '')?.trim() ?? ''
    const telBruto = (iTel >= 0 ? l[iTel] : '')?.trim() ?? ''
    if (!nome) { rejeitadas.push({ n, nome, telefone: telBruto, motivo: 'sem nome' }); return }
    const tel = telefoneValido(telBruto)
    if (!tel) { rejeitadas.push({ n, nome, telefone: telBruto, motivo: telBruto ? 'telefone inválido' : 'sem telefone' }); return }
    const chave = chaveTelefone(tel)
    if (vistos.has(chave)) { repetidasNoArquivo++; return }
    vistos.add(chave)

    const custom: Record<string, string> = {}
    mapa.forEach((d, i) => {
      if (!d.startsWith('custom:')) return
      const id = d.slice(7)
      const cf = campos.find((c) => c.id === id)
      let v = (l[i] ?? '').trim()
      if (!cf || !v) return
      if (cf.kind === 'data') v = dataISO(v)
      else if (cf.kind === 'numero') v = String(valorEmCentavos(v) / 100 || (Number(v.replace(',', '.')) || ''))
      else if (cf.kind === 'lista') v = cf.options.find((o) => normalizar(o) === normalizar(v)) ?? ''
      if (v) custom[id] = v
    })

    prontas.push({
      n, name: nome, phone: tel,
      email: iMail >= 0 ? (l[iMail] ?? '').trim() : '',
      tags: iTag >= 0 ? (l[iTag] ?? '').split(/[,;|]/).map((t) => t.trim()).filter(Boolean) : [],
      value_cents: iVal >= 0 ? valorEmCentavos(l[iVal] ?? '') : 0,
      description: iObs >= 0 ? (l[iObs] ?? '').trim() : '',
      custom,
    })
  })
  return { prontas, rejeitadas, repetidasNoArquivo }
}
