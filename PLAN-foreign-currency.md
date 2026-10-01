# PLAN: Moeda estrangeira na conciliação (USD vs BRL)

## Problema
Compra em dólar (ex.: Cs.Money) aparece como **-R$ 27,90**. Usuário não vê que foi USD.

## Causa
Em `mapPluggyTransaction` usamos só `tx.amount` e a UI sempre chama `formatBRL(...)`.

Segundo a Pluggy:
- `currencyCode` = moeda da transação (ex. `USD`)
- `amount` = valor nessa moeda
- `amountInAccountCurrency` = valor na moeda da conta (BRL), **só quando for diferente**

Organizze é em BRL: matching/criação devem usar o valor da conta; a UI deve mostrar o original.

## Proposta
1. API: persistir `currencyCode`, `amountInAccountCurrencyCents`; calcular `organizzeAmountCents` com `amountInAccountCurrency ?? amount`.
2. UI: se `currencyCode !== 'BRL'`, mostrar valor original (ex. `US$ 5,00`) e, se houver, o BRL abaixo (`≈ R$ 27,90`); badge da moeda.
3. Modal criar/ignorar: mesmo critério.

## Teste
- [ ] Compra USD com `amountInAccountCurrency`: mostra USD + BRL; Vincular usa BRL
- [ ] Compra só BRL: UI igual a antes
- [ ] `tsc` ok (api + web)
