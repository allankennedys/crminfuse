import { Link } from 'react-router-dom'
import { ThemeToggle } from '@/components/ThemeToggle'
import { useTheme } from '@/lib/theme'

const EMPRESA = 'Infuse Software'
const CONTATO = 'contato@infusesoftware.com'
const ATUALIZADO = '13 de novembro de 2026'

function Pagina({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  const theme = useTheme((s) => s.theme)
  return (
    <div className="legal-page">
      <div className="auth-theme"><ThemeToggle /></div>
      <article className="legal-card">
        <Link to="/login" className="legal-logo">
          <img src={theme === 'light' ? '/logo-navy.png' : '/logo.png'} alt="Infuse" style={{ height: 34 }} />
        </Link>
        <h1>{titulo}</h1>
        <p className="text-muted">Última atualização: {ATUALIZADO}</p>
        {children}
        <p className="text-muted" style={{ marginTop: 32, fontSize: 13 }}>
          <Link to="/privacidade">Política de Privacidade</Link> · <Link to="/termos">Termos de Serviço</Link> · <Link to="/login">Voltar ao sistema</Link>
        </p>
      </article>
    </div>
  )
}

export function PrivacidadePage() {
  return (
    <Pagina titulo="Política de Privacidade">
      <p>
        O Infuse CRM é um sistema de atendimento por WhatsApp, funil de vendas e relacionamento com clientes, oferecido
        pela {EMPRESA}. Esta política explica quais dados tratamos, para que e quais são os seus direitos, conforme a
        Lei Geral de Proteção de Dados (LGPD, Lei 13.709/2018).
      </p>

      <h2>1. Quem é quem</h2>
      <p>
        Em relação aos dados de quem cria conta e usa o sistema (você e sua equipe), a {EMPRESA} é a <strong>controladora</strong>.
        Em relação às conversas, contatos e vendas dos clientes da sua empresa, que você registra no sistema, a sua
        empresa é a controladora e a {EMPRESA} atua como <strong>operadora</strong>, tratando esses dados apenas para
        prestar o serviço contratado.
      </p>

      <h2>2. Dados que tratamos</h2>
      <ul>
        <li><strong>Conta:</strong> nome, e-mail, senha (guardada de forma criptografada, nunca em texto) e função na organização.</li>
        <li><strong>Login com o Google:</strong> se você escolher entrar com o Google, recebemos apenas o seu e-mail, nome e foto de perfil. Não acessamos seus e-mails, contatos, arquivos nem qualquer outro dado da sua conta Google.</li>
        <li><strong>Uso do sistema:</strong> conversas, mensagens, arquivos, contatos, etiquetas, campos personalizados, vendas, lembretes e relatórios que você ou sua equipe registram ou recebem pelos números de WhatsApp conectados.</li>
        <li><strong>Cobrança:</strong> plano, status da assinatura e dados de cobrança informados. Os dados do cartão são tratados pelo processador de pagamentos e não passam pelos nossos servidores.</li>
        <li><strong>Notificações:</strong> se você ativar, o identificador técnico do seu navegador ou aparelho para enviar avisos push.</li>
        <li><strong>Dados técnicos:</strong> registros de acesso e de erros, necessários para segurança e funcionamento.</li>
      </ul>

      <h2>3. Para que usamos</h2>
      <ul>
        <li>Criar e manter a sua conta e autenticar o seu acesso.</li>
        <li>Prestar o serviço: enviar, receber e organizar atendimentos, funil, vendas e relatórios.</li>
        <li>Enviar e-mails do sistema (confirmação, convite, recuperação de senha) e avisos que você ativar.</li>
        <li>Cobrar a assinatura e controlar limites do plano.</li>
        <li>Garantir a segurança, prevenir fraudes e cumprir obrigações legais.</li>
      </ul>
      <p>Não vendemos dados pessoais e não os usamos para publicidade.</p>

      <h2>4. Com quem compartilhamos</h2>
      <p>Compartilhamos dados com prestadores de serviço que tratam dados em nosso nome, somente para o funcionamento do serviço. Eles se enquadram nas categorias abaixo (a lista completa pode ser solicitada pelo e-mail de contato):</p>
      <ul>
        <li>provedores de infraestrutura em nuvem (hospedagem do sistema, banco de dados e armazenamento de arquivos);</li>
        <li>provedor de envio de e-mails do sistema;</li>
        <li>processador de pagamentos, para cobranças por cartão;</li>
        <li>Google, apenas se você escolher o login com o Google;</li>
        <li>WhatsApp e a plataforma de integração com ele, para entregar as mensagens.</li>
      </ul>
      <p>Alguns desses prestadores podem processar dados fora do Brasil, com salvaguardas contratuais adequadas.</p>

      <h2>5. Por quanto tempo guardamos</h2>
      <p>
        Mantemos os dados enquanto a conta estiver ativa. Ao excluir um usuário, a conta e o acesso dele são removidos.
        Dados da organização podem ser apagados a seu pedido. Podemos guardar o que a lei exigir, por exemplo registros fiscais e de cobrança.
      </p>

      <h2>6. Seus direitos</h2>
      <p>
        Você pode pedir confirmação do tratamento, acesso, correção, anonimização, portabilidade, eliminação e informação
        sobre compartilhamentos, e revogar consentimentos. Se você é cliente final de uma empresa que usa o Infuse CRM,
        fale primeiro com essa empresa, que é a controladora dos seus dados. Para os demais casos, escreva para {CONTATO}.
      </p>

      <h2>7. Segurança</h2>
      <p>
        Usamos conexão criptografada, controle de acesso por organização e função, senhas criptografadas e registros de
        acesso. Nenhum sistema é totalmente invulnerável, mas trabalhamos para reduzir riscos e avisamos em caso de incidente relevante.
      </p>

      <h2>8. Alterações e contato</h2>
      <p>
        Podemos atualizar esta política e informaremos mudanças relevantes no sistema ou por e-mail. Dúvidas ou pedidos:
        {' '}{EMPRESA} — <a href={`mailto:${CONTATO}`}>{CONTATO}</a>.
      </p>
    </Pagina>
  )
}

export function TermosPage() {
  return (
    <Pagina titulo="Termos de Serviço">
      <p>
        Estes termos regem o uso do Infuse CRM, oferecido pela {EMPRESA}. Ao criar uma conta ou usar o sistema, você
        concorda com eles.
      </p>

      <h2>1. O serviço</h2>
      <p>
        O Infuse CRM reúne atendimento por WhatsApp, funil de vendas, contatos, relatórios e recursos relacionados,
        acessados pela internet. Podemos melhorar, alterar ou descontinuar recursos, avisando com antecedência razoável
        quando a mudança for relevante.
      </p>

      <h2>2. Conta e acesso</h2>
      <ul>
        <li>Quem cria a conta responde pela organização, pelos usuários que convida e pelo que eles fazem no sistema.</li>
        <li>Informe dados verdadeiros e mantenha a senha em sigilo. Atividade feita com o seu acesso é de sua responsabilidade.</li>
        <li>Novos usuários entram por convite do administrador da organização.</li>
      </ul>

      <h2>3. Teste, planos e pagamento</h2>
      <ul>
        <li>O teste grátis dura 7 dias. Depois dele, o uso continua mediante assinatura de um dos planos, com limites de números de WhatsApp e de usuários.</li>
        <li>A cobrança no cartão é recorrente e mensal, por um processador de pagamentos. Outras formas de pagamento são combinadas com o nosso time.</li>
        <li>Em caso de atraso, o acesso passa por avisos, depois modo somente leitura e, por fim, suspensão. Os dados são mantidos para quando o pagamento for regularizado.</li>
        <li>Você pode cancelar a qualquer momento; o cancelamento vale ao fim do período já pago.</li>
      </ul>

      <h2>4. Uso adequado</h2>
      <p>É proibido usar o sistema para:</p>
      <ul>
        <li>enviar spam, mensagens em massa não solicitadas ou conteúdo ilegal, ofensivo, fraudulento ou que viole direitos de terceiros;</li>
        <li>desrespeitar os termos do WhatsApp e da Meta, inclusive regras sobre consentimento e contato com clientes;</li>
        <li>tentar acessar dados de outras organizações, burlar limites do plano ou comprometer a segurança do serviço.</li>
      </ul>
      <p>O uso do WhatsApp é de responsabilidade da sua empresa. Bloqueios ou restrições aplicados pela Meta a um número não são de responsabilidade da {EMPRESA}.</p>

      <h2>5. Seus dados</h2>
      <p>
        Os dados que você registra no sistema continuam sendo seus. Você é responsável por ter base legal para tratá-los
        e por informar seus clientes, conforme a LGPD. Tratamos esses dados como operadores, de acordo com a nossa{' '}
        <Link to="/privacidade">Política de Privacidade</Link>.
      </p>

      <h2>6. Disponibilidade e responsabilidade</h2>
      <p>
        Trabalhamos para manter o sistema disponível, mas ele depende de serviços de terceiros (como o WhatsApp e provedores
        de hospedagem) e pode ter interrupções ou manutenções. O serviço é fornecido como está, sem garantia de resultado
        comercial. Na máxima extensão permitida em lei, a nossa responsabilidade se limita ao valor pago nos 12 meses
        anteriores ao fato que originou a reclamação.
      </p>

      <h2>7. Encerramento</h2>
      <p>
        Você pode encerrar a conta quando quiser. Podemos suspender ou encerrar contas que violem estes termos, com aviso
        sempre que possível.
      </p>

      <h2>8. Alterações, lei aplicável e contato</h2>
      <p>
        Podemos atualizar estes termos e avisaremos sobre mudanças relevantes. Aplica-se a lei brasileira. Dúvidas:{' '}
        <a href={`mailto:${CONTATO}`}>{CONTATO}</a>.
      </p>
    </Pagina>
  )
}
