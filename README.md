# ⚡ Infuse Groups

SaaS multi-tenant para **gerenciamento e automação de envios em múltiplos grupos e múltiplos números de WhatsApp**, integrado à **Evolution API 2.3**.

Dark premium UI · Supabase (Auth + DB + Realtime) · React + Vite + TypeScript.

---

## 🚀 Setup

### 1. Supabase

1. Crie um projeto em [supabase.com](https://supabase.com).
2. No **SQL Editor**, execute o conteúdo de [`supabase/migrations/001_schema.sql`](supabase/migrations/001_schema.sql).
   - Cria as 10+ tabelas multi-tenant, RLS, triggers de signup e as RPCs da fila (`claim_queue_batch`, `release_stale_locks`).
3. Em **Authentication → Providers → Email**, desative "Confirm email" para testes (ou configure SMTP).

### 2. Evolution API 2.3

Tenha uma instância da Evolution API rodando (Docker ou VPS) com a **global API key**.

> ⚠️ Se a Evolution estiver em outro domínio, habilite CORS para a origem do painel.

### 3. Variáveis de ambiente

```bash
cp .env.example .env
```

| Variável | Descrição |
|---|---|
| `VITE_SUPABASE_URL` | URL do projeto Supabase |
| `VITE_SUPABASE_ANON_KEY` | Anon key do Supabase |
| `VITE_EVOLUTION_API_URL` | URL base da Evolution API |
| `VITE_EVOLUTION_API_KEY` | Global API key da Evolution |

### 4. Rodar

```bash
npm install
npm run dev
```

---

## 🧩 Arquitetura

```
UI (pages/) → lógica de negócio (services/) → integrações externas (Evolution API / Supabase)
```

| Service | Responsabilidade |
|---|---|
| `whatsappService.ts` | Única camada que fala com a Evolution API (sessions, QR, envios, grupos) |
| `queueService.ts` | Motor de fila: prioridade, rate limit por sessão, retry com backoff, lock anti-duplicidade |
| `schedulerService.ts` | Cron de 30s: move agendamentos "due" para a fila |
| `groupService.ts` | CRUD de grupos + sync de participantes/grupos reais do WhatsApp |
| `sessionService.ts` | Espelha status das instâncias no banco + auto-reconnect |

### Fluxo de envio (obrigatório)

```
Usuário cria mensagem → message_queue → worker (rate limit + prioridade)
  → Evolution API → sucesso: message_logs (sent)
                  → erro: retry ×3 (imediato → +30s → +2min) → message_logs (failed)
```

- **Nenhum envio acontece fora da fila.**
- **Todo envio gera log** (`queued` → `sent` / `retrying` / `failed`).
- Lock via `FOR UPDATE SKIP LOCKED` (RPC `claim_queue_batch`) impede processamento duplicado entre abas/workers.
- Distribuição inteligente: o worker escolhe a sessão conectada com menor uso na janela de rate limit.

### Multi-tenancy

- Toda tabela tem `organization_id` + **RLS ativo** (`current_org_id()`).
- Roles: `admin` (tudo), `operator` (opera envios), `viewer` (somente leitura — worker não inicia).
- Signup cria organização própria automaticamente (trigger `handle_new_user`).

### Realtime

Supabase Realtime assina `message_queue`, `message_logs` e `whatsapp_sessions` — dashboard, fila e logs atualizam ao vivo.

---

## 📄 Páginas

| Rota | Função |
|---|---|
| `/dashboard` | Métricas do dia + gráfico de envios (7 dias) em tempo real |
| `/groups` | CRUD de grupos, importação dos grupos reais do WhatsApp, participantes |
| `/sessions` | Conectar números (QR Code), status, reconexão, rate limit |
| `/messages` | Composer (texto/imagem/áudio/vídeo/documento) + fila ao vivo |
| `/schedules` | Agendamentos com prioridade e timezone |
| `/logs` | Histórico completo com filtros por grupo, status e data |
| `/settings` | Gestão de usuários e roles (admin) |

---

## 📦 Deploy (Vercel)

```bash
vercel --prod
```

Configure as 4 variáveis `VITE_*` no painel da Vercel. O `vercel.json` já trata o rewrite de SPA.

## 🔭 Roadmap (pós-MVP)

- [ ] Worker server-side (Supabase Edge Function + pg_cron) para operar com o painel fechado
- [ ] Webhook receiver da Evolution (eventos de conexão/mensagens → automation_rules)
- [ ] Upload de mídia para Supabase Storage
- [ ] Automation rules na UI (trigger → ação)
- [ ] Analytics avançado
# grupos-ph
