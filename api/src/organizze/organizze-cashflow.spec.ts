import {
  cashflowExpenseCents,
  cashflowIncomeCents,
  periodMonthKey,
  sumCashflows,
} from './organizze-cashflow';

describe('organizze-cashflow', () => {
  it('uses predicted income as full period total (does not add paid)', () => {
    // Future month — only predicted.
    expect(
      cashflowIncomeCents({
        incomes: 0,
        predicted_incomes: 2_154_930,
        expenses: 0,
      }),
    ).toBe(2_154_930);
    // Current month — predicted already includes realized (Oz UI).
    expect(
      cashflowIncomeCents({
        incomes: 982_691,
        predicted_incomes: 1_847_621,
        expenses: 0,
      }),
    ).toBe(1_847_621);
    // Fully paid account — predicted === paid; must not double.
    expect(
      cashflowIncomeCents({
        incomes: 84_573,
        predicted_incomes: 84_573,
        expenses: 0,
      }),
    ).toBe(84_573);
  });

  it('uses predicted expense as full period total (does not add paid)', () => {
    expect(
      cashflowExpenseCents({
        incomes: 0,
        expenses: 0,
        predicted_expenses: -1_338_775,
      }),
    ).toBe(1_338_775);
    // Oct-style: predicted covers paid + remaining; never sum.
    expect(
      cashflowExpenseCents({
        incomes: 0,
        expenses: -1_338_214,
        predicted_expenses: -1_553_773,
      }),
    ).toBe(1_553_773);
    expect(
      cashflowExpenseCents({
        incomes: 0,
        expenses: -6_157,
        predicted_expenses: -6_157,
      }),
    ).toBe(6_157);
  });

  it('matches Organizze Oct UI totals when aggregating accounts', () => {
    const accounts = [
      {
        incomes: 982_691,
        predicted_incomes: 1_847_621,
        expenses: -1_338_214,
        predicted_expenses: -1_553_773,
      },
      {
        incomes: 0,
        predicted_incomes: 0,
        expenses: -6_157,
        predicted_expenses: -6_157,
      },
      {
        incomes: 84_573,
        predicted_incomes: 84_573,
        expenses: 0,
        predicted_expenses: 0,
      },
    ];
    const income = accounts.reduce((s, a) => s + cashflowIncomeCents(a), 0);
    const expense = accounts.reduce((s, a) => s + cashflowExpenseCents(a), 0);
    expect(income).toBe(1_932_194); // receita prevista UI
    expect(expense).toBe(1_559_930); // despesa prevista UI
  });

  it('reads month key from period date', () => {
    expect(periodMonthKey({ date: '2026-11-01' })).toBe('2026-11');
    expect(
      periodMonthKey({ date: '', date_range: '2026-11-01-2026-11-30' }),
    ).toBe('2026-11');
  });

  it('aggregates per-account cashflows', () => {
    expect(
      sumCashflows([
        { incomeCents: 100, expenseCents: 40 },
        { incomeCents: 50, expenseCents: 10 },
      ]),
    ).toEqual({ incomeCents: 150, expenseCents: 50 });
  });
});
