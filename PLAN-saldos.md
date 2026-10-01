# Plano: Conciliação de saldos (Open Finance ↔ Organizze)

## 1. Problema

Hoje o app concilia **transações**. Ainda falta comparar **saldos atuais** entre Pluggy/MeuPluggy e Organizze, e criar um lançamento de ajuste quando divergirem.

Casos reais:

1. **XP (investimentos)** — existe uma conta “XP” no Organizze com o patrimônio investido. De tempos em tempos o usuário lança rendimento/perda para alinhar o saldo. Open Finance traz o saldo investido atualizado; o app deveria mostrar a diferença e sugerir o ajuste.
2. **Mercado Pago Cofrinho** — o saldo do cofrinho **não** entra no `balance` da conta corrente do Mercado Pago. No Pluggy ele aparece como **Investment** (tipicamente `FIXED_INCOME` / CDB, como cofrinhos do Nubank/PicPay). Sem conciliar investimentos, o controle de saldo + rendimento do cofrinho fica manual.

Fonte da verdade operacional continua sendo o **Organizze**; Open Finance é a referência de “quanto está de fato lá”.

---

## 2. Pesquisa das APIs

### 2.1 Pluggy — saldo de conta bancária

`Account.balance` (número em **reais**):

| Tipo | Significado |
|------|-------------|
| `BANK` | Saldo disponível para gastar |
| `CREDIT` | Fatura/limite usado — **fora do escopo v1** |

Extras úteis em `bankData`:

- `automaticallyInvestedBalance` — valor automaticamente investido na própria conta (às vezes separado do `balance`).
- `closingBalance` — disponível + bloqueado (Open Finance).

Endpoint opcional: `GET /accounts/{id}/balance` (saldo em tempo real sem sync completo). Para o MVP, o `balance` já retornado em `fetchAccounts` basta (já sincronizado pelo MeuPluggy).

### 2.2 Pluggy — investimentos

Produto separado: `GET /investments?itemId=…` (SDK: `fetchInvestments`).

Campos relevantes:

| Campo | Uso |
|-------|-----|
| `id` | Chave estável para mapear |
| `name`, `type`, `subtype` | UI / filtro |
| `balance` | Valor líquido atual (reais) — **fonte do saldo OF** |
| `amountProfit` | Lucro/prejuízo acumulado (quando a instituição manda) |
| `amountOriginal` | Valor aplicado original |
| `status` | Preferir `ACTIVE` |

Docs: [Investments](https://docs.pluggy.ai/docs/investments). Cofrinhos/caixinhas costumam ser CDB em investments.

**Hoje o projeto só lista `accounts`.** Investimentos ainda não são lidos nem mapeados.

### 2.3 Organizze — saldo da conta

Endpoint não documentado no README antigo, mas confirmado pelo time ([issue #21](https://github.com/organizze/api-doc/issues/21)) e na API pública moderna:

```http
GET /rest/v2/balances?account_id={id}&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
```

Resposta (resumo):

- `balance` — saldo no fim do período (considerar `predicted_balance` só se quisermos incluir lançamentos futuros; **v1 usa `balance` realizado**).
- Se omitir `account_id`, agrega todas as contas.

**Unidade:** a API v2 trata valores monetários como inteiros em centavos. Validar com uma chamada real no primeiro spike e normalizar tudo para `*_cents` no backend.

Ajuste de saldo = `POST /transactions` na conta Organizze:

```json
{
  "description": "Ajuste de saldo (rendimento)",
  "date": "2026-04-01",
  "amount_cents": 12345,
  "account_id": 42,
  "category_id": null,
  "paid": true,
  "notes": "[balance-adjust:pluggy:ACCOUNT_OR_INVESTMENT_ID]"
}
```

- OF > Organizze → `amount_cents` **positivo** (receita / rendimento).
- OF < Organizze → `amount_cents` **negativo** (despesa / perda / correção).

Marcador em `notes` distinto de `[pluggy:txId]` para não misturar com a fila de transações.

---

## 3. Modelo de mapeamento

O `AccountMap` atual cobre só contas Pluggy (`BANK`/`CREDIT`) → conta/cartão Organizze.

Para saldos precisamos de **fontes Pluggy de saldo** que podem ser:

| Fonte (`sourceKind`) | ID | Exemplo |
|----------------------|-----|---------|
| `account` | Pluggy `account.id` | Conta corrente Mercado Pago, Sicoob |
| `investment` | Pluggy `investment.id` | Cofrinho MP, fundo XP |
| `investment_group` (opcional v1.1) | chave lógica `itemId:broker` | Soma de todos os ACTIVE da XP → uma conta Organizze |

### Proposta: `BalanceMap` (novo, ao lado de `accountMaps`)

```ts
type BalanceMap = {
  /** Chave estável: `account:{pluggyAccountId}` ou `investment:{pluggyInvestmentId}` */
  sourceKey: string
  sourceKind: 'account' | 'investment'
  pluggySourceId: string
  /** Conta Organizze (somente bank account; nunca credit_card) */
  organizzeAccountId: number
  /** Rótulo opcional (ex.: "Cofrinho MP", "XP") */
  nickname?: string | null
  /** Se true, entra na tela de saldos (default true) */
  enabled?: boolean
}
```

**Agregação many→1 (XP):** na v1, o usuário mapeia N investments para o **mesmo** `organizzeAccountId`. A tela de saldos **agrupa por conta Organizze** e soma os saldos OF. Diff = Σ(OF) − saldo Organizze.

Alternativa mais explícita depois: `investment_group` com lista de IDs. Adiar se many→1 por `organizzeAccountId` resolver.

**Reuso do AccountMap:** para contas `BANK` já mapeadas para `targetType: 'account'`, podemos **auto-sugerir** BalanceMap (ou derivar on-the-fly sem persistir). Investimentos sempre exigem map explícito.

**Ignorados:** Cofrinho que o usuário não quer no Organizze continua fora (sem BalanceMap / `enabled: false`). Contas CREDIT não entram.

---

## 4. UX proposta

Nova aba na topbar: **Saldos** (entre Conciliação e Configurações).

### 4.1 Lista

Por linha (agrupada por conta Organizze):

| Coluna | Conteúdo |
|--------|----------|
| Conta Organizze | Nome (+ nickname das fontes) |
| Open Finance | Saldo OF (soma das fontes) |
| Organizze | Saldo atual |
| Diferença | OF − Organizze (verde/vermelho) |
| Fontes | Chips: “Conta MP”, “Cofrinho”, “3 ativos XP” |

Estados:

- `|diff| < tolerância` (ex. R$ 0,05) → “OK”
- caso contrário → “Divergente” + botão **Ajustar**

### 4.2 Modal Ajustar

- Valor pré-preenchido = diff (editável)
- Data = hoje (editável)
- Descrição sugerida: `Ajuste de saldo` / `Rendimento` / `Perda` conforme sinal
- Categoria opcional (CategoryPicker)
- Confirma → `POST` transaction + refresh da linha
- Texto de ajuda: “Cria um lançamento pago no Organizze para igualar ao saldo Open Finance.”

### 4.3 Configuração de fontes

Em **Configurações**, seção nova **“Fontes de saldo”**:

1. Contas BANK já mapeadas → toggle “Incluir na conciliação de saldos” + conta Organizze (pré-preenchida).
2. Lista de investments por conexão Pluggy → mapear para conta Organizze (ou “Ignorar”).
3. Aviso quando várias fontes apontam para a mesma conta Organizze (soma).

---

## 5. Backend

### 5.1 Endpoints

| Método | Path | Função |
|--------|------|--------|
| `GET` | `/api/balances/snapshot` | Monta linhas OF vs Organizze |
| `POST` | `/api/balances/adjust` | Cria lançamento de ajuste |
| `GET` | `/api/pluggy/investments` | Lista investments das conexões |
| `GET/PUT` | `/api/settings` | Estender com `balanceMaps` (+ tolerância de saldo opcional) |

### 5.2 `GET /api/balances/snapshot` (resposta)

```ts
type BalanceSnapshotRow = {
  organizzeAccountId: number
  organizzeAccountName: string
  organizzeBalanceCents: number
  openFinanceBalanceCents: number
  diffCents: number // OF - Organizze
  status: 'ok' | 'diverged'
  sources: Array<{
    sourceKey: string
    sourceKind: 'account' | 'investment'
    label: string
    balanceCents: number
    connectionName?: string | null
  }>
}
```

Algoritmo:

1. Carregar `balanceMaps` enabled (+ derivar de `accountMaps` BANK se não houver override).
2. Buscar Pluggy accounts + investments das conexões em paralelo.
3. Para cada fonte, ler saldo (reais → cents).
4. Agrupar por `organizzeAccountId`.
5. Para cada grupo, `GET /balances?account_id=&end_date=hoje` (start_date: início do mês ou janela larga — **spike**: confirmar se `balance` no fim do período é o saldo acumulado desde o início da conta; pela issue #21, `previous_balance` + movimentos do período compõem o saldo atual quando o range cobre até hoje. Usar `end_date=hoje` e `start_date` no 1º dia do mês **ou** um range longo; validar no spike).
6. Calcular diff e status.

### 5.3 `POST /api/balances/adjust`

Body: `{ organizzeAccountId, amountCents, date, description?, categoryId? }`

Valida conta, cria transaction `paid: true`, notes com marcador de ajuste, retorna tx + snapshot parcial.

### 5.4 Pluggy service

- `listInvestments()` — agrega `fetchInvestments` por `itemId` das conexões, filtra `status !== 'TOTAL_WITHDRAWAL'` (ou só `ACTIVE`).

---

## 6. Decisões de produto (v1)

| Decisão | Escolha |
|---------|---------|
| Cartões de crédito | Fora |
| Saldo em tempo real Pluggy (`/accounts/{id}/balance`) | Fora (usa cache do último sync) |
| Agregar N investments → 1 conta Organizze | Sim, por mesmo `organizzeAccountId` |
| Auto-incluir AccountMaps BANK | Sim (derivado), com opt-out via BalanceMap |
| Tolerância “OK” | R$ 0,05 (5 cents), configurável depois |
| Predicted / lançamentos futuros no Organizze | Ignorar (`balance`, não `predicted_balance`) |
| Ajuste via transferência | Não — sempre lançamento simples na conta alvo |
| Cofrinho sem conta Organizze | Usuário cria a conta no Organizze e mapeia |

---

## 7. Riscos e mitigações

| Risco | Mitigação |
|-------|-----------|
| Unidade do `/balances` (centavos vs reais) | Spike de 1 request; assertar contra UI do Organizze |
| Investment IDs instáveis após reconnect | Documentar; nickname + match por name como fallback futuro |
| XP com dezenas de ativos | Agrupar por conta Organizze; UI colapsável de fontes |
| Conta MP “só corrente” vs “corrente + cofrinho” | Duas fontes / duas contas Organizze (ou uma só se o usuário quiser fundir) |
| Duplo ajuste acidental | Mostrar diff atual; marker em notes; não auto-criar |

---

## 8. Fases de implementação

### Fase A — Spike + fundação
1. Confirmar unidade e semântica de `GET /balances`.
2. `OrganizzeService.getAccountBalance(accountId)`.
3. `PluggyService.listInvestments()`.
4. Tipos `BalanceMap` em settings.

### Fase B — Snapshot API + UI Saldos
1. `GET /api/balances/snapshot`.
2. Aba **Saldos** com lista e estados OK/divergente.
3. Derivação automática a partir de AccountMaps BANK.

### Fase C — Ajuste + maps de investment
1. `POST /api/balances/adjust` + modal.
2. Seção Configurações: mapear investments (Cofrinho, XP).
3. Agrupamento many→1 na UI.

### Fase D (opcional)
1. Opt-out fino por fonte.
2. Histórico local de ajustes.
3. Incluir `automaticallyInvestedBalance` como fonte separada.

---

## 9. Critérios de pronto (v1)

- [ ] Conta corrente mapeada mostra OF vs Organizze e diff.
- [ ] Investment (ex. cofrinho) mapeado para conta Organizze entra no snapshot.
- [ ] Vários investments → mesma conta Organizze somam no OF.
- [ ] Um clique cria lançamento que zera (ou reduz) a diferença.
- [ ] Mobile usável (mesmo padrão da fila).
- [ ] Typecheck API + web ok.

---

## 10. Arquivos tocados (previsto)

**API:** `organizze.service/types`, `pluggy.service/controller`, `settings.types/controller`, novo `balances/` (module/service/controller), `app.module`.

**Web:** `App.tsx` (nav + view), novo `BalancesView.tsx`, trecho de maps em settings, `App.css`.
