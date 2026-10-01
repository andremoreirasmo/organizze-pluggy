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

export type InstallmentsOverviewResponse = {
  generatedAt: string;
  focusMonth: string;
  focusMonthLabel: string;
  /** Payment month for the focus invoice (fatura set → paga em out). */
  focusPaymentMonth: string;
  focusPaymentMonthLabel: string;
  committedThisMonthCents: number;
  activePurchaseCount: number;
  monthlyBars: InstallmentMonthBar[];
  /** Soonest purchase by payment month. */
  nextPayoff: InstallmentNextPayoff | null;
  /** Purchases whose last invoice competence is the focus month. */
  payoffsThisMonth: InstallmentNextPayoff[];
  purchases: InstallmentPurchase[];
};
