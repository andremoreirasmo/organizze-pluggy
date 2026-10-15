import type {
  OrganizzeBalancePeriod,
  OrganizzeBalancesResponse,
  OrganizzePeriodCashflow,
} from './organizze.types';

type BalanceTotals = Pick<
  OrganizzeBalancesResponse,
  'incomes' | 'expenses'
> & {
  predicted_incomes?: number;
  predicted_expenses?: number;
};

/**
 * Period income from Organizze `/balances`.
 * `predicted_incomes` is the full period total (already includes realized);
 * `incomes` is only the paid subset. Never sum the two — that double-counts.
 */
export function cashflowIncomeCents(row: BalanceTotals): number {
  const paid = typeof row.incomes === 'number' ? row.incomes : 0;
  const predicted =
    typeof row.predicted_incomes === 'number' ? row.predicted_incomes : 0;
  return Math.round(Math.max(Math.abs(predicted), Math.abs(paid)));
}

/**
 * Period expense from Organizze `/balances` (positive cents).
 * Same rule as income: prefer `predicted_expenses` (full total), not paid+predicted.
 */
export function cashflowExpenseCents(row: BalanceTotals): number {
  const paid = typeof row.expenses === 'number' ? row.expenses : 0;
  const predicted =
    typeof row.predicted_expenses === 'number' ? row.predicted_expenses : 0;
  return Math.round(Math.max(Math.abs(predicted), Math.abs(paid)));
}

export function periodMonthKey(
  period: Pick<OrganizzeBalancePeriod, 'date' | 'date_range'>,
): string | null {
  if (typeof period.date === 'string' && /^\d{4}-\d{2}/.test(period.date)) {
    return period.date.slice(0, 7);
  }
  if (
    typeof period.date_range === 'string' &&
    /^\d{4}-\d{2}/.test(period.date_range)
  ) {
    return period.date_range.slice(0, 7);
  }
  return null;
}

export function sumCashflows(
  rows: OrganizzePeriodCashflow[],
): OrganizzePeriodCashflow {
  return rows.reduce(
    (acc, row) => ({
      incomeCents: acc.incomeCents + row.incomeCents,
      expenseCents: acc.expenseCents + row.expenseCents,
    }),
    { incomeCents: 0, expenseCents: 0 },
  );
}
