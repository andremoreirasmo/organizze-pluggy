# PLAN: UX da Config alinhada às outras telas

## Problema
Config parece “admin cru”: 3 painéis longos empilhados, `window.prompt` para renomear, ícone abre expander no meio da lista, pouco feedback de status. Relatórios/Saldos/Fila já têm shell, cards e sheets.

## Pesquisa
- Relatórios: `reports-shell` + header + tabs + body
- Saldos: cards com badge de status
- Config hoje: `panel` genérico ×3, ações densas, picker aninhado, sem refresh visível no header

## Proposta
1. **Shell com abas**: Bancos | Contas | Saldos (uma seção por vez, como Parcelas/Investimentos).
2. **Header**: título “Configurações”, botão Atualizar, CTA “Adicionar” na aba Bancos.
3. **Bancos em cards**: avatar, nome, status do ícone; ações Renomear / Ícone / Excluir.
4. **Sheets**: renomear e trocar ícone via `BottomSheet` (sem `prompt`, sem nested picker).
5. **Contas/Saldos**: cards com badge (Mapeado / Ignorado / Pendente); selects no fluxo do card.
6. CSS `settings-shell` espelhando `reports-*` / `balance-card`.

## Teste
- [ ] Abas trocam seção sem scroll infinito
- [ ] Renomear/ícone abrem sheet; salvar funciona
- [ ] Mobile: botões e selects usáveis
- [ ] Pull-to-refresh e Atualizar recarregam
- [ ] `tsc --noEmit` ok
