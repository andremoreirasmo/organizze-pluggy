export type OrganizzeAccount = {
  id: number;
  name: string;
  description: string | null;
  archived: boolean;
  type: string;
  institutionName?: string | null;
  institutionImageUrl?: string | null;
  institutionPrimaryColor?: string | null;
};

/** One period row inside GET /balances (monetary fields are integers in cents). */
export type OrganizzeBalancePeriod = {
  date: string;
  date_range?: string;
  outcomes: number;
  predicted_outcomes?: number;
  incomes: number;
  predicted_incomes?: number;
  expenses: number;
  predicted_expenses?: number;
  earnings: number;
  predicted_earnings?: number;
  transferences?: number;
  predicted_transferences?: number;
  credit_card_invoices_to_pay?: number;
  balance?: number;
  predicted_balance?: number;
};

/** Response from GET /balances (monetary fields are integers in cents). */
export type OrganizzeBalancesResponse = {
  previous_balance: number;
  previous_predicted_balance: number;
  balance: number;
  predicted_balance: number;
  outcomes: number;
  predicted_outcomes?: number;
  incomes: number;
  predicted_incomes?: number;
  expenses: number;
  predicted_expenses?: number;
  earnings: number;
  predicted_earnings?: number;
  result: number;
  predicted_result?: number;
  balances?: OrganizzeBalancePeriod[];
};

/** Aggregated Oz cashflow for a date range (all launches as efetivado). */
export type OrganizzePeriodCashflow = {
  incomeCents: number;
  expenseCents: number;
};

export type OrganizzeCategoryKind = 'expenses' | 'earnings' | 'none';

export type OrganizzeCategory = {
  id: number;
  name: string;
  color: string | number | null;
  parent_id: number | null;
  group_id: string | number | null;
  kind?: OrganizzeCategoryKind | string | null;
  archived?: boolean;
  uuid?: string | null;
  fixed?: boolean;
  essential?: boolean;
  default?: boolean;
};

export type OrganizzeTag = {
  name: string;
};

export type OrganizzeTransaction = {
  id: number;
  description: string;
  date: string;
  paid: boolean;
  amount_cents: number;
  total_installments: number;
  installment: number;
  recurring: boolean;
  account_id: number | null;
  category_id: number | null;
  notes: string | null;
  credit_card_id: number | null;
  credit_card_invoice_id: number | null;
  paid_credit_card_id: number | null;
  paid_credit_card_invoice_id: number | null;
  recurrence_id?: number | null;
  account_type?: string | null;
  type?: string | null;
  oposite_transaction_id?: number | null;
  oposite_account_id?: number | null;
  tags?: OrganizzeTag[];
};

export type CreateOrganizzeTransferPayload = {
  description?: string;
  date: string;
  amount_cents: number;
  debit_account_id: number;
  credit_account_id: number;
  paid?: boolean;
  notes?: string | null;
  category_id?: number | null;
};

export type OrganizzeCreditCard = {
  id: number;
  name: string;
  description: string | null;
  card_network: string | null;
  limit_cents: number | null;
  closing_day: number | null;
  due_day: number | null;
  archived: boolean;
  /** Conta bancária padrão para pagar a fatura deste cartão (Organizze). */
  payment_account_id?: number | null;
};

export type OrganizzeInvoice = {
  id: number;
  date: string;
  starting_date: string;
  closing_date: string;
  amount_cents: number;
  payment_amount_cents: number;
  balance_cents: number;
  previous_balance_cents: number;
  credit_card_id: number;
  transactions?: OrganizzeTransaction[];
  payments?: OrganizzeTransaction[];
};

export type CreateOrganizzeInstallmentsAttributes = {
  periodicity: 'monthly';
  total: number;
};

export type CreateOrganizzeTransactionPayload = {
  description: string;
  date: string;
  amount_cents: number;
  paid?: boolean;
  notes?: string | null;
  category_id?: number | null;
  account_id?: number | null;
  credit_card_id?: number | null;
  credit_card_invoice_id?: number | null;
  recurring?: boolean;
  total_installments?: number;
  installment?: number;
  /** Creates a monthly installment series (Organizze ignores total_installments for this). */
  installments_attributes?: CreateOrganizzeInstallmentsAttributes;
  tags?: OrganizzeTag[];
};

export type UpdateOrganizzeTransactionPayload = {
  description?: string;
  date?: string;
  amount_cents?: number;
  paid?: boolean;
  notes?: string | null;
  category_id?: number | null;
  account_id?: number | null;
  credit_card_id?: number | null;
  credit_card_invoice_id?: number | null;
  update_future?: boolean;
  update_all?: boolean;
  tags?: OrganizzeTag[];
};

export type CreateInvoicePaymentPayload = {
  account_id: number;
  amount_cents: number;
  date: string;
  notes?: string | null;
  category_id?: number | null;
  joined_tags?: string;
};
