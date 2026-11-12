/**
 * Geração e download de CSV.
 *
 * Duas decisões que parecem detalhe e não são, porque o destino real do
 * arquivo é o Excel em português:
 *
 *   SEPARADOR ';'  — o Excel pt-BR lê o separador de lista do locale, que
 *                    aqui é ponto e vírgula. Com vírgula ele joga a linha
 *                    inteira na coluna A e a pessoa conclui que o sistema
 *                    exportou errado.
 *   BOM UTF-8      — sem os três bytes iniciais o Excel assume a codificação
 *                    do sistema e "João" vira "JoÃ£o". O BOM é ignorado por
 *                    qualquer outro leitor.
 *
 * Números saem com vírgula decimal pelo mesmo motivo: é o que o Excel pt-BR
 * reconhece como número em vez de texto.
 */

/**
 * Escapa um valor para uma célula.
 *
 * Aspas duplas sempre que houver separador, aspas, quebra de linha ou espaço
 * nas pontas — e as aspas internas dobram, como manda o RFC 4180.
 *
 * O prefixo com apóstrofo em valores que começam com = + - @ não é frescura:
 * é injeção de fórmula. Uma célula com `=cmd|...` é executada por alguns
 * leitores ao abrir o arquivo, e o conteúdo aqui vem de campo de texto livre
 * preenchido por gente e por automação externa.
 */
export function csvCell(value: unknown): string {
  if (value == null) return ''
  let s = String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[";\n\r]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Monta o texto do CSV a partir do cabeçalho e das linhas. */
export function toCSV(headers: string[], rows: unknown[][]): string {
  const linhas = [headers.map(csvCell).join(';')]
  for (const row of rows) linhas.push(row.map(csvCell).join(';'))
  // CRLF: é o que o RFC 4180 pede e o que o Excel no Windows espera.
  return linhas.join('\r\n')
}

/** Centavos → "1234,56" (sem símbolo: o Excel formata como moeda depois). */
export function csvMoney(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',')
}

/** Dispara o download no navegador. */
export function downloadCSV(filename: string, content: string) {
  // ﻿ = BOM. Ver o cabeçalho do arquivo.
  const blob = new Blob(['﻿', content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Sem o revoke o blob fica na memória da aba até o reload — some numa
  // exportação, incomoda em vinte.
  URL.revokeObjectURL(url)
}
