// Onda das mensagens de voz: usada na revisão da gravação (VoiceComposer) e
// no player das mensagens da conversa (AudioMessage).

/** Altura da barra: nunca some de vez (silêncio vira um tracinho). */
export const altura = (l: number) => `${Math.round(12 + Math.min(1, Math.max(0, l)) * 88)}%`

export const fmtDur = (s: number) => {
  const t = Math.max(0, Math.round(s))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

/**
 * Comprime os níveis em `n` barras (o pico de cada trecho) e normaliza pelo
 * maior — áudio baixo também desenha uma onda legível. O piso de 0,25 evita
 * "inflar" um áudio que é quase só silêncio.
 */
export function resumir(levels: number[], n: number): number[] {
  if (levels.length === 0) return Array(n).fill(0)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * levels.length) / n)
    const b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / n))
    let pico = 0
    for (let j = a; j < b && j < levels.length; j++) pico = Math.max(pico, levels[j])
    out.push(pico)
  }
  const max = Math.max(0.25, ...out)
  return out.map((v) => v / max)
}

/** Onda de enfeite, estável por mensagem, enquanto a de verdade não chega. */
export function ondaProvisoria(seed: string, n: number): number[] {
  let h = 0
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return Array.from({ length: n }, (_, i) => {
    h = (h * 1103515245 + 12345) >>> 0
    return 0.25 + ((h / 0xffffffff) * 0.6) * (0.6 + 0.4 * Math.sin(i / 3))
  })
}

type Analise = { picos: number[]; duracao: number } | null
const cache = new Map<string, Promise<Analise>>()

/**
 * Baixa o áudio e tira a onda de verdade (e a duração exata — o webm do
 * Chrome não informa a dele). Guardado por arquivo: o link assinado muda,
 * o caminho não. null = o navegador não decodificou (a onda provisória fica).
 */
export function analisarAudio(url: string, barras: number): Promise<Analise> {
  const chave = url.split('?')[0]
  let p = cache.get(chave)
  if (!p) {
    p = (async () => {
      try {
        const Ctx = window.OfflineAudioContext
          ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext
        if (!Ctx) return null
        const res = await fetch(url)
        if (!res.ok) return null
        const audio = await new Ctx(1, 1, 44100).decodeAudioData(await res.arrayBuffer())
        const dados = audio.getChannelData(0)
        const passo = Math.max(1, Math.floor(dados.length / 400))
        const niveis: number[] = []
        // Volume médio (RMS) de cada trecho: acompanha as sílabas melhor
        // que o pico, que deixa a onda de uma fala alta quase reta.
        for (let i = 0; i < dados.length; i += passo) {
          let soma = 0
          const fim = Math.min(dados.length, i + passo)
          for (let j = i; j < fim; j++) soma += dados[j] * dados[j]
          niveis.push(Math.sqrt(soma / (fim - i)))
        }
        return { picos: resumir(niveis, barras), duracao: audio.duration }
      } catch {
        return null
      }
    })()
    cache.set(chave, p)
  }
  return p
}
