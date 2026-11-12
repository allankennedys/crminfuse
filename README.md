# Infuse CRM

CRM com atendimento de WhatsApp: funil de vendas, conversas individuais com atendente por conversa, distribuição automática, relatórios e envio de conversões para a Meta.

React + Vite + TypeScript · Supabase (Auth, banco, Realtime, Storage, Edge Functions) · Evolution API (WhatsApp).

## Rodar

```bash
cp .env.example .env   # URL e anon key do projeto Supabase
npm install
npm run dev
```

## Banco

As migrations ficam em `supabase/migrations` e são aplicadas em ordem. Duas trazem marcadores que precisam ser trocados na hora de aplicar:

- `__SUPABASE_REF__` → o ref do projeto Supabase
- `__WORKER_SECRET__` → o mesmo valor do secret `WORKER_SECRET` das funções

A 115 (cargo atendente) roda numa execução separada da 116.

## Edge Functions

| Função | Para quê | JWT |
|---|---|---|
| `evolution` | Números de WhatsApp: criar (nome gerado pelo sistema), QR, status, remover — sempre só os do próprio usuário | sim |
| `wa-chat` | Atendimento: enviar texto/arquivo, marcar como lida, ligar/desligar número | sim |
| `wa-webhook` | Recebe as mensagens da Evolution (só conversas individuais) | não |
| `admin-users` | Criar e administrar usuários (cargos Admin e Atendente) | sim |
| `meta-ads` | Relatório de anúncios da Meta | sim |
| `crm-worker` | Envia as conversões de venda para a Meta (a cada 30 min) | não |
| `worker` | Atualiza o status dos números conectados (a cada minuto) | não |

```bash
npx supabase functions deploy --project-ref SEU-REF --use-api
npx supabase secrets set EVOLUTION_API_URL=... EVOLUTION_API_KEY=... WORKER_SECRET=... OWNER_EMAIL=... --project-ref SEU-REF
```

`supabase/config.toml` já diz quais funções vão sem JWT.

## Atendimento

- Conversas individuais (grupos ficam de fora) dos números ligados em Atendimento → Números.
- Cada conversa tem um atendimento por vez: **na fila → em atendimento → concluído** (com motivo), com reabertura; cliente que volta depois de concluído abre um atendimento novo.
- Configurações → Atendimento: quem vê o quê, distribuição (manual, aleatória, rodízio, fixa), regras por número e por palavra, limite de atendimentos simultâneos, motivos de conclusão e frases de origem.
- Contato do CRM criado na primeira mensagem. Anúncio Click-to-WhatsApp é reconhecido sozinho (origem "Anúncio Instagram/Facebook" + clique); venda lançada para esse cliente vai para a Meta.
- Evolution compartilhada: o nome da instância é gerado pelo sistema e cada número só é visível para quem o criou.

## Relatórios (só admin)

Atendimento · Vendas · Funil · Jornada · Recompra · Meta ADS. A Jornada usa só o que o próprio sistema registra: etapas do funil, conversas, vendas e origem.

## Meta

Configurações → Integrações: Pixel ID e token (conversões) e token/contas de anúncio (relatório Meta ADS).
