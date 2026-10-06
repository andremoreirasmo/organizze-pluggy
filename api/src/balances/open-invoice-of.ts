import type { Transaction } from 'pluggy-sdk';

function toIsoDate(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    return value.slice(0, 10);
  }
  return value.toISOString().slice(0, 10);
}

function monthKeyFromIso(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** Shift YYYY-MM-DD by whole months (clamps day to month length). */
export function shiftIsoMonths(isoDate: string, delta: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  if (!year || !month || !day) {
    return isoDate;
  }
  const absolute = year * 12 + (month - 1) + delta;
  const nextYear = Math.floor(absolute / 12);
  const nextMonth = (absolute % 12) + 1;
  const lastDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
  const nextDay = Math.min(day, lastDay);
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(nextDay).padStart(2, '0')}`;
}

const INSTALLMENT_SLASH_RE =
  /(?:^|[\s\-–])(?:parc(?:ela)?\.?\s*)?(\d{1,2})\s*\/\s*(\d{1,2})(?:\s|$)/i;
const INSTALLMENT_DE_RE = /(\d{1,2})\s*de\s*(\d{1,2})/i;

export function installmentFromDescription(
  description: string,
): { installment: number; totalInstallments: number } | null {
  const slash = description.match(INSTALLMENT_SLASH_RE);
  if (slash) {
    const installment = Number(slash[1]);
    const totalInstallments = Number(slash[2]);
    if (
      installment > 0 &&
      totalInstallments > 1 &&
      installment <= totalInstallments
    ) {
      return { installment, totalInstallments };
    }
  }
  const de = description.match(INSTALLMENT_DE_RE);
  if (de) {
    const installment = Number(de[1]);
    const totalInstallments = Number(de[2]);
    if (
      installment > 0 &&
      totalInstallments > 1 &&
      installment <= totalInstallments
    ) {
      return { installment, totalInstallments };
    }
  }
  return null;
}

function isPluggyBillPaymentTx(tx: Transaction): boolean {
  const operation = (tx.operationType ?? '').toUpperCase();
  if (
    operation.includes('BILL_PAYMENT') ||
    operation.includes('PAGAMENTO_FATURA')
  ) {
    return true;
  }
  const description = `${tx.description ?? ''} ${tx.category ?? ''}`;
  return /pagamento\s+d[eo]\s+fatura|pagto\.?\s*fatura|pag\.?\s*fatura/i.test(
    description,
  );
}

/**
 * Remaining installment debt after `keepThroughMonth` (YYYY-MM).
 * Uses latest N per purchase; closed-bill rows count toward maxN.
 *
 * Known-good XP open estimate: keepThrough = open due month + 1 calendar month
 * (purchaseDate+(n−1) runs ~1 month ahead of XP statement cycles).
 */
export function sumRemainingInstallmentsAfterDue(
  transactions: Transaction[],
  keepThroughMonth: string,
): { totalCents: number; purchaseCount: number } {
  type Agg = {
    maxN: number;
    totalM: number;
    amountCents: number;
  };
  const byPurchase = new Map<string, Agg>();

  for (const tx of transactions) {
    if (isPluggyBillPaymentTx(tx)) {
      continue;
    }
    const amount = typeof tx.amount === 'number' ? tx.amount : 0;
    if (!Number.isFinite(amount) || amount === 0) {
      continue;
    }
    const meta = tx.creditCardMetadata;
    let installment =
      typeof meta?.installmentNumber === 'number' && meta.installmentNumber > 0
        ? meta.installmentNumber
        : null;
    let totalInstallments =
      typeof meta?.totalInstallments === 'number' && meta.totalInstallments > 1
        ? meta.totalInstallments
        : null;
    if (!installment || !totalInstallments) {
      const fromDesc = installmentFromDescription(tx.description ?? '');
      if (fromDesc) {
        installment = fromDesc.installment;
        totalInstallments = fromDesc.totalInstallments;
      }
    }
    if (!installment || !totalInstallments || totalInstallments <= 1) {
      continue;
    }

    const txDate = toIsoDate(tx.date) ?? '';
    const purchaseIso =
      toIsoDate(meta?.purchaseDate) ??
      shiftIsoMonths(txDate, -(installment - 1));
    const amountCents = Math.round(Math.abs(amount) * 100);
    const descKey = (tx.description ?? '').trim().slice(0, 48).toLowerCase();
    // Include amount in key: same merchant/date with different installment
    // sizes are distinct purchases. (Omitting amount under-merged XP series.)
    const key = `${purchaseIso}|${totalInstallments}|${amountCents}|${descKey}`;
    const prev = byPurchase.get(key);
    if (!prev || installment > prev.maxN) {
      byPurchase.set(key, {
        maxN: installment,
        totalM: totalInstallments,
        amountCents,
      });
    }
  }

  let totalCents = 0;
  let purchaseCount = 0;
  for (const [key, agg] of byPurchase) {
    const purchaseIso = key.split('|')[0] ?? '';
    let remainingHits = 0;
    for (let n = agg.maxN + 1; n <= agg.totalM; n += 1) {
      if (!purchaseIso) {
        remainingHits += 1;
        continue;
      }
      const hitMonth = monthKeyFromIso(shiftIsoMonths(purchaseIso, n - 1));
      if (hitMonth > keepThroughMonth) {
        remainingHits += 1;
      }
    }
    if (remainingHits <= 0) {
      continue;
    }
    totalCents += agg.amountCents * remainingHits;
    purchaseCount += 1;
  }
  return { totalCents, purchaseCount };
}

export function keepThroughMonthForOpenInvoice(dueDateIso: string): string {
  return monthKeyFromIso(shiftIsoMonths(dueDateIso, 1));
}

/** Open statement estimate: live balance minus projected post-statement debt. */
export function estimateOpenInvoiceFromBalance(params: {
  accountBalanceCents: number;
  unpaidPriorCents: number;
  remainingInstallmentCents: number;
  minPeelCents?: number;
}): number {
  const {
    accountBalanceCents,
    unpaidPriorCents,
    remainingInstallmentCents,
    minPeelCents = 1,
  } = params;
  if (accountBalanceCents <= 0) {
    return 0;
  }
  if (
    remainingInstallmentCents < minPeelCents ||
    remainingInstallmentCents >= accountBalanceCents
  ) {
    return 0;
  }
  return Math.max(
    0,
    accountBalanceCents - unpaidPriorCents - remainingInstallmentCents,
  );
}

/** Build a minimal credit installment tx for tests. */
export function fixtureInstallmentTx(params: {
  description: string;
  amount: number;
  date: string;
  installment: number;
  totalInstallments: number;
  purchaseDate?: string;
}): Transaction {
  return {
    id: `${params.description}-${params.installment}`,
    description: params.description,
    amount: params.amount,
    date: params.date,
    creditCardMetadata: {
      installmentNumber: params.installment,
      totalInstallments: params.totalInstallments,
      purchaseDate: params.purchaseDate
        ? (new Date(`${params.purchaseDate}T12:00:00.000Z`) as unknown as Date)
        : undefined,
    },
  } as unknown as Transaction;
}
