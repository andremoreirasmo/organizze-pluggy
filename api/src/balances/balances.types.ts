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

export type BalanceSnapshotResponse = {
  generatedAt: string;
  toleranceCents: number;
  investmentsFound: number;
  rows: BalanceSnapshotRow[];
  /** Investments that could not be auto-attached (no unique bank map for the item). */
  unmappedInvestments: UnmappedInvestment[];
};

/** Any non-zero difference counts as diverged. */
export const BALANCE_TOLERANCE_CENTS = 0;
