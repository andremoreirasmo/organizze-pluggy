# PLAN: Pull-to-refresh (swipe to refresh) no app

## Problema
No mobile, atualizar dados exige achar o botão “Atualizar”. Sheets já têm swipe-to-dismiss; falta o gesto nativo de puxar para atualizar nas telas principais.

## Pesquisa / contexto atual
- Scroll principal é o **documento** (`body`/`window`), não um container interno (`.content` só limita largura).
- Cada view já tem reload explícito:
  - **Conciliação** → `loadQueue()`
  - **Saldos** → `loadSnapshot()`
  - **Relatórios** → zera `installments`/`investments` e o `useEffect` recarrega
  - **Config** → `loadConfig` + `loadHomeData` (+ institutions)
- Já existe `useSwipeDismiss` para sheets (touch non-passive, respeita `scrollTop`). PTR não deve conflitar: sheets usam `body { overflow: hidden }` e overlay próprio.
- Gestos horizontais (pills de meses, listas) precisam ser ignorados (mesmo critério `dx > dy`).

## Proposta
1. Hook `usePullToRefresh` + wrapper `PullToRefresh`:
   - Ativa só com 1 dedo, `window.scrollY ≈ 0`, `disabled`/`refreshing` off.
   - Distância com resistance (rubber band); limiar ~72px ou velocidade.
   - Indicador visual (spinner / seta) no topo; `overscroll-behavior-y: contain` no root PTR.
   - `onRefresh` async; mantém indicador até a Promise resolver.
2. Aplicar nas 4 superfícies autenticadas (recon, saldos, relatórios, config).
3. Botões “Atualizar” existentes permanecem (desktop / acessibilidade).

## Fora de escopo
- Refresh nativo do browser (MeuPluggy sync).
- PTR dentro de BottomSheets (já têm dismiss).
- Mouse/drag desktop.

## Teste
- [ ] Mobile: puxar no topo de cada aba recarrega e mostra indicador
- [ ] Scroll no meio da página não dispara PTR
- [ ] Sheet aberto: swipe fecha o sheet, não recarrega a lista
- [ ] Gestos horizontais nas pills não disparam PTR
- [ ] `tsc --noEmit` ok
