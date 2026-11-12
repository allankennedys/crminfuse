import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft, Camera, Check, File as FileIcon, Mic, MoreVertical, Paperclip,
  Phone, Play, Smile, Users, Video,
} from 'lucide-react'
import type { MediaType } from '@/types'

/**
 * Prévia de como a mensagem chega no WhatsApp.
 *
 * POR QUE ISTO EXISTE
 *
 * Quem monta o envio digita num formulário e o resultado só aparece no
 * celular de outra pessoa, depois de disparado para dezenas de grupos. A
 * legenda que ficou grande demais, o negrito que não fechou, a imagem
 * deitada — tudo isso só era descoberto quando não dava mais para voltar.
 *
 * FIDELIDADE, E ONDE ELA PARA
 *
 * As cores, o raio da bolha, a rabicho, o horário e o tique duplo são os do
 * WhatsApp. O que NÃO dá para reproduzir com honestidade:
 *
 *   • o papel de parede oficial é uma arte protegida — aqui é uma textura
 *     própria, na mesma família de cor;
 *   • duração de áudio e vídeo o navegador só sabe depois de carregar o
 *     arquivo; até lá o traço fica sem número, em vez de inventar um;
 *   • quebra de linha por largura depende da fonte do aparelho — o texto
 *     quebra como este painel quebra, não como o celular de destino.
 *
 * A prévia mostra a mensagem para UM grupo. O envio pode ser para vários; o
 * que muda entre eles é só o nome no topo.
 *
 * É A TELA INTEIRA, NÃO UM RECORTE
 *
 * A moldura tem altura de aparelho, barra de cima e campo de digitar embaixo,
 * mesmo sem servirem para nada aqui. Um retângulo do tamanho exato da bolha
 * mostraria a mensagem sozinha no vazio; é a tela em volta que dá a noção de
 * quanto do celular aquela mensagem ocupa — que é metade do que a pessoa
 * quer saber antes de disparar para trinta grupos.
 *
 * A barra de digitar é inerte de propósito: não é um campo, é cenário.
 */

/**
 * Marcação do WhatsApp: *negrito*, _itálico_, ~riscado~, ```mono```.
 *
 * O delimitador precisa encostar em caractere não-branco dos dois lados, que
 * é a regra do app: "2 * 3 * 4" não vira negrito. O jeito curto de escrever
 * isso seria com lookbehind, e ele não existe no Safari anterior ao 16.4 —
 * regex literal que o navegador não sabe ler derruba o BUNDLE INTEIRO no
 * parse, não só esta função. Daí a alternativa explícita: miolo com pontas
 * não-brancas, ou um único caractere.
 */
const FORMATOS: { re: RegExp; tag: keyof JSX.IntrinsicElements }[] = [
  { re: /\*([^\s*][^*]*[^\s*]|[^\s*])\*/g, tag: 'strong' },
  { re: /_([^\s_][^_]*[^\s_]|[^\s_])_/g, tag: 'em' },
  { re: /~([^\s~][^~]*[^\s~]|[^\s~])~/g, tag: 's' },
  { re: /```([^`]+?)```/g, tag: 'code' },
]

/**
 * Aplica a marcação preservando o texto cru do que não casar.
 *
 * Escapar e injetar HTML seria mais curto e abriria uma porta que não se
 * fecha: o texto vem do usuário. Então o resultado é uma árvore de nós React,
 * onde texto é sempre texto.
 */
function formatar(texto: string): React.ReactNode[] {
  let nos: React.ReactNode[] = [texto]

  for (const { re, tag } of FORMATOS) {
    const Tag = tag as 'strong'
    nos = nos.flatMap((no, i) => {
      if (typeof no !== 'string') return [no]
      const partes: React.ReactNode[] = []
      let ultimo = 0
      for (const m of no.matchAll(re)) {
        const inicio = m.index ?? 0
        if (inicio > ultimo) partes.push(no.slice(ultimo, inicio))
        partes.push(<Tag key={`${tag}-${i}-${inicio}`}>{m[1]}</Tag>)
        ultimo = inicio + m[0].length
      }
      if (ultimo < no.length) partes.push(no.slice(ultimo))
      return partes.length > 0 ? partes : [no]
    })
  }
  return nos
}

function tamanhoLegivel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function duracaoLegivel(segundos: number | null): string {
  if (segundos == null || !isFinite(segundos)) return '--:--'
  const m = Math.floor(segundos / 60)
  const s = Math.floor(segundos % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Altura das barrinhas da onda do áudio. Fixa: onda animada distrai. */
const ONDA = [
  8, 14, 20, 11, 24, 17, 9, 22, 13, 26, 15, 10, 19, 23, 12, 8,
  21, 16, 25, 11, 18, 9, 14, 20, 12, 24, 10, 17, 13, 8,
]

export function WhatsAppPreview({
  mediaType, text, caption, file, existingUrl, existingName, groupName,
}: {
  mediaType: MediaType
  /** Corpo da mensagem de texto. */
  text: string
  /** Legenda da mídia. Áudio não tem legenda no WhatsApp. */
  caption: string
  /** Arquivo escolhido agora. */
  file: File | null
  /** Mídia já salva (edição de agendamento), quando nenhum arquivo novo veio. */
  existingUrl?: string | null
  existingName?: string | null
  /** Nome do grupo no topo. Vazio = nenhum grupo escolhido ainda. */
  groupName?: string
}) {
  // Object URL do arquivo local, revogado na troca: sem isso cada arquivo
  // escolhido deixa um blob preso na memória da aba até o reload.
  const [urlLocal, setUrlLocal] = useState<string | null>(null)
  useEffect(() => {
    if (!file) { setUrlLocal(null); return }
    const url = URL.createObjectURL(file)
    setUrlLocal(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  // Duração real de áudio/vídeo: só existe depois que o navegador lê os
  // metadados do arquivo, então entra por evento, não por cálculo.
  const [duracao, setDuracao] = useState<number | null>(null)
  useEffect(() => { setDuracao(null) }, [file, existingUrl])

  const url = urlLocal ?? existingUrl ?? null
  const nome = file?.name ?? existingName ?? ''
  const corpo = mediaType === 'text' ? text : caption

  const agora = useMemo(
    () => new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    [],
  )

  // Documento se desenha só com nome e tamanho — não depende de conseguir
  // ler o arquivo, ao contrário de imagem, vídeo e áudio.
  const vazio = mediaType === 'text' ? text.trim() === ''
    : mediaType === 'document' ? !file && !nome
    : !url

  // Onde o horário se apoia:
  //   com texto      → sobe na última linha (o ::after do .wa-text guarda o
  //                    espaço), como no app;
  //   imagem/vídeo   → flutua sobre a mídia, com fundo escurecido;
  //   áudio/doc      → linha própria abaixo, senão ele senta em cima da onda
  //                    ou do nome do arquivo.
  const temTexto = corpo.trim() !== ''
  const classeCarimbo = temTexto ? 'wa-stamp'
    : mediaType === 'image' || mediaType === 'video' ? 'wa-stamp wa-stamp-float'
    : 'wa-stamp wa-stamp-below'

  const carimbo = (
    <span className="wa-meta">
      {agora}
      <span className="wa-ticks" aria-label="entregue e lido">
        <Check size={14} strokeWidth={3} />
        <Check size={14} strokeWidth={3} />
      </span>
    </span>
  )

  return (
    <div className="wa-preview">
      <div className="wa-topbar">
        <ArrowLeft size={19} className="wa-topbar-back" />
        <span className="wa-avatar"><Users size={17} /></span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="wa-topbar-name">{groupName || 'Selecione um grupo'}</div>
          <div className="wa-topbar-sub">
            {groupName ? 'toque para ver os dados do grupo' : 'a prévia mostra um grupo por vez'}
          </div>
        </div>
        <span className="wa-topbar-acoes" aria-hidden="true">
          <Video size={18} />
          <Phone size={17} />
          <MoreVertical size={18} />
        </span>
      </div>

      <div className="wa-chat">
        <span className="wa-dia">HOJE</span>
        {vazio ? (
          <p className="wa-hint">
            {mediaType === 'text'
              ? 'Digite a mensagem para ver como ela chega.'
              : 'Escolha o arquivo para ver como ele chega.'}
          </p>
        ) : (
          <div className={`wa-bubble${mediaType === 'image' || mediaType === 'video' ? ' wa-bubble-media' : ''}`}>
            {mediaType === 'image' && url && (
              <img className="wa-media" src={url} alt="" />
            )}

            {mediaType === 'video' && url && (
              <div className="wa-video">
                <video
                  src={url}
                  preload="metadata"
                  onLoadedMetadata={(e) => setDuracao(e.currentTarget.duration)}
                />
                <span className="wa-play"><Play size={20} fill="currentColor" /></span>
                <span className="wa-video-dur">{duracaoLegivel(duracao)}</span>
              </div>
            )}

            {mediaType === 'audio' && url && (
              <div className="wa-audio">
                {/* Sem controles: só serve para o navegador ler a duração. */}
                <audio
                  src={url}
                  preload="metadata"
                  onLoadedMetadata={(e) => setDuracao(e.currentTarget.duration)}
                  style={{ display: 'none' }}
                />
                <span className="wa-audio-avatar"><Mic size={15} /></span>
                <span className="wa-play wa-play-sm"><Play size={16} fill="currentColor" /></span>
                <span className="wa-wave" aria-hidden="true">
                  {ONDA.map((h, i) => (
                    <i key={i} style={{ height: h }} />
                  ))}
                </span>
                <span className="wa-audio-dur">{duracaoLegivel(duracao)}</span>
              </div>
            )}

            {mediaType === 'document' && (
              <div className="wa-doc">
                <span className="wa-doc-icon"><FileIcon size={20} /></span>
                <div style={{ minWidth: 0 }}>
                  <div className="wa-doc-name">{nome || 'documento'}</div>
                  <div className="wa-doc-sub">
                    {file ? tamanhoLegivel(file.size) : 'arquivo'}
                    {nome.includes('.') && ` · ${nome.split('.').pop()?.toUpperCase()}`}
                  </div>
                </div>
              </div>
            )}

            {temTexto && <p className="wa-text">{formatar(corpo)}</p>}

            <span className={classeCarimbo}>{carimbo}</span>
          </div>
        )}
      </div>

      {/* Cenário: a barra de digitar do app, inerte. */}
      <div className="wa-barra" aria-hidden="true">
        <span className="wa-campo">
          <Smile size={20} />
          <span className="wa-campo-texto">Mensagem</span>
          <Paperclip size={19} />
          <Camera size={19} />
        </span>
        <span className="wa-botao-mic"><Mic size={19} /></span>
      </div>
    </div>
  )
}
