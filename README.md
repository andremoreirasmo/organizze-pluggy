# Organizze ↔ Pluggy

App pessoal para conciliar Open Finance (Pluggy) com lançamentos do Organizze.

## Stack

- `api/` — NestJS (Google SSO + cookie session, Organizze + Pluggy clients)
- `web/` — React + Vite
- Postgres (Neon) via Prisma
- Deploy: Cloud Run (`brazuca-rd`), scale-to-zero

Ver `PLAN.md` para o desenho completo, `PLAN-security-sso.md` e `PLAN-security-harden.md` para auth.

## Pré-requisitos

- [nvm-windows](https://github.com/coreybutler/nvm-windows) + Node 22
- Conta Organizze (API key) e Pluggy (client id/secret)
- Google Cloud Console — OAuth 2.0 Client ID (tipo **Web application**)

```bash
nvm use 22.20.0
```

## Setup local

```bash
cp .env.example .env
# preencha GOOGLE_*, SESSION_SECRET, ORGANIZZE_*, PLUGGY_*, DATABASE_URL

cd api
npm install
npx prisma generate

cd ../web
npm install
```

### Google OAuth (local)

1. Em [Google Cloud Console](https://console.cloud.google.com/apis/credentials) crie um **OAuth client ID** → Web application.
2. **Authorized JavaScript origins**: `http://localhost:5173` (e `http://localhost:3000` se testar o build servido pelo Nest).
3. Cole o Client ID em `GOOGLE_CLIENT_ID`.
4. Em `GOOGLE_ALLOWED_EMAILS` coloque seu Gmail (ou lista separada por vírgula).
5. Gere um `SESSION_SECRET` longo (≥ 32 caracteres).

### Desenvolvimento (hot reload)

Na raiz do projeto:

```bash
npm run dev
```

Isso sobe:
- API Nest em `http://localhost:3000` (watch)
- Front Vite em `http://localhost:5173` (**HMR**)

Abra **sempre** `http://localhost:5173` no browser.  
O Vite faz proxy de `/api` → `:3000`.

Em produção (`NODE_ENV=production`), o Nest serve o build estático do `web/dist` na mesma porta.

## Auth

Login com **Google Identity Services** (ID token → sessão opaca em cookie HttpOnly).

- Allowlist: `GOOGLE_ALLOWED_EMAILS`
- Sessão: cookie `op_session` (token aleatório; hash SHA-256 no Neon)
  - Idle **12h** sem uso → inválida
  - Absolute **7 dias** desde o login
  - Sliding: renova `lastSeenAt`/cookie a cada ≥5 min de uso
  - Novo login revoga sessões anteriores do mesmo e-mail; logout apaga a sessão no DB
- Rate limit: `POST /api/auth/google` 10/min/IP; demais rotas 120/min
- Mutações: Origin/Referer deve ser same-site (em dev, `localhost:5173` ok)
- Públicos: `GET /api/health`, `GET /api/auth/config`, `GET /api/auth/me`, `POST /api/auth/google`, `POST /api/auth/logout`
- Demais rotas `/api/*` exigem cookie válido

Detalhes: `PLAN-security-sso.md`, `PLAN-security-harden.md`.

Em produção, a SPA pode ficar pública; a API sensível continua autenticada. CSP do Helmet libera scripts GIS (`accounts.google.com`).

## Endpoints

### Auth / health
- `GET /api/health` (público)
- `GET /api/auth/config` → `{ googleClientId }` (público)
- `POST /api/auth/google` `{ idToken }` → cookie de sessão (público)
- `GET /api/auth/me` → `{ email }` (público; `email: null` sem sessão)
- `POST /api/auth/logout` limpa cookie (público)

### Organizze
- `GET /api/organizze/accounts`
- `GET /api/organizze/categories`
- `GET /api/organizze/transactions?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`
- `GET /api/organizze/credit-cards`
- `GET /api/organizze/credit-cards/:id/invoices`

### Pluggy
- `POST /api/pluggy/connect-token`
- `GET /api/pluggy/institutions?q=`
- `GET /api/pluggy/connections/config`
- `POST /api/pluggy/connections` `{ itemId, institutionName, institutionImageUrl, ... }`
- `PATCH /api/pluggy/connections/:id`
- `DELETE /api/pluggy/connections/:id`
- `GET /api/pluggy/connections`
- `GET /api/pluggy/accounts`
- `GET /api/pluggy/transactions?accountId=...&dateFrom=&dateTo=`

### Relatórios
- `GET /api/investments/overview`
- `GET /api/installments/overview?month=YYYY-MM`

### Settings
- `GET /api/settings`
- `PUT /api/settings` `{ amountTolerancePercent?, dateToleranceDays?, accountMaps? }`

### Conciliação
- `GET /api/reconciliation/queue?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `POST /api/reconciliation/:pluggyTxId/link` `{ from, to, organizzeTransactionId, syncDate?, syncAmount? }`
- `POST /api/reconciliation/:pluggyTxId/import` `{ from, to, description?, categoryId?, accountId?, creditCardId?, creditCardInvoiceId? }`
- `POST /api/reconciliation/:pluggyTxId/invoice-payment` `{ from, to, creditCardId, invoiceId, accountId? }`
- `POST /api/reconciliation/:pluggyTxId/ignore` `{ from, to, notes? }`

## Fluxo rápido de conciliação

1. **Configurações** → cadastrar bancos Pluggy (itemId + ícone)
2. **Configurações** → mapear cada conta Pluggy para conta ou cartão Organizze
3. **Conciliação** → escolher o mês → Carregar fila
4. Para cada item: Vincular / Importar / Pagamento de fatura / Ignorar

Anti-duplicação: marker `[pluggy:{uuid}]` em `notes` do Organizze + tabela `ReviewDecision` no Neon.
