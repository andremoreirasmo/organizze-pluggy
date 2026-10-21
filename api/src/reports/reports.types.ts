export type CashflowMonthPoint = {
  monthKey: string;
  label: string;
  incomeCents: number;
  expenseCents: number;
  /** income − expense (sobra do mês). */
  leftoverCents: number;
};

export type CashflowYearTotals = {
  incomeCents: number;
  expenseCents: number;
  leftoverCents: number;
};

export type ReportsCashflowOverviewDto = {
  generatedAt: string;
  /** Month used to pick the calendar year / highlight. */
  selectedMonth: string;
  year: number;
  /** Jan–Dec of `year`. */
  months: CashflowMonthPoint[];
  /** Sum of the 12 months: recebido, gasto e diferença. */
  yearTotals: CashflowYearTotals;
  note: string;
};
