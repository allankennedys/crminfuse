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

## Domínio da API (api.infusesoftware.com)

O navegador não fala direto com o backend: tudo (login, banco, funções, arquivos e o tempo real) passa pelo Worker `infuse-api` da Cloudflare, publicado em `api.infusesoftware.com` — código em `cloudflare/api-proxy/worker.js`. Ele repassa as chamadas e tira dos retornos os cabeçalhos que identificam o fornecedor.

- `VITE_SUPABASE_URL=https://api.infusesoftware.com` (local e na Vercel).
- Secret `PUBLIC_API_URL=https://api.infusesoftware.com` nas funções: os links de mídia que vão para o navegador saem por esse domínio.
- O webhook da Evolution continua apontando direto para o projeto (servidor com servidor; o navegador não vê).
- Plano grátis de Workers: 100 mil requisições/dia. Se o login começar a dar "rate limit" com muita gente, os limites ficam em Authentication → Rate Limits no painel do backend (todo mundo chega pelo mesmo proxy).

Para publicar uma versão nova do Worker: painel da Cloudflare → Workers → `infuse-api` → editar código, ou `PUT /accounts/{conta}/workers/scripts/infuse-api` pela API.

## Edge Functions

| Função | Para quê | JWT |
|---|---|---|
| `evolution` | Números de WhatsApp: criar (nome gerado pelo sistema), QR, status, remover — sempre só os do próprio usuário | sim |
| `wa-chat` | Atendimento: enviar texto/arquivo, marcar como lida, ligar/desligar número | sim |
| `wa-webhook` | Recebe da Evolution as mensagens (só conversas individuais), os status (entregue/lida) e a conexão do número | não |
| `admin-users` | Criar e administrar usuários (cargos Admin e Atendente) | sim |
| `meta-ads` | Relatório de anúncios da Meta | sim |
| `crm-worker` | Envia as conversões de venda para a Meta (a cada 30 min) | não |
| `worker` | Confere o status dos números a cada 30 min, de reserva — o normal é o status chegar na hora pelo webhook (evento de conexão) | não |

```bash
npx supabase functions deploy --project-ref SEU-REF --use-api
npx supabase secrets set EVOLUTION_API_URL=... EVOLUTION_API_KEY=... WORKER_SECRET=... OWNER_EMAIL=... --project-ref SEU-REF
```

`supabase/config.toml` já diz quais funções vão sem JWT.

## Mídias (fotos, vídeos, áudios, documentos)

O WhatsApp apaga as mídias dos servidores dele depois de um tempo e a Evolution não guarda o arquivo — por isso cada mídia é baixada assim que chega e guardada aqui.

- **Com o R2 configurado** (secrets `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`), as mídias novas vão para o Cloudflare R2. O bucket precisa de CORS liberando `GET`, `PUT` e `HEAD` (o navegador sobe os anexos da equipe direto para lá).
- **Sem ele**, vão para o Storage do Supabase (bucket `wa-media`).
- O `media_path` diz onde cada arquivo está (`r2:` na frente = R2), então os dois convivem.
- Nada é público: os links são temporários e só saem pela `wa-chat` (ação `media_urls`), depois de a RLS confirmar que o usuário vê aquela conversa.

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
# crminfuse
