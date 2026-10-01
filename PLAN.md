# Plano: Organizze ↔ Pluggy (Open Finance)

Projeto pessoal para conciliar transações Open Finance (Pluggy) com lançamentos do Organizze, com revisão manual, suporte a pagamento de fatura de cartão e anti-duplicação via `notes`.

---

## 1. Objetivo do produto

O usuário abre o app ocasionalmente, vê transações bancárias vindas do Pluggy e decide, uma a uma:

1. **Vincular a um lançamento fixo/existente** no Organizze (sugeridos por valor parecido) → marca como pago, ajusta data/valor se necessário, grava ID Pluggy em `notes`.
2. **Importar como novo lançamento** → cria movimentação no Organizze com descrição editável + ID Pluggy em `notes`.
3. **Ignorar** → não importa (nem toda transação Open Finance precisa ir pro Organizze).
4. **Pagamento de fatura** → trata como pagamento de `credit_card` / `invoice` no Organizze.

Fonte da verdade financeira continua sendo o **Organizze**. O app é uma ponte de conciliação, não um segundo financeiro.

---

## 2. Pesquisa das APIs

### 2.1 Organizze (`https://api.organizze.com.br/rest/v2`)

| Tema | Achado |
|------|--------|
| Auth | HTTP Basic: email + API token (`/configuracoes/api-keys`). Header `User-Agent` obrigatório. |
| Movimentações | `GET/POST/PUT/DELETE /transactions`. Paginação por mês (`start_date`/`end_date`). |
| Campo “obs” | Na API chama-se **`notes`** (o que a UI chama de observações). |
| Fixos | Flag `recurring: true`. Criação com `recurrence_attributes.periodicity`. Atualização com `update_future` / `update_all`. |
| Marcar pago | `PUT /transactions/:id` com `{ "paid": true, ... }`. |
| Cartões / faturas | `GET /credit_cards`, `GET /credit_cards/:id/invoices`, detalhe da fatura com `transactions` e `payments`. |
| Pagamento de fatura | `POST /credit_cards/:id/invoices/:id/payments` com `account_id`, `amount_cents`, `date`, `notes`. **Não** usar `POST /transactions` com `paid_credit_card_*`. |
| Contas | `GET /accounts` — necessário mapear conta Pluggy ↔ conta Organizze. |
| Valores | Sempre em **centavos** (`amount_cents`). Despesas negativas. |

Documentação: [organizze/api-doc](https://github.com/organizze/api-doc), [developers.organizze.com.br](https://developers.organizze.com.br/).

### 2.2 Pluggy

| Tema | Achado |
|------|--------|
| SDK | `pluggy-sdk` (Node/TS oficial). |
| Fluxo | Backend cria Connect Token → frontend abre Pluggy Connect → retorna `itemId` → backend lista accounts/transactions. |
| Transações | Até ~12 meses. Cursor pagination (`fetchAllTransactions` / `fetchTransactionsCursor`). `id` UUID estável na maior parte dos syncs; Open Finance também tem `providerId`. |
| Tipos | `BANK` e `CREDIT`. Pagamento de fatura no cartão: amount negativo + `operationType` como `PAGAMENTO_FATURA`. |
| Auth | `PLUGGY_CLIENT_ID` + `PLUGGY_CLIENT_SECRET` só no servidor. |
| Plano | Conta free pessoal do usuário — suficiente para uso individual. |

Docs: [docs.pluggy.ai](https://docs.pluggy.ai/), MCP live docs: `https://mcp.pluggy.ai/mcp`.

### 2.3 Anti-duplicação (estratégia)

Gravar no `notes` do lançamento Organizze um marcador estável:

```text
[pluggy:6ec156fe-e8ac-4d9a-a4b3-7770529ab01c]
```

Regras:

- Ao listar candidatos a importar, excluir qualquer Pluggy `transaction.id` já presente em `notes` de movimentações do período (+ cache local).
- Preservar texto humano existente em `notes` (append, não overwrite cego).
- Preferir `pluggy.id`; se o ID mudar após delete/recreate no Pluggy, fallback opcional por `providerId` (Open Finance).

Isso evita depender só do banco local e sobrevive a reinstall do app.

---

## 3. Infraestrutura (barato / idle = quase zero)

### 3.1 App: Google Cloud Run

O “action no GCP” encaixa em **Cloud Run** com `min-instances: 0` (scale-to-zero):

- Só cobra enquanto atende request (cold start ~1–3s aceitável para uso pessoal).
- Free tier generoso para tráfego baixo.
- Um único serviço/container serve **API + frontend estático**.

Alternativa descartada: Compute Engine / VM 24h (mais caro). Cloud Functions puro complica servir SPA + Nest juntos.

### 3.2 Banco: Neon Postgres (free)

| Opção | Prós | Contras |
|-------|------|---------|
| **Neon (recomendado)** | Free permanente, scale-to-zero (~5 min idle), Postgres real, encaixa com Cloud Run | Storage free limitado (~0.5 GB — mais que suficiente) |
| Supabase free | Postgres + extras | Pausa projeto após ~1 semana inativo |
| Turso / SQLite libSQL | Bem barato | Menos familiar com Nest/Prisma |
| Sem banco | Só `notes` no Organizze | Sem estado de “ignorados”, settings, itemId Pluggy |

**Recomendação:** Neon free + Prisma.

O que guardar no banco (mínimo):

- `settings` (mapeamento conta Pluggy ↔ conta Organizze, preferências de tolerância de valor).
- `pluggy_items` (`itemId`, institution, last sync).
- `review_decisions` (Pluggy tx ignoradas / adiadas — o que o Organizze não guarda).
- Opcional: cache de último sync para UX.

Credenciais Organizze/Pluggy: **somente env vars** no Cloud Run (Secret Manager), nunca no frontend.

### 3.3 Diagrama

```text
┌─────────────┐     HTTPS      ┌──────────────────────────┐
│  Browser    │ ◄────────────► │  Cloud Run (Nest)        │
│  React SPA  │                │  /api/* + static assets  │
└─────────────┘                └────────────┬─────────────┘
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    ▼                       ▼                       ▼
              ┌──────────┐           ┌────────────┐           ┌──────────┐
              │  Neon    │           │  Pluggy    │           │ Organizze│
              │ Postgres │           │  API       │           │ API v2   │
              └──────────┘           └────────────┘           └──────────┘
```

---

## 4. Stack recomendada

### 4.1 Por que Nest?

| Critério | Nest | Express/Fastify “puro” |
|----------|------|-------------------------|
| Estrutura módulos (Organizze, Pluggy, Conciliation) | Excelente | Manual |
| Validação DTO / tipagem | Built-in | Extra |
| Serve SPA no mesmo processo | `ServeStaticModule` | Simples também |
| Overhead para app pessoal | Um pouco maior | Mais leve |

**Decisão:** NestJS + TypeScript — alinhado ao pedido, bom para clientes HTTP tipados e um monólito único no Cloud Run.

### 4.2 Frontend

**React + Vite** (SPA), buildado e servido pelo Nest em produção.

Motivos: widget Pluggy Connect é JS; SPA leve; um `Dockerfile` só.

Alternativa: Angular (combo clássico com Nest) — também ok se preferir; para app pessoal React costuma ser mais rápido de iterar.

### 4.3 Monorepo simples

```text
organizze-pluggy/
├── apps/
│   ├── api/          # NestJS
│   └── web/          # React + Vite
├── packages/
│   └── shared/       # tipos DTOs compartilhados (opcional)
├── Dockerfile        # multi-stage: build web → nest serve
├── PLAN.md
└── README.md
```

Ou monólito Nest com `client/` na raiz — também válido e mais simples no início.

**Recomendação inicial:** monólito Nest (`src/` + `web/`) para reduzir tooling até o MVP.

---

## 5. Domínio e fluxos

### 5.1 Fluxo principal — conciliação

```text
1. Usuário autentica no app (Google SSO + cookie — ver §7)
2. Sync: buscar txs Pluggy (período) + txs Organizze do mês
3. Filtrar Pluggy já linkadas ([pluggy:id] em notes) e já ignoradas (DB)
4. Para cada tx Pluggy pendente:
   a. Sugerir lançamentos Organizze com |amount| próximo (± tolerância %, default 2–5%)
      e data próxima (± N dias), preferindo unpaid + recurring
   b. UI: Confirmar vínculo | Criar novo | Pagamento fatura | Ignorar
5. Ao confirmar vínculo:
   - PUT Organizze: paid=true, date/amount da tx bancária (se user aceitar),
     notes += [pluggy:id]
6. Ao criar novo:
   - POST Organizze com description editável, category/account, notes com [pluggy:id]
7. Ao pagamento de fatura:
   - User escolhe credit_card + invoice
   - POST `/credit_cards/:id/invoices/:id/payments` + account_id origem + [pluggy:id] em notes
8. Ao ignorar:
   - Persistir decision no Neon
```

### 5.2 Matching de valor

```text
score = f(
  abs(pluggy.amount - organizze.amount_cents/100),
  abs(days(pluggy.date - organizze.date)),
  organizze.paid === false ? boost : 0,
  organizze.recurring === true ? boost : 0,
  similarity(description) // opcional, secundário
)
```

Ordenar candidatos por score; usuário sempre confirma.

### 5.3 Pagamento de fatura — detalhe

Open Finance costuma mostrar na **conta corrente** um débito “Pagamento fatura …” e às vezes no cartão um crédito `PAGAMENTO_FATURA`.

No Organizze o correto é criar o pagamento via:

```http
POST /rest/v2/credit_cards/{creditCardId}/invoices/{invoiceId}/payments
{ "account_id", "amount_cents", "date", "notes?" }
```

`POST /transactions` com `paid_credit_card_*` **não** vincula à fatura (cria gasto solto).

UI dedicada: toggle “É pagamento de fatura?” → select cartão → select fatura aberta → confirmar.

### 5.4 Conexão Pluggy (uma vez)

1. `POST /api/pluggy/connect-token`
2. Frontend: Pluggy Connect widget
3. Callback com `itemId` → salvar em `pluggy_items`
4. Syncs seguintes usam o `itemId` salvo (Update Mode se precisar reconectar)

---

## 6. Módulos Nest (proposta)

| Módulo | Responsabilidade |
|--------|------------------|
| `OrganizzeModule` | Client HTTP Basic, accounts, categories, transactions, credit cards/invoices |
| `PluggyModule` | Connect token, items, accounts, transactions |
| `ReconciliationModule` | Matching, import, link, ignore, invoice payment |
| `SettingsModule` | Mapeamento contas, tolerâncias |
| `AuthModule` | Google OIDC + cookie session (`GOOGLE_*`, `SESSION_SECRET`) |
| `AppModule` | ServeStatic do build React |

Endpoints MVP:

- `GET /api/health`
- `POST /api/pluggy/connect-token`
- `POST /api/pluggy/items` — salvar itemId
- `GET /api/reconciliation/queue?from=&to=` — fila de revisão com sugestões
- `POST /api/reconciliation/:pluggyTxId/link` — `{ organizzeTransactionId, ... }`
- `POST /api/reconciliation/:pluggyTxId/import` — criar no Organizze
- `POST /api/reconciliation/:pluggyTxId/invoice-payment` — `{ creditCardId, invoiceId, ... }`
- `POST /api/reconciliation/:pluggyTxId/ignore`
- `GET/PUT /api/settings`

---

## 7. Segurança (uso pessoal) — DECIDIDO

**Auth do app: Google OIDC + allowlist** (ver `PLAN-security-sso.md`). Login via Google Identity Services; sessão em cookie HttpOnly assinado com `SESSION_SECRET`.

Camadas:

| Camada | Medida |
|--------|--------|
| Acesso ao app | Google Sign-In + `GOOGLE_ALLOWED_EMAILS`; cookie `op_session` nas rotas `/api/*` (exceto health/auth públicos) |
| Secrets | Secret Manager no GCP; nunca no frontend nem no git |
| Credenciais externas | `ORGANIZZE_*` e `PLUGGY_*` só no servidor |
| Transporte | HTTPS (Cloud Run default) |
| Headers | Helmet + CSP permitindo GIS (`accounts.google.com`) em prod |
| Cloud Run | `max-instances: 1`; auth no app (cookie); SPA pode ficar pública |
| CORS | Same-origin (SPA servida pelo mesmo Nest; Vite proxy em dev) |

Secrets necessários:

- `GOOGLE_CLIENT_ID`, `GOOGLE_ALLOWED_EMAILS`, `SESSION_SECRET` (≥ 32 chars)
- `ORGANIZZE_EMAIL`, `ORGANIZZE_API_TOKEN`
- `PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET`
- `DATABASE_URL`

---

## 8. Deploy

1. Dockerfile multi-stage: `npm run build` (web + api) → imagem Node slim.
2. Cloud Run: região `southamerica-east1` (SP), CPU throttling on, min 0, max 1.
3. Neon: connection string pooled (`-pooler`) + Prisma; pool size 1–2 no container.
4. Cold start: aceitável; opcional “warm” manual abrindo o URL.

Custo estimado uso esporádico: **R$ 0** dentro dos free tiers Cloud Run + Neon.

---

## 9. Fases de entrega

### Fase 0 — Bootstrap ✅
- Scaffold Nest + React + Prisma + Dockerfile
- Env example, healthcheck, **Google SSO** (substituiu Basic Auth)

### Fase 1 — Integrações read-only ✅
- Cliente Organizze: accounts, categories, transactions, credit cards/invoices
- Cliente Pluggy: connect token, item, accounts, transactions
- UI: conectar banco + listar txs brutas

### Fase 2 — Conciliação core ✅ (entrega atual)
- Settings: mapeamento conta/cartão Pluggy ↔ Organizze + tolerâncias
- Fila de revisão + matching por valor/data
- Link (marcar pago + notes) / Import / Ignore
- Dedup por `[pluggy:id]` + `ReviewDecision` no Neon

### Fase 3 — Faturas ✅ (entrega atual)
- Compras CREDIT → import com `credit_card_id` / fatura
- Pagamento de fatura via `POST .../invoices/:id/payments`
- Detecção de candidato a pagamento + UI Conciliação

### Fase 4 — Polish
- Filtros adicionais na fila
- Deploy Cloud Run + Neon documentado no README
- Ajustes finos de UX

---

## 10. Decisões fechadas

| Item | Decisão |
|------|---------|
| Frontend | React + Vite |
| Auth | **Google OIDC + allowlist** (`PLAN-security-sso.md`) — confirmado |
| Node | **nvm-windows** + Node 22 LTS (`nvm use 22.20.0`) |
| Matching default | ±5% valor e ±5 dias (ajustável em settings) |
| Credenciais Organizze/Pluggy | Usuário já possui |
| GCP | Projeto existente; deploy via `gcloud` CLI |
| DB | Neon Postgres free |
| Hosting | Cloud Run, min instances = 0 |

Ainda pendente só na hora do deploy: e-mail Google a permitir (N/A), nome do projeto GCP, e criar projeto Neon.

---

## 11. Riscos e mitigações

| Risco | Mitigação |
|-------|-----------|
| Docs Organizze de “pagamento fatura” ambíguas | Usar `POST .../invoices/:id/payments` (validado); evitar `POST /transactions` com `paid_credit_card_*` |
| Pluggy `id` muda em delete/recreate | Guardar também `providerId` em notes ou na tabela local |
| Cold start Cloud Run + Neon wake | UX com spinner “acordando…”; timeout generoso |
| `notes` usado pelo usuário para texto livre | Append do marcador; parser regex tolerante |
| Valores Pluggy em reais vs Organizze em centavos | Camada de conversão única no `OrganizzeModule` |
| Conta Google fora da allowlist | `GOOGLE_ALLOWED_EMAILS`; 403 mesmo com token válido |

---

## 12. Próximo passo

Fases 2–3 implementadas. Usar a UI: mapear contas → Conciliação → revisar fila do mês.
Polish (Fase 4): filtros extras e deploy Cloud Run.
