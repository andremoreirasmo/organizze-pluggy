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
};

export type CreateInvoicePaymentPayload = {
  account_id: number;
  amount_cents: number;
  date: string;
  notes?: string | null;
  category_id?: number | null;
  joined_tags?: string;
};
