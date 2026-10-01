# Organizze ↔ Pluggy

App pessoal para conciliar Open Finance (Pluggy) com lançamentos do Organizze.

## Stack

- `api/` — NestJS (Basic Auth, Organizze + Pluggy clients)
- `web/` — React + Vite
- Postgres (Neon) via Prisma
- Deploy: Cloud Run (`brazuca-rd`), scale-to-zero

Ver `PLAN.md` para o desenho completo.

## Pré-requisitos

- [nvm-windows](https://github.com/coreybutler/nvm-windows) + Node 22
- Conta Organizze (API key) e Pluggy (client id/secret)

```bash
nvm use 22.20.0
```

## Setup local

```bash
cp .env.example .env
# preencha APP_*, ORGANIZZE_*, PLUGGY_*

cd api
npm install
npx prisma generate

cd ../web
npm install
```

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

HTTP Basic Auth com `APP_USER` / `APP_PASSWORD`.  
`GET /api/health` é público.

## Endpoints

### Auth / health
- `GET /api/health` (público)

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
