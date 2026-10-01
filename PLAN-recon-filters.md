# PLAN: Filtros da conciliação (estilo Organizze)

## Problema
Com muitos lançamentos no mês, falta filtrar a fila (ex.: só um cartão/conta).

## Referência UX
Barra pill cinza-clara com dropdowns (“Tipo”, “Categorias”…) + botão circular de busca.

## Proposta (v1)
Na fila, abaixo do hero / banners:

1. **Barra** `.recon-filters`:
   - **Conta** — opções derivadas dos itens da fila (apelido · final)
   - **Tipo** — Todos / Conta / Cartão / Fatura / Transferência
   - Botão circular **busca** que abre input de texto (descrição/categoria)
2. Filtrar `queue.items` no cliente (`useMemo`); contador “X de Y”.
3. Sem mudança de API.

## Teste
- [ ] Conta/Tipo/busca reduzem a lista
- [ ] “Todos” limpa filtros
- [ ] Mobile: barra rolável horizontal se preciso
- [ ] `tsc` ok
