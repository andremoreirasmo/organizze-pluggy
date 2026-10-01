export type InvestmentAllocationBucket =
  | 'fixed_income'
  | 'stocks'
  | 'fiis'
  | 'funds'
  | 'etf'
  | 'other';

export type InvestmentAllocationSlice = {
  bucket: InvestmentAllocationBucket;
  label: string;
  balanceCents: number;
  percent: number;
};

export type InvestmentConnectionFilter = {
  id: string;
  name: string;
  imageUrl: string | null;
  primaryColor: string | null;
  balanceCents: number;
};

export type InvestmentMaturityItem = {
  id: string;
  name: string;
  subtype: string | null;
  dueDate: string;
  balanceCents: number;
  connectionName: string | null;
};

export type InvestmentOverviewItem = {
  id: string;
  name: string;
  type: string;
  subtype: string | null;
  balanceCents: number;
  amountProfitCents: number | null;
  dueDate: string | null;
  connectionId: string | null;
  connectionName: string | null;
  bucket: InvestmentAllocationBucket;
};

export type InvestmentsOverviewResponse = {
  generatedAt: string;
  totalBalanceCents: number;
  totalProfitCents: number | null;
  allocation: InvestmentAllocationSlice[];
  connections: InvestmentConnectionFilter[];
  maturities: InvestmentMaturityItem[];
  nextMaturityDate: string | null;
  items: InvestmentOverviewItem[];
};
