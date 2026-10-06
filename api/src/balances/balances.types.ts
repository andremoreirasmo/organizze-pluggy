export type BalanceSnapshotSource = {
  sourceKey: string;
  sourceKind: 'account' | 'investment' | 'reserved';
  pluggySourceId: string;
  label: string;
  balanceCents: number;
  connectionName: string | null;
  /** False when the user opted out via balanceMaps.enabled = false. */
  included: boolean;
};

export type BalanceSnapshotRow = {
  organizzeAccountId: number;
  organizzeAccountName: string;
  organizzeBalanceCents: number;
  openFinanceBalanceCents: number;
  diffCents: number;
  status: 'ok' | 'diverged';
  sources: BalanceSnapshotSource[];
};

export type UnmappedInvestment = {
  id: string;
  name: string;
  balanceCents: number;
  type: string;
  subtype: string | null;
  connectionName: string | null;
  itemId: string;
};

export type UnmappedCreditAccount = {
  id: string;
  name: string;
  balanceCents: number;
  connectionName: string | null;
};

/**
 * Closed credit-card bill (fatura) compare:
 * Pluggy Bills `totalAmount` vs Organizze invoice `amount_cents`.
 */
export type InvoiceBalanceRow = {
  organizzeCreditCardId: number;
  organizzeCreditCardName: string;
  pluggyAccountId: string;
  pluggyAccountName: string;
  pluggyBillId: string | null;
  /** Bill total from Pluggy Bills API (not Account.balance). */
  pluggyBillTotalCents: number | null;
  pluggyBillDueDate: string | null;
  pluggyBillCloseDate: string | null;
  pluggyMinimumPaymentCents: number | null;
  /** How many Pluggy bills were returned for this credit account. */
  pluggyBillsFound: number;
  /** Where the OF total came from, when matched. */
  pluggyMatchOrigin: 'bill' | 'account_balance' | 'transactions_sum' | null;
  /** Short reason when OF could not be matched (or empty cycle). */
  pluggyMatchHint: string | null;
  /** Closed vs open Organizze cycle for this row. */
  invoiceCycle: 'closed' | 'open' | null;
  invoiceId: number | null;
  invoiceDueDate: string | null;
  invoiceStartingDate: string | null;
  invoiceClosingDate: string | null;
  /** Invoice total in Organizze. */
  organizzeAmountCents: number | null;
  organizzePaymentCents: number | null;
  organizzeBalanceCents: number | null;
  /** pluggyBillTotalCents − organizzeAmountCents */
  diffCents: number | null;
  /** How many Oz invoice txs were ignored (date > today) when excludeFutureOz. */
  organizzeExcludedFutureCount: number;
  status:
    | 'ok'
    | 'diverged'
    | 'open_pending'
    | 'empty'
    | 'no_invoice'
    | 'no_pluggy_bill';
};

export type BalanceSnapshotResponse = {
  generatedAt: string;
  toleranceCents: number;
  /** Snapshot was computed excluding Oz txs with date after today. */
  excludeFutureOz: boolean;
  investmentsFound: number;
  rows: BalanceSnapshotRow[];
  /** Investments that could not be auto-attached (no unique bank map for the item). */
  unmappedInvestments: UnmappedInvestment[];
  invoiceRows: InvoiceBalanceRow[];
  unmappedCreditAccounts: UnmappedCreditAccount[];
};

/** Any non-zero difference counts as diverged. */
export const BALANCE_TOLERANCE_CENTS = 0;
