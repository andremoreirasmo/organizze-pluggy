export type CustomRecurringKindDto = 'EXPENSE' | 'INCOME';
export type CustomRecurringUnitDto = 'DAY' | 'WEEK' | 'MONTH';

export type CustomRecurringOccurrenceDto = {
  id: string;
  index: number;
  scheduledDate: string;
  amountCents: number;
  organizzeTransactionId: number | null;
  status: 'PENDING' | 'CREATED' | 'FAILED';
  lastError: string | null;
};

export type CustomRecurringSeriesSummaryDto = {
  id: string;
  kind: CustomRecurringKindDto;
  description: string;
  amountCents: number;
  accountId: number;
  categoryId: number | null;
  tags: string[];
  startDate: string;
  endDate: string;
  intervalUnit: CustomRecurringUnitDto;
  intervalCount: number;
  status: 'ACTIVE' | 'CANCELLED';
  createdCount: number;
  failedCount: number;
  totalCount: number;
  totalAmountCents: number;
  createdAt: string;
  updatedAt: string;
};

export type CustomRecurringSeriesDetailDto = CustomRecurringSeriesSummaryDto & {
  occurrences: CustomRecurringOccurrenceDto[];
};

export type CreateCustomRecurringBody = {
  kind: CustomRecurringKindDto;
  description: string;
  amountCents: number;
  accountId: number;
  categoryId?: number | null;
  tags?: string[];
  startDate: string;
  endDate: string;
  intervalUnit: CustomRecurringUnitDto;
  intervalCount: number;
};

/** Edit only extends/trims the series via end date (keeps cadence & past txs). */
export type UpdateCustomRecurringBody = {
  endDate: string;
};

export type PreviewCustomRecurringBody = {
  startDate: string;
  endDate: string;
  intervalUnit: CustomRecurringUnitDto;
  intervalCount: number;
  amountCents: number;
  kind: CustomRecurringKindDto;
};
