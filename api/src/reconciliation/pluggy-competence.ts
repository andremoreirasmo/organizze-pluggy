import type { Transaction } from 'pluggy-sdk';
import { shiftIsoMonths } from '../balances/open-invoice-of';

/** Align with balances open-invoice installment lookback. */
export const RECON_CREDIT_INSTALLMENT_LOOKBACK_MONTHS = 24;

export function toPluggyIsoDate(
  value: string | Date | null | undefined,
): string | null {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length >= 10 ? trimmed.slice(0, 10) : null;
  }
  return value.toISOString().slice(0, 10);
}

/**
 * Month the OF charge belongs to for reconciliation.
 * Prefer billForecastDate; else purchaseDate+(n−1) for installments; else tx.date.
 */
export function pluggyCompetenceDate(tx: Transaction): string {
  const meta = tx.creditCardMetadata;
  const txDate = toPluggyIsoDate(tx.date) ?? '';

  // Pluggy documents billForecastDate as YYYY-MM (sometimes YYYY-MM-DD).
  const forecastRaw =
    typeof meta?.billForecastDate === 'string'
      ? meta.billForecastDate.trim()
      : '';
  if (forecastRaw.length >= 7) {
    const month = forecastRaw.slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(month)) {
      return forecastRaw.length >= 10
        ? forecastRaw.slice(0, 10)
        : `${month}-01`;
    }
  }

  const installment =
    typeof meta?.installmentNumber === 'number' && meta.installmentNumber > 0
      ? meta.installmentNumber
      : null;
  const totalInstallments =
    typeof meta?.totalInstallments === 'number' && meta.totalInstallments > 1
      ? meta.totalInstallments
      : null;

  if (installment != null && totalInstallments != null) {
    const purchaseIso =
      toPluggyIsoDate(meta?.purchaseDate) ??
      (txDate ? shiftIsoMonths(txDate, -(installment - 1)) : null);
    if (purchaseIso) {
      return shiftIsoMonths(purchaseIso, installment - 1);
    }
  }

  return txDate;
}

export function isDateInInclusiveRange(
  dateIso: string,
  from: string,
  to: string,
): boolean {
  const date = dateIso.slice(0, 10);
  return date >= from.slice(0, 10) && date <= to.slice(0, 10);
}

export function creditLookbackDateFrom(from: string): string {
  return shiftIsoMonths(
    from.slice(0, 10),
    -RECON_CREDIT_INSTALLMENT_LOOKBACK_MONTHS,
  );
}

export type PluggyReconMonthMembership = {
  include: boolean;
  /** Date exposed on the queue row for UI / invoice matching. */
  queueDate: string;
};

/**
 * Belong to the recon month if posting date OR competence falls in range.
 * Keeps same-month purchases visible even when billForecastDate is next month,
 * while still pulling older installment rows whose competence is this month.
 */
export function pluggyReconMonthMembership(
  tx: Transaction,
  from: string,
  to: string,
): PluggyReconMonthMembership {
  const txDate = toPluggyIsoDate(tx.date) ?? '';
  const competence = pluggyCompetenceDate(tx);
  const txIn = Boolean(txDate) && isDateInInclusiveRange(txDate, from, to);
  const competenceIn =
    Boolean(competence) && isDateInInclusiveRange(competence, from, to);

  if (!txIn && !competenceIn) {
    return { include: false, queueDate: competence || txDate };
  }

  // Prefer posting date when it is in-month (legacy UX for "hoje" / purchase day).
  // Use competence when the row was pulled in only via lookback.
  return {
    include: true,
    queueDate: txIn ? txDate : competence,
  };
}
