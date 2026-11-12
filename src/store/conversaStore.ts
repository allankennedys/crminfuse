import { create } from 'zustand'

export interface ContatoParaConversa {
  id: string
  name: string
  phone: string | null
}

/**
 * Pedido de "iniciar conversa" (126), compartilhado entre telas.
 *
 * Quem pede (Atendimento, lista de contatos, cartão do contato) não precisa
 * saber onde a janela mora nem como chegar à conversa: a página do CRM
 * escuta o pedido, mostra a janela e, iniciada a conversa, troca para a aba
 * Atendimento com ela aberta (`abrir`).
 */
interface ConversaState {
  /** null = janela fechada; { contact: undefined } = escolher na janela. */
  pedido: { contact?: ContatoParaConversa } | null
  /** Conversa a abrir no Atendimento assim que ele montar. */
  abrir: string | null
  pedir: (contact?: ContatoParaConversa) => void
  fechar: () => void
  abrirConversa: (id: string) => void
  consumir: () => void
}

export const useConversaStore = create<ConversaState>((set) => ({
  pedido: null,
  abrir: null,
  pedir: (contact) => set({ pedido: { contact } }),
  fechar: () => set({ pedido: null }),
  abrirConversa: (id) => set({ abrir: id, pedido: null }),
  consumir: () => set({ abrir: null }),
}))
