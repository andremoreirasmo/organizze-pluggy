# PLAN: Manter dados ao trocar de aba (SPA keep-alive)

## Problema
Trocar Conciliação ↔ Saldos ↔ Relatórios ↔ Config “zera” a tela e força novo fetch. Parece app frágil, não webapp.

## Causa (pesquisa)
Em `App.tsx` a navegação é **condicional com unmount**:

```tsx
{view === 'reconcile' ? <ReconciliationView /> : view === 'balances' ? …}
```

Ao sair da aba o componente some → estado React some → no retorno o `useEffect` de mount dispara de novo.

Em Config, `openSettings` ainda faz `setAppSettings(null)` e recarrega tudo a cada clique.

Dentro de Relatórios, Parcelas/Investimentos já cacheiam (`if (!investments)`); o problema é o unmount do `DashboardView` inteiro.

## Proposta
Padrão **lazy mount + keep-alive** (comum em SPAs/PWAs):

1. Marcar abas já visitadas (`visited[view] = true`).
2. Renderizar cada view visitada sempre; esconder as inativas com `hidden` (sem desmontar).
3. Primeira visita: monta e carrega uma vez.
4. Visitas seguintes: mostra cache em memória; refresh só via botão / pull-to-refresh / mutações.
5. Config: não limpar `appSettings` ao reabrir; carregar só se ainda for `null`.

## Não fazer agora
- Persistência em `localStorage` / Service Worker (opcional depois).
- Background refetch automático por TTL (pode vir depois se fizer falta).
- Remount forçado após salvar mapeamentos (hoje `loadHomeData` já atualiza estado em App; views keep-alive podem ficar stale até pull — aceitável; se necessário, invalidar depois).

## Teste
- [ ] Abrir Fila → Saldos → Fila: dados e mês permanecem, sem “Carregando…”
- [ ] Relatórios: voltar mantém mês e lista
- [ ] Config: segunda abertura não pisca lista vazia
- [ ] Pull-to-refresh / Atualizar ainda recarrega
- [ ] `tsc --noEmit` ok
