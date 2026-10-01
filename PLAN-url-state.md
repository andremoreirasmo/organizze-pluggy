# PLAN: Estado na URL + histórico do browser

## Problema
F5 ou voltar no browser perde aba, mês e filtros da conciliação. Não parece webapp.

## Contexto
- Sem `react-router`; navegação é `useState` em `App` + keep-alive.
- Estado relevante: `view`, mês da fila, filtros (conta/tipo/q), seção/mês dos Relatórios, aba da Config.

## Proposta
Util `urlState.ts` + History API (sem nova dependência):

| Param | Uso |
|-------|-----|
| `view` | reconcile \| balances \| dashboard \| settings |
| `month` | YYYY-MM (fila e/ou relatórios) |
| `account` | filtro conta |
| `kind` | filtro tipo |
| `q` | busca |
| `section` | installments \| investments |
| `tab` | banks \| accounts \| balances (config) |

- **pushState**: troca de aba, mês, conta, tipo, section, tab
- **replaceState**: digitação em `q` (debounce)
- **popstate**: reidrata React
- **F5**: `useState(() => readFromUrl())`
- Login: respeitar `view` da URL; se `settings`, carregar config

## Teste
- [ ] F5 em `/?view=reconcile&month=2026-09&kind=credit_purchase` restaura
- [ ] Voltar no browser muda aba/filtros
- [ ] Digitar busca não enche o histórico
- [ ] `tsc` ok
