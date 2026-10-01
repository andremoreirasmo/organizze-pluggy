# Painel: Parcelas + Investimentos

## Contexto

App de conciliação Open Finance ↔ Organizze. Usuário quer visualizações no estilo Organizze (prints) sem misturar com a fila de conciliação.

## Decisão

- Uma aba **Painel** no topbar.
- Seções internas: **Parcelas** | **Investimentos**.
- Só leitura.
- Investimentos = Pluggy (com `dueDate`, alocação por type/subtype).
- Parcelas = Organizze (`total_installments > 1` + cartão).
- Sem série histórica inventada de patrimônio.

## APIs

- `GET /api/investments/overview`
- `GET /api/installments/overview?month=YYYY-MM`

## Aceite

- Painel separado do core OF
- UI próxima dos prints
- Typecheck OK
