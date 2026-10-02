# Organizze ↔ Pluggy

App pessoal para conciliar **Open Finance** ([Pluggy](https://pluggy.ai)) com o [Organizze](https://www.organizze.com.br): fila de lançamentos, saldos, faturas de cartão, parcelas e investimentos.

Login com **Google** (allowlist de e-mails). Dados sensíveis ficam no seu Postgres ([Neon](https://neon.tech)).

---

## O que o app faz

| Tela | Função |
|------|--------|
| **Conciliação** (`/conciliacao`) | Fila Pluggy × Organizze no mês: vincular, importar, pagar fatura, transferência, ignorar |
| **Saldos** (`/saldos`) | Compara saldo Open Finance × Organizze; ajusta conta; confere **fatura fechada** do cartão (Pluggy Bills × Organizze) |
| **Relatórios** (`/relatorios`) | Parcelas abertas e visão de investimentos |
| **Configurações** (`/configuracoes`) | Bancos Pluggy, mapeamento conta/cartão, fontes de saldo |

URLs com query compartilhavéis, por exemplo: `/conciliacao?month=2026-09&account=…`.

---

## Stack

- **API:** [NestJS 11](https://nestjs.com/) + [Prisma](https://www.prisma.io/) + Postgres
- **Web:** [React 19](https://react.dev/) + [Vite](https://vite.dev/) + [React Router](https://reactrouter.com/)
- **Integrações:** [Pluggy SDK](https://docs.pluggy.ai/) · [Organizze API](https://developers.organizze.com.br/) · [Google Identity Services](https://developers.google.com/identity/gsi/web)

Monorepo:

```
organizze-pluggy/
  api/     Nest + Prisma
  web/     SPA React
  .env     secrets (não versionar)
```

---

## Pré-requisitos

- **Node.js 22** (recomendado via [nvm-windows](https://github.com/coreybutler/nvm-windows) ou [nvm](https://github.com/nvm-sh/nvm))
- Conta [Organizze](https://www.organizze.com.br) com API key
- Conta [Pluggy Dashboard](https://dashboard.pluggy.ai) (Client ID + Secret)
- Projeto no [Google Cloud Console](https://console.cloud.google.com/) (OAuth Web)
- Banco [Neon](https://console.neon.tech/) (ou outro Postgres) — connection string **pooled**

```bash
nvm use 22
node -v   # v22.x
```

---

## 1. Clonar e instalar

```bash
git clone https://github.com/andremoreirasmo/organizze-pluggy.git
cd organizze-pluggy

cp .env.example .env
# edite .env (veja seção Variáveis de ambiente)

npm install
npm --prefix api install
npm --prefix web install

npm run prisma:generate
# com DATABASE_URL preenchida:
cd api && npm run prisma:migrate && cd ..
```

---

## 2. Variáveis de ambiente

Arquivo na **raiz**: `.env` (modelo em [`.env.example`](.env.example)).

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `GOOGLE_CLIENT_ID` | sim | OAuth 2.0 Client ID (tipo **Web application**) |
| `GOOGLE_ALLOWED_EMAILS` | sim | E-mails Google autorizados, separados por vírgula |
| `SESSION_SECRET` | sim | Segredo longo (≥ 32 caracteres) para a sessão |
| `ORGANIZZE_EMAIL` | sim | E-mail da conta Organizze (Basic Auth da API) |
| `ORGANIZZE_API_TOKEN` | sim | Token em [Configurações → API keys](https://app.organizze.com.br/configuracoes/api-keys) |
| `ORGANIZZE_USER_AGENT` | sim | Ex.: `organizze-pluggy (voce@email.com)` — exigido pela API |
| `PLUGGY_CLIENT_ID` | sim | [Dashboard Pluggy](https://dashboard.pluggy.ai) |
| `PLUGGY_CLIENT_SECRET` | sim | Secret Pluggy |
| `DATABASE_URL` | sim | Postgres (Neon pooled, `?sslmode=require`) |
| `PORT` | não | Default `3000` |
| `NODE_ENV` | não | `development` / `production` |

### Google OAuth

1. Abra [Credentials](https://console.cloud.google.com/apis/credentials).
2. **Create credentials** → **OAuth client ID** → Application type **Web application**.
3. **Authorized JavaScript origins:**
   - Dev: `http://localhost:5173`
   - (Opcional) API local: `http://localhost:3000`
   - Prod: URL pública do app (ex. Cloud Run)
4. Copie o **Client ID** → `GOOGLE_CLIENT_ID`.
5. Em `GOOGLE_ALLOWED_EMAILS` coloque só os Gmails que podem entrar.

Documentação: [Sign in with Google](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid).

### Organizze API

1. [API keys no Organizze](https://app.organizze.com.br/configuracoes/api-keys)
2. Docs: [developers.organizze.com.br](https://developers.organizze.com.br/) · [api-doc no GitHub](https://github.com/organizze/api-doc)

### Pluggy

1. [dashboard.pluggy.ai](https://dashboard.pluggy.ai) → Application → Client ID / Secret  
2. Docs: [docs.pluggy.ai](https://docs.pluggy.ai/) · [Accounts](https://docs.pluggy.ai/docs/accounts) · [Credit card bills](https://docs.pluggy.ai/docs/credit-card-bills)

Conexões bancárias: você cadastra o **itemId** Pluggy em Configurações (após conectar no MeuPluggy / Widget).

### Neon / Postgres

1. Crie um projeto em [console.neon.tech](https://console.neon.tech)
2. Use a connection string **pooled** (`-pooler` no host)
3. Rode as migrations (`prisma migrate`)

---

## 3. Rodar em desenvolvimento

Na raiz:

```bash
npm run dev
```

Sobe em paralelo:

| Serviço | URL |
|---------|-----|
| API Nest (watch) | http://localhost:3000 |
| Front Vite (HMR) | http://localhost:5173 |

Abra **http://localhost:5173**. O Vite faz proxy de `/api` → `:3000`.

Scripts úteis:

```bash
npm run build          # web + api
npm run start          # API em produção (serve também o web/dist)
npm run prisma:migrate # migrate dev (via root)
```

---

## 4. Primeiro uso (fluxo recomendado)

1. **Login** com Google (e-mail na allowlist).
2. **Configurações → Bancos** — cadastre cada conexão Pluggy (`itemId` + ícone da instituição).
3. **Configurações → Contas** — mapeie cada conta Pluggy:
   - conta Organizze, **ou**
   - cartão de crédito Organizze, **ou**
   - **Ignorar** (some da fila / não entra em “sem mapa”).
4. **Configurações → Fontes de saldo** — investments (XP, cofrinho, etc.) se quiser na conciliação de saldos.
5. **Conciliação** — escolha o mês → carregue a fila → vincule / importe / pague fatura / ignore.
6. **Saldos** — confira contas e **faturas de cartão**; use **Ajustar** quando divergir.

Anti-duplicação: marker `[pluggy:{uuid}]` nas `notes` do Organizze + decisões no Postgres.

---

## Autenticação e segurança

- Login: Google Identity Services (ID token → sessão opaca em cookie HttpOnly `op_session`).
- Allowlist: `GOOGLE_ALLOWED_EMAILS`.
- Sessão no Neon: idle ~12h, absolute ~7 dias, sliding no uso.
- Rate limit nas rotas de auth e API.
- Mutações: checagem de Origin/Referer (same-site; em dev `localhost:5173` ok).
- Em produção o Nest serve o `web/dist` na mesma origem (cookie `Secure`).
- Tema claro/escuro (ou seguir o sistema): toggle na topbar; preferência em `localStorage`.

Rotas públicas: `GET /api/health`, `GET /api/auth/config`, `GET /api/auth/me`, `POST /api/auth/google`, `POST /api/auth/logout`.  
Demais `/api/*` exigem sessão.

---

## API (resumo)

### Auth / health

- `GET /api/health`
- `GET /api/auth/config` → `{ googleClientId }`
- `POST /api/auth/google` `{ idToken }`
- `GET /api/auth/me` → `{ email }`
- `POST /api/auth/logout`

### Conciliação

- `GET /api/reconciliation/queue?from=&to=`
- `POST /api/reconciliation/:pluggyTxId/link`
- `POST /api/reconciliation/:pluggyTxId/import`
- `POST /api/reconciliation/:pluggyTxId/invoice-payment`
- `POST /api/reconciliation/:pluggyTxId/ignore`

### Saldos

- `GET /api/balances/snapshot`
- `POST /api/balances/adjust` — ajuste em conta bancária
- `POST /api/balances/adjust-invoice` — lançamento na fatura do cartão

### Relatórios / settings / proxies

- `GET /api/installments/overview?month=YYYY-MM`
- `GET /api/investments/overview`
- `GET|PUT /api/settings`
- `GET /api/organizze/*`, `GET|POST|PATCH|DELETE /api/pluggy/*`

---

## Deploy (Cloud Run)

Há um `Dockerfile` multi-stage (Node 22): build do `web` + `api`, Nest serve a SPA.

### Automático (Cloud Build — GCP)

Push na `master` dispara um **Cloud Build trigger** no projeto GCP (config **inline**, sem workflow no GitHub). Logs e secrets ficam só na GCP (Secret Manager + Cloud Build history).

O serviço Cloud Run lê as envs via Secret Manager (`DATABASE_URL`, `GOOGLE_*`, `SESSION_SECRET`, Organizze, Pluggy — mesmos nomes do [`.env.example`](.env.example)).

Depois do deploy, a URL do serviço deve estar em **Google OAuth → Authorized JavaScript origins**.

### Manual (local)

Script: [`scripts/deploy-cloudrun.ps1`](scripts/deploy-cloudrun.ps1) (lê o `.env` local, não imprime secrets).

```powershell
$env:GCP_PROJECT_ID = "seu-projeto"
.\scripts\deploy-cloudrun.ps1
```

Checklist:

1. Secrets no `.env` — mesmas variáveis do [`.env.example`](.env.example).
2. `NODE_ENV=production` (Cloud Run injeta `PORT=8080`).
3. `prisma migrate deploy` roda no script antes do deploy.
4. No Google OAuth, adicionar a URL pública do serviço em **Authorized JavaScript origins** (a URL aparece no fim do deploy).
5. `GET /api/health` deve responder sem login.

---

## Estrutura útil

| Path | Conteúdo |
|------|----------|
| [`api/src`](api/src) | Nest modules (auth, reconciliation, balances, …) |
| [`web/src`](web/src) | SPA (rotas em `routes.ts`) |
| [`api/prisma`](api/prisma) | Schema e migrations |
| [`.env.example`](.env.example) | Template de secrets |
| [`PLAN.md`](PLAN.md) | Desenho / decisões do projeto |

---

## Licença

Uso pessoal / privado (`UNLICENSED` nos `package.json`). Ajuste se for publicar sob outra licença.
