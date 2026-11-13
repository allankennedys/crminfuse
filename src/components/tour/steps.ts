/**
 * Passos da tour de boas-vindas (151). Cada passo pode apontar para um
 * elemento da tela (data-tour="...") e pedir uma aba. Sem o elemento na tela
 * (ex.: nenhuma conversa aberta), o passo aparece centralizado, só com o texto.
 */
export interface PassoTour {
  /** Valor do atributo data-tour do elemento a destacar. */
  alvo?: string
  /** Aba do CRM a abrir antes de mostrar o passo. Se a pessoa não tem a aba, o passo é pulado. */
  aba?: string
  titulo: string
  texto: string
}

export const TOUR_ATENDENTE: PassoTour[] = [
  {
    titulo: 'Bem-vindo ao Infuse CRM',
    texto: 'Em menos de 1 minuto você vê o básico para atender os clientes. Pode pular quando quiser e rever depois em Configurações → Minha conta.',
  },
  {
    aba: 'atendimento', alvo: 'at-lista',
    titulo: 'Suas conversas',
    texto: 'Aqui ficam as conversas dos clientes. As que estão com você aparecem em "Minhas"; quando houver "Fila", são as que ninguém assumiu ainda. O número azul indica mensagens não lidas.',
  },
  {
    aba: 'atendimento', alvo: 'at-nova',
    titulo: 'Falar com um cliente',
    texto: 'Em "Nova" você inicia uma conversa pelo número do cliente. Se o número não existir ainda nos contatos, o sistema oferece criar o contato.',
  },
  {
    aba: 'atendimento', alvo: 'at-composer',
    titulo: 'Responder',
    texto: 'Escreva e envie com Enter. Digite "/" para usar respostas rápidas, use o clipe para foto, documento, localização ou contato, e o microfone para áudio. Em "Nota interna" você deixa recados só para a equipe.',
  },
  {
    aba: 'atendimento', alvo: 'at-cliente',
    titulo: 'Painel do cliente',
    texto: 'Veja e edite os dados do contato, etiquetas e campos extras; lance uma venda, crie lembretes de retorno e conclua o atendimento com o motivo.',
  },
  {
    alvo: 'sino',
    titulo: 'Avisos e lembretes',
    texto: 'O sino mostra seus lembretes vencidos. Lá você também liga os avisos de mensagem nova e as notificações, que chegam mesmo com o app fechado.',
  },
  {
    titulo: 'Pronto!',
    texto: 'É só isso para começar. Qualquer dúvida, fale com o administrador da sua empresa. Para rever esta tour: Configurações → Minha conta.',
  },
]

export const TOUR_ADMIN: PassoTour[] = [
  {
    titulo: 'Bem-vindo ao Infuse CRM',
    texto: 'Vamos ver em 1 minuto como deixar tudo funcionando: conectar o WhatsApp, convidar a equipe e acompanhar os resultados. Pode pular e rever depois em Configurações → Minha conta.',
  },
  {
    aba: 'atendimento', alvo: 'at-numeros',
    titulo: '1. Conecte o WhatsApp',
    texto: 'Em "Números" você cria um número e lê o QR Code com o celular. Ao conectar, ele já entra no atendimento e as conversas começam a aparecer aqui.',
  },
  {
    aba: 'atendimento', alvo: 'at-lista',
    titulo: '2. Atendimento',
    texto: 'Aqui ficam as conversas. "Minhas", "Fila" e "Todas" mostram o que é de cada um, e a distribuição entre atendentes é configurável. Cada conversa tem painel do cliente, vendas e lembretes.',
  },
  {
    aba: 'funil', alvo: 'tab-funil',
    titulo: '3. Funil de vendas',
    texto: 'Os contatos viram cartões em etapas. Arraste para mover, crie e edite as etapas, marque a de "conversão" (venda) e a de "perdidos" para os relatórios.',
  },
  {
    aba: 'contatos', alvo: 'tab-contatos',
    titulo: '4. Contatos',
    texto: 'A lista de todos os clientes, com busca, filtros por etapa, etiqueta e campos personalizados, e exportação em planilha.',
  },
  {
    aba: 'relatorios', alvo: 'tab-relatorios',
    titulo: '5. Relatórios',
    texto: 'Atendimento, vendas, funil, jornada e recompra, com filtro por período, canal e atendente. Você escolhe quais abas aparecem em Configurações → Organização.',
  },
  {
    aba: 'config', alvo: 'tab-config',
    titulo: '6. Configurações',
    texto: 'Em Usuários você convida atendentes por e-mail e define as permissões. Em Atendimento ficam a distribuição, as respostas rápidas e as mensagens automáticas. Em Plano e cobrança, o seu plano, o uso e o pagamento.',
  },
  {
    alvo: 'sino',
    titulo: 'Avisos e lembretes',
    texto: 'O sino reúne os lembretes e liga os avisos de mensagem nova, inclusive com o app fechado.',
  },
  {
    titulo: 'Tudo pronto!',
    texto: 'Comece conectando o WhatsApp e convidando a equipe. Para rever esta tour: Configurações → Minha conta.',
  },
]
