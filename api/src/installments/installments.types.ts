export type InstallmentScheduleStatus = 'paga' | 'nesta_fatura' | 'pendente';

export type InstallmentScheduleEntry = {
  date: string;
  monthKey: string;
  installment: number;
  totalInstallments: number;
  amountCents: number;
  paid: boolean;
  status: InstallmentScheduleStatus;
  transactionId: number;
};

export type InstallmentPurchase = {
  id: string;
  /** Stable soft key used to ignore/restore across months. */
  ignoreKey: string;
  ignored: boolean;
  description: string;
  creditCardId: number;
  creditCardName: string;
  installmentAmountCents: number;
  totalAmountCents: number;
  remainingCents: number;
  paidCount: number;
  totalInstallments: number;
  currentInstallment: number;
  purchaseMonthKey: string | null;
  endsMonthKey: string | null;
  schedule: InstallmentScheduleEntry[];
};

export type InstallmentMonthBar = {
  monthKey: string;
  label: string;
  amountCents: number;
};

export type InstallmentNextPayoff = {
  purchaseId: string;
  description: string;
  reliefCentsPerMonth: number;
  /** Invoice competence month of the last installment. */
  endsMonthKey: string;
  /** Month the bill with the last installment is paid (competence + 1). */
  paymentMonthKey: string;
  /**
   * First month the charge stops hitting cash-flow (payment + 1).
   * Ex.: última parcela na fatura out (paga em nov) → alívio em dez.
   */
  reliefMonthKey: string;
};

/** Per-month report slice for one bar on the chart. */
export type InstallmentMonthDetail = {
  monthKey: string;
  monthLabel: string;
  focusPaymentMonth: string;
  focusPaymentMonthLabel: string;
  committedThisMonthCents: number;
  activePurchaseCount: number;
  ignoredPurchaseCount: number;
  purchases: InstallmentPurchase[];
  ignoredPurchases: InstallmentPurchase[];
  payoffsThisMonth: InstallmentNextPayoff[];
};

export type InstallmentsOverviewResponse = {
  generatedAt: string;
  /** Chart X-axis anchor (always "today" in America/Sao_Paulo). */
  chartAnchorMonth: string;
  /** Suggested selection: query month if on the chart, else anchor. */
  selectedMonth: string;
  monthlyBars: InstallmentMonthBar[];
  /** Detail for every month in `monthlyBars`, keyed by monthKey. */
  months: Record<string, InstallmentMonthDetail>;
};
