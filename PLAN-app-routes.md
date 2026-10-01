# PLAN: Rotas reais (estilo Angular Router)

## Problema
Hoje a “navegação” é `?view=…` + History API caseira. O usuário quer rotas de verdade, como no Angular (`/conciliacao`, `/saldos`, …), com URL compartilável e F5 estável.

## Proposta
Adicionar **`react-router-dom`**:

| Path | Tela |
|------|------|
| `/` | redirect → `/conciliacao` |
| `/conciliacao` | Fila (+ query `month`, `account`, `kind`, `q`) |
| `/saldos` | Saldos |
| `/relatorios` | Relatórios (+ `section`, `month`) |
| `/configuracoes` | Config (+ `tab`) |

- Keep-alive atual preservado: panes `hidden` conforme `useLocation().pathname`
- Nav usa `navigate()`; filtros usam `useSearchParams`
- Remover `writeAppUrl` / `useAppUrlPop` manuais
- Vite already SPA em dev; doc: host precisa fallback `index.html`

## Teste
- [x] `/conciliacao?month=2026-09` F5 ok
- [x] Trocar aba muda path e histórico
- [x] Filtros atualizam query string
- [x] `tsc` ok
