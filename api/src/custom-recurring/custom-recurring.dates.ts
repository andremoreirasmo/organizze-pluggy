export type RecurringIntervalUnit = 'DAY' | 'WEEK' | 'MONTH';

export const CUSTOM_RECURRING_MAX_OCCURRENCES = 104;

/** Parse YYYY-MM-DD as UTC midnight. */
export function parseIsoDateOnly(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) {
    throw new Error(`Invalid date: ${iso}`);
  }
  return new Date(Date.UTC(year, month - 1, day));
}

export function toIsoDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysInMonthUtc(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Add whole calendar units; MONTH clamps day to month length. */
export function addInterval(
  date: Date,
  count: number,
  unit: RecurringIntervalUnit,
): Date {
  if (count <= 0) {
    throw new Error('interval count must be positive');
  }
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  if (unit === 'DAY') {
    return new Date(Date.UTC(year, month, day + count));
  }
  if (unit === 'WEEK') {
    return new Date(Date.UTC(year, month, day + count * 7));
  }
  const absolute = year * 12 + month + count;
  const nextYear = Math.floor(absolute / 12);
  const nextMonth = absolute % 12;
  const lastDay = daysInMonthUtc(nextYear, nextMonth);
  return new Date(Date.UTC(nextYear, nextMonth, Math.min(day, lastDay)));
}

/**
 * Inclusive date schedule from start..end stepping by interval.
 * Caps at CUSTOM_RECURRING_MAX_OCCURRENCES.
 */
export function generateOccurrenceDates(params: {
  startDateIso: string;
  endDateIso: string;
  intervalCount: number;
  intervalUnit: RecurringIntervalUnit;
  maxOccurrences?: number;
}): string[] {
  const max = params.maxOccurrences ?? CUSTOM_RECURRING_MAX_OCCURRENCES;
  if (params.intervalCount < 1) {
    throw new Error('intervalCount must be >= 1');
  }
  const start = parseIsoDateOnly(params.startDateIso);
  const end = parseIsoDateOnly(params.endDateIso);
  if (end.getTime() < start.getTime()) {
    throw new Error('endDate must be on or after startDate');
  }
  const dates: string[] = [];
  let cursor = start;
  while (cursor.getTime() <= end.getTime() && dates.length < max) {
    dates.push(toIsoDateOnly(cursor));
    cursor = addInterval(cursor, params.intervalCount, params.intervalUnit);
  }
  if (
    dates.length >= max &&
    cursor.getTime() <= end.getTime()
  ) {
    throw new Error(
      `Series would exceed ${max} occurrences; shorten the end date or widen the interval`,
    );
  }
  return dates;
}

export function signedAmountCents(
  kind: 'EXPENSE' | 'INCOME',
  amountCents: number,
): number {
  const abs = Math.abs(Math.round(amountCents));
  return kind === 'EXPENSE' ? -abs : abs;
}
