import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Account, CreditCardBills, Transaction } from 'pluggy-sdk';
import { OrganizzeService } from '../organizze/organizze.service';
import { normalizeOrganizzeTagNames } from '../organizze/organizze-tags';
import type { OrganizzeInvoice } from '../organizze/organizze.types';
import {
  PluggyService,
  type PluggyInvestmentView,
} from '../pluggy/pluggy.service';
import { SettingsService } from '../settings/settings.service';
import {
  BalanceMap,
  buildBalanceSourceKey,
  buildReservedSourceId,
  isActiveAccountMap,
  parseReservedSourceId,
} from '../settings/settings.types';
import { startPerf } from '../common/perf';
import {
  estimateOpenInvoiceFromBalance,
  keepThroughMonthForOpenInvoice,
  sumRemainingInstallmentsAfterDue,
} from './open-invoice-of';
import {
  BALANCE_TOLERANCE_CENTS,
  BalanceSnapshotResponse,
  BalanceSnapshotRow,
  BalanceSnapshotSource,
  InvoiceBalanceRow,
  UnmappedCreditAccount,
  UnmappedInvestment,
} from './balances.types';

function toIsoDate(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    return value.slice(0, 10);
  }
  return value.toISOString().slice(0, 10);
}

function todayIsoSaoPaulo(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function reaisToCents(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value * 100);
}

function daysBetween(a: string, b: string): number {
  const left = Date.parse(`${a}T12:00:00Z`);
  const right = Date.parse(`${b}T12:00:00Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(left - right) / 86_400_000;
}

/** Signed calendar days from `fromIso` to `toIso` (positive when toIso is later). */
function daysAfter(fromIso: string, toIso: string): number {
  const left = Date.parse(`${fromIso}T12:00:00Z`);
  const right = Date.parse(`${toIso}T12:00:00Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return Number.POSITIVE_INFINITY;
  }
  return (right - left) / 86_400_000;
}

/** Prefer current cycle over old residual unpaid invoices (~2.5 months). */
const RECENT_CLOSED_MAX_AGE_DAYS = 75;
/** Ignore ancient unpaid leftovers when picking a compare invoice. */
const UNPAID_LEGACY_MAX_AGE_DAYS = 90;
const BILL_MATCH_MAX_DAYS = 18;
/** Only when exactly one unpaid OF bill remains and tight window missed. */
const BILL_MATCH_SINGLE_UNPAID_MAX_DAYS = 35;

/** Prefer most recent closed unpaid bill; else latest closed; else nearest upcoming due. */
function isPluggyBillFullyPaid(bill: CreditCardBills): boolean {
  const payments = bill.payments ?? [];
  if (payments.some((payment) => payment.valueType === 'FULL_PAYMENT')) {
    return true;
  }
  const paid = payments.reduce(
    (sum, payment) => sum + Math.abs(payment.amount ?? 0),
    0,
  );
  return paid + 0.009 >= Math.abs(bill.totalAmount);
}

function invoiceIsUnpaid(invoice: OrganizzeInvoice): boolean {
  if (invoice.balance_cents !== 0) {
    return true;
  }
  return invoice.payment_amount_cents === 0;
}

function billDateDistanceToTargets(
  bill: CreditCardBills,
  dueTarget: string,
  closeTarget: string,
): number {
  const due = toIsoDate(bill.dueDate);
  const close = toIsoDate(bill.billClosingDate);
  if (!due) {
    return Number.POSITIVE_INFINITY;
  }
  const dueDist = daysBetween(due, dueTarget);
  const closeDist = close
    ? daysBetween(close, closeTarget)
    : Number.POSITIVE_INFINITY;
  return Math.min(
    Number.isFinite(dueDist) ? dueDist : Number.POSITIVE_INFINITY,
    Number.isFinite(closeDist) ? closeDist : Number.POSITIVE_INFINITY,
  );
}

/** Shift YYYY-MM-DD by whole months (clamps day to month length). */
function shiftIsoMonths(isoDate: string, delta: number): string {
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

/**
 * Distance Oz↔OF. For closed invoices, also try Oz dates shifted −1 month
 * (Mercado Pago–style cycle labels). Never lag-match open invoices — that
 * falsely pairs them with the previous paid bill at “0d”.
 */
function billDateDistanceToInvoice(
  bill: CreditCardBills,
  invoice: OrganizzeInvoice,
  options?: { allowMonthLag?: boolean },
): number {
  const direct = billDateDistanceToTargets(
    bill,
    invoice.date,
    invoice.closing_date,
  );
  if (options?.allowMonthLag === false) {
    return direct;
  }
  const lagged = billDateDistanceToTargets(
    bill,
    shiftIsoMonths(invoice.date, -1),
    shiftIsoMonths(invoice.closing_date, -1),
  );
  return Math.min(direct, lagged);
}

/**
 * Prefer the current closed cycle (even if paid), so an old residual unpaid
 * invoice cannot hijack the compare. Also return the open cycle in progress
 * when it differs — closed is for reconcile/pay; open is what is accumulating.
 */
function pickOrganizzeInvoicesForCompare(
  invoices: OrganizzeInvoice[],
): Array<{ invoice: OrganizzeInvoice; cycle: 'closed' | 'open' }> {
  if (invoices.length === 0) {
    return [];
  }
  const today = todayIsoSaoPaulo();
  const sortedByClose = [...invoices].sort((a, b) => {
    const closeCmp = b.closing_date.localeCompare(a.closing_date);
    if (closeCmp !== 0) {
      return closeCmp;
    }
    return b.date.localeCompare(a.date);
  });

  const recentClosed = sortedByClose.filter((invoice) => {
    if (invoice.closing_date > today) {
      return false;
    }
    return daysAfter(invoice.closing_date, today) <= RECENT_CLOSED_MAX_AGE_DAYS;
  });

  let closed: OrganizzeInvoice | null = recentClosed[0] ?? null;
  if (!closed) {
    const unpaidClosedFresh = sortedByClose.filter((invoice) => {
      if (!invoiceIsUnpaid(invoice) || invoice.closing_date > today) {
        return false;
      }
      return (
        daysAfter(invoice.closing_date, today) <= UNPAID_LEGACY_MAX_AGE_DAYS
      );
    });
    closed = unpaidClosedFresh[0] ?? null;
  }
  if (!closed) {
    closed =
      sortedByClose.find((invoice) => invoice.closing_date <= today) ?? null;
  }

  const open =
    [...invoices]
      .filter((invoice) => invoice.closing_date > today)
      .sort((a, b) => {
        const closeCmp = a.closing_date.localeCompare(b.closing_date);
        if (closeCmp !== 0) {
          return closeCmp;
        }
        return a.date.localeCompare(b.date);
      })[0] ?? null;

  const picked: Array<{ invoice: OrganizzeInvoice; cycle: 'closed' | 'open' }> =
    [];
  if (closed) {
    picked.push({ invoice: closed, cycle: 'closed' });
  }
  if (open && open.id !== closed?.id) {
    picked.push({ invoice: open, cycle: 'open' });
  }
  if (picked.length > 0) {
    return picked;
  }

  const coveringUnpaid = sortedByClose.find(
    (invoice) =>
      invoiceIsUnpaid(invoice) &&
      invoice.starting_date <= today &&
      today <= invoice.closing_date,
  );
  if (coveringUnpaid) {
    return [{ invoice: coveringUnpaid, cycle: 'open' }];
  }

  const nextUnpaid = [...invoices]
    .filter((invoice) => invoiceIsUnpaid(invoice) && invoice.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  const fallback = nextUnpaid[0] ?? sortedByClose[0] ?? null;
  if (!fallback) {
    return [];
  }
  return [
    {
      invoice: fallback,
      cycle: fallback.closing_date <= today ? 'closed' : 'open',
    },
  ];
}

type ScoredBill = {
  bill: CreditCardBills;
  dateDistance: number;
};

/**
 * Match a Pluggy bill to a fixed Organizze invoice by due/close dates
 * (including −1 month lag). Window ~18d avoids pairing adjacent cycles.
 * Fallbacks: single unpaid ≤35d; uniquely nearest bill ≤40d (MP-style offsets).
 */
function scorePluggyBillsForInvoice(
  bills: CreditCardBills[],
  invoice: OrganizzeInvoice,
  options?: { allowMonthLag?: boolean },
): { match: CreditCardBills | null; nearestDistance: number } {
  if (bills.length === 0) {
    return { match: null, nearestDistance: Number.POSITIVE_INFINITY };
  }

  const requireUnpaid = invoiceIsUnpaid(invoice);
  const scored: ScoredBill[] = [];
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const bill of bills) {
    const dateDistance = billDateDistanceToInvoice(bill, invoice, options);
    if (Number.isFinite(dateDistance) && dateDistance < nearestDistance) {
      nearestDistance = dateDistance;
    }
    if (requireUnpaid && isPluggyBillFullyPaid(bill)) {
      continue;
    }
    if (!Number.isFinite(dateDistance) || dateDistance > BILL_MATCH_MAX_DAYS) {
      continue;
    }
    scored.push({ bill, dateDistance });
  }

  scored.sort((a, b) => {
    if (a.dateDistance !== b.dateDistance) {
      return a.dateDistance - b.dateDistance;
    }
    const aClose = toIsoDate(a.bill.billClosingDate) ?? '';
    const bClose = toIsoDate(b.bill.billClosingDate) ?? '';
    return bClose.localeCompare(aClose);
  });

  if (scored[0]) {
    return { match: scored[0].bill, nearestDistance };
  }

  const candidates = bills
    .filter((bill) => !(requireUnpaid && isPluggyBillFullyPaid(bill)))
    .map((bill) => ({
      bill,
      dateDistance: billDateDistanceToInvoice(bill, invoice, options),
    }))
    .filter((entry) => Number.isFinite(entry.dateDistance))
    .sort((a, b) => a.dateDistance - b.dateDistance);

  if (
    requireUnpaid &&
    candidates.length === 1 &&
    candidates[0].dateDistance <= BILL_MATCH_SINGLE_UNPAID_MAX_DAYS
  ) {
    return { match: candidates[0].bill, nearestDistance };
  }

  const UNIQUE_NEAR_MAX_DAYS = 40;
  const UNIQUE_NEAR_GAP_DAYS = 14;
  if (
    candidates[0] &&
    candidates[0].dateDistance <= UNIQUE_NEAR_MAX_DAYS &&
    (candidates.length === 1 ||
      candidates[1].dateDistance - candidates[0].dateDistance >=
        UNIQUE_NEAR_GAP_DAYS)
  ) {
    return { match: candidates[0].bill, nearestDistance };
  }

  return { match: null, nearestDistance };
}

type PluggyInvoiceCompareSource = {
  billId: string | null;
  totalCents: number;
  dueDate: string | null;
  closeDate: string | null;
  minimumPaymentCents: number | null;
  origin: 'bill' | 'account_balance' | 'transactions_sum';
};

type PluggyInvoiceCompareResult = {
  compare: PluggyInvoiceCompareSource | null;
  billsFound: number;
  matchOrigin: 'bill' | 'account_balance' | 'transactions_sum' | null;
  matchHint: string | null;
};

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

const OPEN_BILL_DUE_MAX_DAYS = 18;
/** How far back to scan OF txs for installments that hit the open invoice. */
const OPEN_TX_INSTALLMENT_LOOKBACK_MONTHS = 24;

/**
 * Bill for the open Oz cycle. Match on **due date** near Oz due, or same
 * closing month as Oz (in-progress OF bills). Never reuse a bill already used
 * by the closed row. Never use Account.balance (total debt ≠ this invoice).
 */
function pickPluggyBillForOpenInvoice(
  bills: CreditCardBills[],
  invoice: OrganizzeInvoice,
  excludeBillIds?: Set<string>,
): CreditCardBills | null {
  if (bills.length === 0) {
    return null;
  }

  const competenceMonth = monthKeyFromIso(invoice.closing_date);
  const dueMonth = monthKeyFromIso(invoice.date);

  type Scored = {
    bill: CreditCardBills;
    dueDistance: number;
    unpaid: boolean;
  };
  const scored: Scored[] = [];
  for (const bill of bills) {
    if (excludeBillIds?.has(bill.id)) {
      continue;
    }
    const due = toIsoDate(bill.dueDate);
    if (!due || due < invoice.starting_date) {
      continue;
    }
    const close = toIsoDate(bill.billClosingDate);
    const dueDistance = daysBetween(due, invoice.date);
    const dueMonthMatch = monthKeyFromIso(due) === dueMonth;
    const closeMonthMatch =
      close !== null && monthKeyFromIso(close) === competenceMonth;
    const dueNear =
      Number.isFinite(dueDistance) && dueDistance <= OPEN_BILL_DUE_MAX_DAYS;

    if (!dueNear && !dueMonthMatch && !closeMonthMatch) {
      continue;
    }

    scored.push({
      bill,
      dueDistance: Number.isFinite(dueDistance)
        ? dueDistance
        : Number.POSITIVE_INFINITY,
      unpaid: !isPluggyBillFullyPaid(bill),
    });
  }

  scored.sort((a, b) => {
    if (a.unpaid !== b.unpaid) {
      return a.unpaid ? -1 : 1;
    }
    if (a.dueDistance !== b.dueDistance) {
      return a.dueDistance - b.dueDistance;
    }
    return (toIsoDate(b.bill.billClosingDate) ?? '').localeCompare(
      toIsoDate(a.bill.billClosingDate) ?? '',
    );
  });

  return scored[0]?.bill ?? null;
}

/**
 * Unpaid OF bills already closed (prior cycles). Their totals sit inside
 * Account.balance together with the open statement.
 */
function sumUnpaidPriorBillCents(
  bills: CreditCardBills[],
  today: string,
  excludeBillIds?: Set<string>,
): { totalCents: number; billCount: number } {
  let totalCents = 0;
  let billCount = 0;
  for (const bill of bills) {
    if (excludeBillIds?.has(bill.id)) {
      continue;
    }
    if (isPluggyBillFullyPaid(bill)) {
      continue;
    }
    const close = toIsoDate(bill.billClosingDate);
    if (!close || close > today) {
      continue;
    }
    totalCents += Math.round(Math.abs(bill.totalAmount) * 100);
    billCount += 1;
  }
  return { totalCents, billCount };
}

/**
 * Installments already attributed to statements after this open invoice's due
 * month (billForecastDate). Used to peel future debt off Account.balance.
 */
function sumFutureForecastBeyondOpenInvoice(
  transactions: Transaction[],
  invoice: OrganizzeInvoice,
  excludeBillIds?: Set<string>,
): { totalCents: number; chargeCount: number } {
  const dueMonth = monthKeyFromIso(invoice.date);
  let totalCents = 0;
  let chargeCount = 0;
  for (const tx of transactions) {
    if (isPluggyBillPaymentTx(tx)) {
      continue;
    }
    const amount = typeof tx.amount === 'number' ? tx.amount : 0;
    if (!Number.isFinite(amount) || amount === 0) {
      continue;
    }
    const billId = tx.creditCardMetadata?.billId?.trim();
    if (billId && excludeBillIds?.has(billId)) {
      continue;
    }
    const forecastRaw =
      typeof tx.creditCardMetadata?.billForecastDate === 'string'
        ? tx.creditCardMetadata.billForecastDate.trim()
        : '';
    const forecastMonth =
      forecastRaw.length >= 7 ? forecastRaw.slice(0, 7) : null;
    if (!forecastMonth || forecastMonth <= dueMonth) {
      continue;
    }
    totalCents += Math.round(Math.abs(amount) * 100);
    chargeCount += 1;
  }
  return { totalCents, chargeCount };
}

function summarizeDisaggregatedLimits(
  account: Account,
): string {
  const limits = account.creditData?.disaggregatedCreditLimits ?? [];
  if (limits.length === 0) {
    return 'none';
  }
  return limits
    .map((limit) => {
      const used =
        typeof limit.usedAmount === 'number'
          ? Math.round(Math.abs(limit.usedAmount) * 100)
          : null;
      return `${limit.lineName ?? limit.creditLineLimitType ?? '?'}:${used ?? '-'}`;
    })
    .join(',');
}

function monthKeyFromIso(isoDate: string): string {
  return isoDate.slice(0, 7);
}

const INSTALLMENT_SLASH_RE =
  /(?:^|[\s\-–])(?:parc(?:ela)?\.?\s*)?(\d{1,2})\s*\/\s*(\d{1,2})(?:\s|$)/i;
const INSTALLMENT_DE_RE = /(\d{1,2})\s*de\s*(\d{1,2})/i;

function installmentFromDescription(
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

/**
 * Whether an OF credit transaction belongs on this Oz invoice cycle.
 * Prefer billForecastDate / open billId / installment meta; also parse "3/10"
 * from descriptions (XP often omits structured installment fields).
 */
function pluggyTxBelongsToInvoice(
  tx: Transaction,
  invoice: OrganizzeInvoice,
  endDate: string,
  excludeBillIds?: Set<string>,
): boolean {
  if (isPluggyBillPaymentTx(tx)) {
    return false;
  }
  const amount = typeof tx.amount === 'number' ? tx.amount : 0;
  if (!Number.isFinite(amount) || amount === 0) {
    return false;
  }

  const txDate = toIsoDate(tx.date);
  if (!txDate) {
    return false;
  }

  const meta = tx.creditCardMetadata;
  const billId =
    typeof meta?.billId === 'string' && meta.billId.trim()
      ? meta.billId.trim()
      : null;
  if (billId && excludeBillIds?.has(billId)) {
    return false;
  }

  const competenceMonth = monthKeyFromIso(invoice.closing_date);
  const dueMonth = monthKeyFromIso(invoice.date);

  const forecastRaw =
    typeof meta?.billForecastDate === 'string'
      ? meta.billForecastDate.trim()
      : '';
  const forecastMonth = forecastRaw.length >= 7 ? forecastRaw.slice(0, 7) : null;
  if (forecastMonth) {
    // Strict: a tagged forecast locks the tx to that cycle only.
    return forecastMonth === competenceMonth || forecastMonth === dueMonth;
  }

  // Open-statement txs often share a billId not present in the closed bills list.
  if (billId) {
    const fromDesc = installmentFromDescription(tx.description ?? '');
    const hasInstallmentMeta =
      typeof meta?.installmentNumber === 'number' &&
      typeof meta?.totalInstallments === 'number' &&
      meta.totalInstallments > 1;
    if (
      hasInstallmentMeta ||
      fromDesc ||
      (txDate >= invoice.starting_date && txDate <= endDate)
    ) {
      return true;
    }
  }

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

  if (installment && totalInstallments) {
    const purchaseIso =
      toIsoDate(meta?.purchaseDate) ??
      shiftIsoMonths(txDate, -(installment - 1));
    const hitMonth = monthKeyFromIso(
      shiftIsoMonths(purchaseIso, installment - 1),
    );
    if (hitMonth === competenceMonth || hitMonth === dueMonth) {
      return true;
    }
    if (txDate >= invoice.starting_date && txDate <= endDate) {
      return true;
    }
    return false;
  }

  if (
    (tx.status ?? 'POSTED').toUpperCase() === 'PENDING' &&
    txDate <= endDate
  ) {
    return true;
  }

  return txDate >= invoice.starting_date && txDate <= endDate;
}

function sumPluggyChargesForOpenInvoice(
  transactions: Transaction[],
  invoice: OrganizzeInvoice,
  endDate: string,
  excludeBillIds?: Set<string>,
): {
  totalCents: number;
  chargeCount: number;
  viaForecast: number;
  viaBillId: number;
  viaInstallment: number;
  viaDateWindow: number;
  openBillIdTotalCents: number;
  openBillIdCount: number;
} {
  const byOpenBillId = new Map<
    string,
    { totalCents: number; chargeCount: number }
  >();
  for (const tx of transactions) {
    if (isPluggyBillPaymentTx(tx)) {
      continue;
    }
    const amount = typeof tx.amount === 'number' ? tx.amount : 0;
    if (!Number.isFinite(amount) || amount === 0) {
      continue;
    }
    const billId = tx.creditCardMetadata?.billId?.trim();
    if (!billId || excludeBillIds?.has(billId)) {
      continue;
    }
    const entry = byOpenBillId.get(billId) ?? {
      totalCents: 0,
      chargeCount: 0,
    };
    entry.totalCents += Math.round(Math.abs(amount) * 100);
    entry.chargeCount += 1;
    byOpenBillId.set(billId, entry);
  }

  let openBillIdTotalCents = 0;
  let openBillIdCount = 0;
  for (const entry of byOpenBillId.values()) {
    if (entry.totalCents > openBillIdTotalCents) {
      openBillIdTotalCents = entry.totalCents;
      openBillIdCount = entry.chargeCount;
    }
  }

  let totalCents = 0;
  let chargeCount = 0;
  let viaForecast = 0;
  let viaBillId = 0;
  let viaInstallment = 0;
  let viaDateWindow = 0;
  for (const tx of transactions) {
    if (!pluggyTxBelongsToInvoice(tx, invoice, endDate, excludeBillIds)) {
      continue;
    }
    const amount = typeof tx.amount === 'number' ? tx.amount : 0;
    totalCents += Math.round(Math.abs(amount) * 100);
    chargeCount += 1;

    const meta = tx.creditCardMetadata;
    if (meta?.billForecastDate) {
      viaForecast += 1;
    } else if (meta?.billId && !excludeBillIds?.has(meta.billId)) {
      viaBillId += 1;
    } else if (
      (typeof meta?.installmentNumber === 'number' &&
        typeof meta?.totalInstallments === 'number' &&
        meta.totalInstallments > 1) ||
      installmentFromDescription(tx.description ?? '')
    ) {
      viaInstallment += 1;
    } else {
      viaDateWindow += 1;
    }
  }

  return {
    totalCents,
    chargeCount,
    viaForecast,
    viaBillId,
    viaInstallment,
    viaDateWindow,
    openBillIdTotalCents,
    openBillIdCount,
  };
}

/**
 * When Bills API has no in-cycle unpaid statement, fall back to Account.balance
 * only if creditData due/close dates align with the Organizze invoice.
 */
function pickPluggyAccountBalanceForInvoice(
  account: Account,
  invoice: OrganizzeInvoice,
  options?: { allowMonthLag?: boolean },
): PluggyInvoiceCompareSource | null {
  const credit = account.creditData;
  if (!credit) {
    return null;
  }
  if (typeof account.balance !== 'number' || !Number.isFinite(account.balance)) {
    return null;
  }

  const dueDate = toIsoDate(credit.balanceDueDate);
  const closeDate = toIsoDate(credit.balanceCloseDate);
  if (!dueDate && !closeDate) {
    return null;
  }

  const allowLag = options?.allowMonthLag !== false;
  const dueDist = dueDate
    ? allowLag
      ? Math.min(
          daysBetween(dueDate, invoice.date),
          daysBetween(dueDate, shiftIsoMonths(invoice.date, -1)),
        )
      : daysBetween(dueDate, invoice.date)
    : Number.POSITIVE_INFINITY;
  const closeDist = closeDate
    ? allowLag
      ? Math.min(
          daysBetween(closeDate, invoice.closing_date),
          daysBetween(closeDate, shiftIsoMonths(invoice.closing_date, -1)),
        )
      : daysBetween(closeDate, invoice.closing_date)
    : Number.POSITIVE_INFINITY;
  const dateDistance = Math.min(dueDist, closeDist);
  if (!Number.isFinite(dateDistance) || dateDistance > BILL_MATCH_MAX_DAYS) {
    return null;
  }

  return {
    billId: null,
    totalCents: Math.round(Math.abs(account.balance) * 100),
    dueDate,
    closeDate,
    minimumPaymentCents: reaisToCents(credit.minimumPayment),
    origin: 'account_balance',
  };
}

function resolvePluggyInvoiceCompare(
  bills: CreditCardBills[],
  invoice: OrganizzeInvoice,
  account: Account,
  options?: { allowMonthLag?: boolean },
): PluggyInvoiceCompareResult {
  const { match, nearestDistance } = scorePluggyBillsForInvoice(
    bills,
    invoice,
    options,
  );
  if (match) {
    return {
      compare: {
        billId: match.id,
        totalCents: Math.round(Math.abs(match.totalAmount) * 100),
        dueDate: toIsoDate(match.dueDate),
        closeDate: toIsoDate(match.billClosingDate),
        minimumPaymentCents: reaisToCents(match.minimumPaymentAmount),
        origin: 'bill',
      },
      billsFound: bills.length,
      matchOrigin: 'bill',
      matchHint: null,
    };
  }

  const balanceFallback = pickPluggyAccountBalanceForInvoice(
    account,
    invoice,
    options,
  );
  if (balanceFallback) {
    return {
      compare: balanceFallback,
      billsFound: bills.length,
      matchOrigin: 'account_balance',
      matchHint: null,
    };
  }

  let matchHint: string;
  if (bills.length === 0) {
    matchHint = 'Open Finance não retornou faturas (Bills)';
  } else if (Number.isFinite(nearestDistance)) {
    matchHint = `Nenhuma fatura OF a ≤${BILL_MATCH_MAX_DAYS}d (mais próxima: ${Math.round(nearestDistance)}d)`;
  } else {
    matchHint = 'Faturas OF sem data de vencimento utilizável';
  }

  return {
    compare: null,
    billsFound: bills.length,
    matchOrigin: null,
    matchHint,
  };
}

/**
 * When excludeFutureOz: sum invoice txs with date ≤ today (skip scheduled
 * fixed charges that have not occurred yet). Falls back to amount_cents.
 */
async function resolveOrganizzeAmountCents(params: {
  organizze: OrganizzeService;
  creditCardId: number;
  invoice: OrganizzeInvoice;
  excludeFutureOz: boolean;
  today: string;
  logger: Logger;
}): Promise<{ amountCents: number; excludedFutureCount: number }> {
  const fullAmount = Math.abs(params.invoice.amount_cents);
  if (!params.excludeFutureOz) {
    return { amountCents: fullAmount, excludedFutureCount: 0 };
  }

  let detail = params.invoice;
  if (!detail.transactions || detail.transactions.length === 0) {
    try {
      detail = await params.organizze.getInvoice(
        params.creditCardId,
        params.invoice.id,
      );
    } catch (error) {
      params.logger.warn(
        `getInvoice(${params.creditCardId},${params.invoice.id}) failed: ${String(error)}`,
      );
      return { amountCents: fullAmount, excludedFutureCount: 0 };
    }
  }

  const txs = detail.transactions ?? [];
  if (txs.length === 0) {
    return { amountCents: fullAmount, excludedFutureCount: 0 };
  }

  let amountCents = 0;
  let excludedFutureCount = 0;
  for (const tx of txs) {
    const date = tx.date.slice(0, 10);
    if (date > params.today) {
      excludedFutureCount += 1;
      continue;
    }
    amountCents += Math.abs(tx.amount_cents);
  }
  return { amountCents, excludedFutureCount };
}

@Injectable()
export class BalancesService {
  private readonly logger = new Logger(BalancesService.name);

  constructor(
    private readonly organizze: OrganizzeService,
    private readonly pluggy: PluggyService,
    private readonly settings: SettingsService,
  ) {}

  async getSnapshot(options?: {
    excludeFutureOz?: boolean;
  }): Promise<BalanceSnapshotResponse> {
    const excludeFutureOz = options?.excludeFutureOz === true;
    const today = todayIsoSaoPaulo();
    const perf = startPerf('balances.snapshot');
    const appSettings = await this.settings.getSettings();
    perf.mark('settings');

    const [accounts, investments, organizzeAccounts, organizzeCreditCards] =
      await Promise.all([
        this.pluggy.listAccounts().catch((error) => {
          this.logger.warn(`listAccounts failed: ${String(error)}`);
          return [] as Account[];
        }),
        this.pluggy.listInvestments().catch((error) => {
          this.logger.warn(`listInvestments failed: ${String(error)}`);
          return [] as PluggyInvestmentView[];
        }),
        this.organizze.listAccounts({ includeArchived: false }),
        this.organizze.listCreditCards({ includeArchived: false }),
      ]);
    perf.mark(
      `pluggy+oz accounts=${accounts.length} investments=${investments.length} cards=${organizzeCreditCards.length}`,
    );
    this.logger.log(
      `Balance snapshot: ${accounts.length} accounts, ${investments.length} investments, ${organizzeCreditCards.length} cards`,
    );

    const accountById = new Map(
      accounts.map((account) => [account.id, account]),
    );
    const investmentById = new Map(
      investments.map((investment) => [investment.id, investment]),
    );
    const organizzeNameById = new Map(
      organizzeAccounts.map((account) => [account.id, account.name]),
    );

    const { maps: resolvedMaps, unmappedInvestments } = this.resolveBalanceMaps(
      appSettings.balanceMaps,
      appSettings.accountMaps.filter(isActiveAccountMap),
      accountById,
      investments,
    );

    type AccSource = {
      map: BalanceMap;
      source: BalanceSnapshotSource;
    };
    const sourcesByOz = new Map<number, AccSource[]>();

    for (const map of resolvedMaps) {
      let balanceCents: number | null = null;
      let label = map.nickname?.trim() || '';
      let connectionName: string | null = null;
      const included = map.enabled !== false;

      if (map.sourceKind === 'account') {
        const account = accountById.get(map.pluggySourceId);
        if (!account) {
          continue;
        }
        if ((account.type ?? '').toUpperCase() === 'CREDIT') {
          continue;
        }
        const balance =
          typeof account.balance === 'number' ? account.balance : 0;
        balanceCents = Math.round(balance * 100);
        if (!label) {
          label = account.name;
        }
      } else if (map.sourceKind === 'investment') {
        const investment = investmentById.get(map.pluggySourceId);
        if (!investment) {
          continue;
        }
        balanceCents = investment.balanceCents;
        if (!label) {
          label = investment.name;
        }
        connectionName = investment.connectionName;
      } else if (map.sourceKind === 'reserved') {
        const parsed = parseReservedSourceId(map.pluggySourceId);
        if (!parsed) {
          continue;
        }
        const account = accountById.get(parsed.accountId);
        if (!account) {
          continue;
        }
        const reserved = (account.bankData?.reservedBalances ?? []).find(
          (entry) => entry.identification === parsed.identification,
        );
        if (!reserved) {
          continue;
        }
        const amountReais = (reserved.availableAmounts ?? []).reduce(
          (sum, entry) =>
            sum + (typeof entry.amount === 'number' ? entry.amount : 0),
          0,
        );
        balanceCents = Math.round(amountReais * 100);
        if (!label) {
          label = reserved.name?.trim() || 'Saldo reservado';
        }
      } else {
        continue;
      }

      if (balanceCents === null) {
        continue;
      }

      const entry: AccSource = {
        map,
        source: {
          sourceKey: map.sourceKey,
          sourceKind: map.sourceKind,
          pluggySourceId: map.pluggySourceId,
          label,
          balanceCents,
          connectionName,
          included,
        },
      };

      const list = sourcesByOz.get(map.organizzeAccountId) ?? [];
      list.push(entry);
      sourcesByOz.set(map.organizzeAccountId, list);
    }

    const rows: BalanceSnapshotRow[] = [];
    for (const [organizzeAccountId, entries] of sourcesByOz) {
      const sources = entries
        .map((entry) => entry.source)
        .sort((left, right) => {
          const kindRank = (kind: BalanceSnapshotSource['sourceKind']): number => {
            if (kind === 'account') {
              return 0;
            }
            if (kind === 'reserved') {
              return 1;
            }
            return 2;
          };
          const kindCmp = kindRank(left.sourceKind) - kindRank(right.sourceKind);
          if (kindCmp !== 0) {
            return kindCmp;
          }
          return left.label.localeCompare(right.label, 'pt-BR');
        });
      const openFinanceBalanceCents = sources
        .filter((source) => source.included)
        .reduce((sum, source) => sum + source.balanceCents, 0);

      let organizzeBalanceCents = 0;
      try {
        organizzeBalanceCents =
          await this.organizze.getAccountBalanceCents(organizzeAccountId);
      } catch (error) {
        this.logger.warn(
          `getAccountBalanceCents(${organizzeAccountId}) failed: ${String(error)}`,
        );
        throw error;
      }

      const diffCents = openFinanceBalanceCents - organizzeBalanceCents;
      rows.push({
        organizzeAccountId,
        organizzeAccountName:
          organizzeNameById.get(organizzeAccountId) ??
          `Conta #${organizzeAccountId}`,
        organizzeBalanceCents,
        openFinanceBalanceCents,
        diffCents,
        status:
          Math.abs(diffCents) <= BALANCE_TOLERANCE_CENTS ? 'ok' : 'diverged',
        sources,
      });
    }

    rows.sort((a, b) =>
      a.organizzeAccountName.localeCompare(b.organizzeAccountName, 'pt-BR'),
    );

    const creditCardNameById = new Map(
      organizzeCreditCards.map((card) => [card.id, card.name]),
    );
    const handledCreditPluggyIds = new Set(
      appSettings.accountMaps
        .filter(
          (map) =>
            map.targetType === 'credit_card' || map.targetType === 'ignored',
        )
        .map((map) => map.pluggyAccountId),
    );

    const invoiceRows: InvoiceBalanceRow[] = [];
    const creditMaps = appSettings.accountMaps.filter(
      (map) =>
        map.targetType === 'credit_card' && map.organizzeTargetId > 0,
    );

    const pluggyIdsByCard = new Map<number, string[]>();
    for (const map of creditMaps) {
      const list = pluggyIdsByCard.get(map.organizzeTargetId) ?? [];
      list.push(map.pluggyAccountId);
      pluggyIdsByCard.set(map.organizzeTargetId, list);
    }

    for (const [organizzeCreditCardId, pluggyIds] of pluggyIdsByCard) {
      const pluggyAccounts = pluggyIds
        .map((id) => accountById.get(id))
        .filter((account): account is Account => Boolean(account))
        .filter((account) => (account.type ?? '').toUpperCase() === 'CREDIT');

      if (pluggyAccounts.length === 0) {
        continue;
      }

      const primary = pluggyAccounts[0];
      const nickname = creditMaps.find(
        (map) =>
          map.organizzeTargetId === organizzeCreditCardId &&
          map.pluggyAccountId === primary.id,
      )?.nickname;
      const cardName =
        creditCardNameById.get(organizzeCreditCardId) ??
        `Cartão #${organizzeCreditCardId}`;
      const pluggyAccountName = nickname?.trim() || primary.name;

      let bills: CreditCardBills[] = [];
      try {
        bills = await this.pluggy.listCreditCardBills(primary.id);
      } catch (error) {
        this.logger.warn(
          `listCreditCardBills(${primary.id}) failed: ${String(error)}`,
        );
      }

      let invoices: OrganizzeInvoice[] = [];
      try {
        invoices = await this.organizze.listInvoices(organizzeCreditCardId);
      } catch (error) {
        this.logger.warn(
          `listInvoices(${organizzeCreditCardId}) failed: ${String(error)}`,
        );
      }

      const picked = pickOrganizzeInvoicesForCompare(invoices);
      const recentOz = [...invoices]
        .sort((a, b) => b.closing_date.localeCompare(a.closing_date))
        .slice(0, 3)
        .map(
          (entry) =>
            `id=${entry.id} due=${entry.date} close=${entry.closing_date} amt=${entry.amount_cents} bal=${entry.balance_cents}`,
        )
        .join(' | ');

      if (picked.length === 0) {
        this.logger.log(
          `invoice-compare card=${organizzeCreditCardId} picked=none bills=${bills.length} recent=[${recentOz}]`,
        );
        invoiceRows.push({
          organizzeCreditCardId,
          organizzeCreditCardName: cardName,
          pluggyAccountId: primary.id,
          pluggyAccountName,
          pluggyBillId: null,
          pluggyBillTotalCents: null,
          pluggyBillDueDate: null,
          pluggyBillCloseDate: null,
          pluggyMinimumPaymentCents: null,
          pluggyBillsFound: bills.length,
          pluggyMatchOrigin: null,
          pluggyMatchHint: 'Sem fatura no Organizze',
          invoiceCycle: null,
          invoiceId: null,
          invoiceDueDate: null,
          invoiceStartingDate: null,
          invoiceClosingDate: null,
          organizzeAmountCents: null,
          organizzePaymentCents: null,
          organizzeBalanceCents: null,
          diffCents: null,
          organizzeExcludedFutureCount: 0,
          status: 'no_invoice',
        });
        continue;
      }

      const usedPluggyBillIds = new Set<string>();
      let closedOfUnpaidCents = 0;

      for (const { invoice, cycle } of picked) {
        let resolved: PluggyInvoiceCompareResult;

        if (cycle === 'open') {
          // Never use bare Account.balance: with the closed bill paid it still
          // includes installments that belong to later statements.
          // Prefer: open bill → balance − unpaid closed − future forecasts → tx sum.
          resolved = {
            compare: null,
            billsFound: bills.length,
            matchOrigin: null,
            matchHint: null,
          };

          const accountBalanceCents =
            typeof primary.balance === 'number' &&
            Number.isFinite(primary.balance)
              ? Math.round(Math.abs(primary.balance) * 100)
              : 0;
          const unpaidPriorCents = Math.max(
            sumUnpaidPriorBillCents(bills, today).totalCents,
            closedOfUnpaidCents,
          );

          const openBill = pickPluggyBillForOpenInvoice(
            bills,
            invoice,
            usedPluggyBillIds,
          );
          const openBillCents = openBill
            ? Math.round(Math.abs(openBill.totalAmount) * 100)
            : 0;

          let txCents = 0;
          let txChargeCount = 0;
          let txHint: string | null = null;
          let futureForecastCents = 0;
          let futureForecastCount = 0;
          let remainAfterCents = 0;
          let balanceBackedOpenCents = 0;
          // Fetch only through cycle close for belonging. Lookback covers
          // installment purchases; do NOT fetch +18m (pulls other cycles).
          const dateToBelong = invoice.closing_date;
          const dateFrom = shiftIsoMonths(
            invoice.starting_date,
            -OPEN_TX_INSTALLMENT_LOOKBACK_MONTHS,
          );
          try {
            const transactions = await this.pluggy.listTransactions({
              accountId: primary.id,
              dateFrom,
              dateTo: dateToBelong,
            });
            const summed = sumPluggyChargesForOpenInvoice(
              transactions,
              invoice,
              dateToBelong,
              usedPluggyBillIds,
            );
            txCents = summed.totalCents;
            txChargeCount = summed.chargeCount;
            if (
              accountBalanceCents > 0 &&
              txCents > accountBalanceCents
            ) {
              txCents = accountBalanceCents;
            }
            if (txChargeCount > 0) {
              txHint = `Soma de ${txChargeCount} lançamento${txChargeCount === 1 ? '' : 's'} OF do ciclo (compras + parcelas)`;
            }

            const future = sumFutureForecastBeyondOpenInvoice(
              transactions,
              invoice,
              usedPluggyBillIds,
            );
            futureForecastCents = future.totalCents;
            futureForecastCount = future.chargeCount;

            // Keep through due+1 month: purchaseDate+(n−1) calendars run ~1
            // month ahead of XP statement cycles. (Known-good ≈ R$ 3.887 on XP.)
            const keepThroughMonth = keepThroughMonthForOpenInvoice(
              invoice.date,
            );
            const remainingAfter = sumRemainingInstallmentsAfterDue(
              transactions,
              keepThroughMonth,
            );
            remainAfterCents = remainingAfter.totalCents;
            const peelFutureCents = Math.max(
              futureForecastCents,
              remainAfterCents,
            );
            balanceBackedOpenCents = estimateOpenInvoiceFromBalance({
              accountBalanceCents,
              unpaidPriorCents,
              remainingInstallmentCents: peelFutureCents,
              minPeelCents: BALANCE_TOLERANCE_CENTS,
            });

            this.logger.log(
              `open-tx-sum card=${organizzeCreditCardId} fetched=${transactions.length} sum=${txCents} count=${txChargeCount} forecast=${summed.viaForecast} billId=${summed.viaBillId} installment=${summed.viaInstallment} dateWin=${summed.viaDateWindow} bill=${openBillCents} futureFcst=${futureForecastCents}/${futureForecastCount} remainAfter=${remainAfterCents}/${remainingAfter.purchaseCount} peel=${peelFutureCents} balOpen=${balanceBackedOpenCents} unpaidPrior=${unpaidPriorCents} accBal=${accountBalanceCents} keepThrough=${keepThroughMonth} limits=${summarizeDisaggregatedLimits(primary)} range=${dateFrom}→${dateToBelong}`,
            );
          } catch (error) {
            this.logger.warn(
              `listTransactions(${primary.id}) for open invoice failed: ${String(error)}`,
            );
          }

          // Trust only OF signals — never calibrate open OF against Oz.
          const balanceBackedBeatsTx =
            balanceBackedOpenCents >
            Math.round(txCents * 1.1) + BALANCE_TOLERANCE_CENTS;
          const balanceBackedBelowBalance =
            accountBalanceCents <= 0 ||
            balanceBackedOpenCents <
              Math.round(accountBalanceCents * 0.95);
          const trustBalanceBacked =
            balanceBackedOpenCents > BALANCE_TOLERANCE_CENTS &&
            balanceBackedBelowBalance &&
            balanceBackedBeatsTx;

          let pickOrigin: 'bill' | 'account_balance' | 'transactions_sum' | null =
            null;
          let pickTotal = 0;
          let pickHint: string | null = null;
          let pickBillId: string | null = null;
          let pickDue: string | null = null;
          let pickClose: string | null = null;
          let pickMinPay: number | null = null;

          if (trustBalanceBacked) {
            pickOrigin = 'account_balance';
            pickTotal = balanceBackedOpenCents;
            pickHint =
              'Saldo OF menos parcelas projetadas de ciclos futuros';
            pickBillId = openBill?.id ?? null;
            pickDue = openBill ? toIsoDate(openBill.dueDate) : null;
            pickClose = openBill ? toIsoDate(openBill.billClosingDate) : null;
            pickMinPay = openBill
              ? reaisToCents(openBill.minimumPaymentAmount)
              : reaisToCents(primary.creditData?.minimumPayment);
          } else if (openBill && openBillCents > 0) {
            if (
              accountBalanceCents <= 0 ||
              openBillCents <= accountBalanceCents
            ) {
              pickOrigin = 'bill';
              pickTotal = openBillCents;
              pickHint = 'Fatura OF do ciclo aberto';
              pickBillId = openBill.id;
              pickDue = toIsoDate(openBill.dueDate);
              pickClose = toIsoDate(openBill.billClosingDate);
              pickMinPay = reaisToCents(openBill.minimumPaymentAmount);
            }
          }
          if (!pickOrigin && txCents > 0 && txChargeCount > 0) {
            pickOrigin = 'transactions_sum';
            pickTotal = txCents;
            pickHint = txHint;
          }

          this.logger.log(
            `open-of-pick card=${organizzeCreditCardId} origin=${pickOrigin ?? 'none'} total=${pickTotal} bill=${openBillCents} tx=${txCents} balOpen=${balanceBackedOpenCents} remainAfter=${remainAfterCents} unpaidPrior=${unpaidPriorCents} accBal=${accountBalanceCents} trustBal=${trustBalanceBacked}`,
          );

          if (pickOrigin && pickTotal > 0) {
            resolved = {
              compare: {
                billId: pickBillId,
                totalCents: pickTotal,
                dueDate: pickDue,
                closeDate: pickClose,
                minimumPaymentCents: pickMinPay,
                origin: pickOrigin,
              },
              billsFound: bills.length,
              matchOrigin: pickOrigin,
              matchHint: pickHint,
            };
          } else {
            resolved = {
              compare: null,
              billsFound: bills.length,
              matchOrigin: null,
              matchHint: 'Sem fatura/lançamentos OF para o ciclo aberto',
            };
          }
        } else {
          resolved = resolvePluggyInvoiceCompare(bills, invoice, primary, {
            allowMonthLag: true,
          });
        }

        if (resolved.compare?.billId) {
          usedPluggyBillIds.add(resolved.compare.billId);
        }
        if (
          cycle === 'closed' &&
          resolved.compare &&
          invoiceIsUnpaid(invoice)
        ) {
          closedOfUnpaidCents = Math.max(
            closedOfUnpaidCents,
            resolved.compare.totalCents,
          );
        }

        const { amountCents: organizzeAmountCents, excludedFutureCount } =
          await resolveOrganizzeAmountCents({
            organizze: this.organizze,
            creditCardId: organizzeCreditCardId,
            invoice,
            excludeFutureOz,
            today,
            logger: this.logger,
          });

        const pluggyCompare = resolved.compare;
        const pluggyBillDueDate = pluggyCompare?.dueDate ?? null;
        const pluggyBillCloseDate = pluggyCompare?.closeDate ?? null;
        const pluggyBillTotalCents = pluggyCompare?.totalCents ?? null;
        const pluggyMinimumPaymentCents =
          pluggyCompare?.minimumPaymentCents ?? null;

        this.logger.log(
          `invoice-compare card=${organizzeCreditCardId} cycle=${cycle} picked=${invoice.id} dueOz=${invoice.date} closeOz=${invoice.closing_date} amountOz=${organizzeAmountCents} fullOz=${invoice.amount_cents} exclFuture=${excludedFutureCount} balOz=${invoice.balance_cents} bills=${resolved.billsFound} ofOrigin=${resolved.matchOrigin ?? 'none'} bill=${pluggyCompare?.billId ?? 'none'} dueOF=${pluggyBillDueDate} totalOF=${pluggyBillTotalCents} hint=${resolved.matchHint ?? '-'} recent=[${recentOz}]`,
        );

        if (!pluggyCompare) {
          invoiceRows.push({
            organizzeCreditCardId,
            organizzeCreditCardName: cardName,
            pluggyAccountId: primary.id,
            pluggyAccountName,
            pluggyBillId: null,
            pluggyBillTotalCents: null,
            pluggyBillDueDate: null,
            pluggyBillCloseDate: null,
            pluggyMinimumPaymentCents: null,
            pluggyBillsFound: resolved.billsFound,
            pluggyMatchOrigin: null,
            pluggyMatchHint: resolved.matchHint,
            invoiceCycle: cycle,
            invoiceId: invoice.id,
            invoiceDueDate: invoice.date,
            invoiceStartingDate: invoice.starting_date,
            invoiceClosingDate: invoice.closing_date,
            organizzeAmountCents,
            organizzePaymentCents: invoice.payment_amount_cents,
            organizzeBalanceCents: invoice.balance_cents,
            diffCents: null,
            organizzeExcludedFutureCount: excludedFutureCount,
            status: 'no_pluggy_bill',
          });
          continue;
        }

        const diffCents = pluggyCompare.totalCents - organizzeAmountCents;
        const bothEmpty =
          pluggyCompare.totalCents === 0 && organizzeAmountCents === 0;
        // Open invoice: Oz often includes scheduled fixed charges not in OF yet.
        const openOzAhead =
          !excludeFutureOz &&
          cycle === 'open' &&
          organizzeAmountCents > pluggyCompare.totalCents &&
          Math.abs(diffCents) > BALANCE_TOLERANCE_CENTS;
        const futureNote =
          excludedFutureCount > 0
            ? `Oz sem ${excludedFutureCount} lançamento${excludedFutureCount === 1 ? '' : 's'} futuro${excludedFutureCount === 1 ? '' : 's'}`
            : null;
        const matchHint = bothEmpty
          ? 'Sem cobrança neste ciclo'
          : openOzAhead
            ? `${resolved.matchHint ? `${resolved.matchHint}. ` : ''}Oz pode incluir lançamentos fixos ainda não ocorridos no OF`
            : [resolved.matchHint, futureNote]
                .filter((part): part is string => Boolean(part))
                .join(' · ') || null;
        invoiceRows.push({
          organizzeCreditCardId,
          organizzeCreditCardName: cardName,
          pluggyAccountId: primary.id,
          pluggyAccountName,
          pluggyBillId: pluggyCompare.billId,
          pluggyBillTotalCents: pluggyCompare.totalCents,
          pluggyBillDueDate,
          pluggyBillCloseDate,
          pluggyMinimumPaymentCents,
          pluggyBillsFound: resolved.billsFound,
          pluggyMatchOrigin: resolved.matchOrigin,
          pluggyMatchHint: matchHint,
          invoiceCycle: cycle,
          invoiceId: invoice.id,
          invoiceDueDate: invoice.date,
          invoiceStartingDate: invoice.starting_date,
          invoiceClosingDate: invoice.closing_date,
          organizzeAmountCents,
          organizzePaymentCents: invoice.payment_amount_cents,
          organizzeBalanceCents: invoice.balance_cents,
          diffCents,
          organizzeExcludedFutureCount: excludedFutureCount,
          status: bothEmpty
            ? 'empty'
            : Math.abs(diffCents) <= BALANCE_TOLERANCE_CENTS
              ? 'ok'
              : openOzAhead
                ? 'open_pending'
                : 'diverged',
        });
      }
    }

    invoiceRows.sort((a, b) => {
      const byCard = a.organizzeCreditCardName.localeCompare(
        b.organizzeCreditCardName,
        'pt-BR',
      );
      if (byCard !== 0) {
        return byCard;
      }
      const cycleRank = (cycle: 'closed' | 'open' | null): number => {
        if (cycle === 'closed') {
          return 0;
        }
        if (cycle === 'open') {
          return 1;
        }
        return 2;
      };
      const byCycle = cycleRank(a.invoiceCycle) - cycleRank(b.invoiceCycle);
      if (byCycle !== 0) {
        return byCycle;
      }
      return (a.invoiceDueDate ?? '').localeCompare(b.invoiceDueDate ?? '');
    });

    const unmappedCreditAccounts: UnmappedCreditAccount[] = accounts
      .filter((account) => (account.type ?? '').toUpperCase() === 'CREDIT')
      .filter((account) => !handledCreditPluggyIds.has(account.id))
      .map((account) => ({
        id: account.id,
        name: account.name,
        balanceCents: Math.round(
          (typeof account.balance === 'number' ? account.balance : 0) * 100,
        ),
        connectionName: null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

    perf.end(
      `rows=${rows.length} invoices=${invoiceRows.length} investments=${investments.length} unmapped=${unmappedInvestments.length}`,
    );
    return {
      generatedAt: new Date().toISOString(),
      toleranceCents: BALANCE_TOLERANCE_CENTS,
      excludeFutureOz,
      investmentsFound: investments.length,
      rows,
      unmappedInvestments,
      invoiceRows,
      unmappedCreditAccounts,
    };
  }

  async createAdjustment(body: {
    organizzeAccountId: number;
    amountCents: number;
    date: string;
    description?: string;
    categoryId?: number | null;
    tags?: string[];
  }) {
    if (
      !Number.isFinite(body.organizzeAccountId) ||
      body.organizzeAccountId <= 0
    ) {
      throw new BadRequestException('organizzeAccountId is required');
    }
    if (!Number.isFinite(body.amountCents) || body.amountCents === 0) {
      throw new BadRequestException('amountCents must be a non-zero integer');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }

    const accounts = await this.organizze.listAccounts({
      includeArchived: false,
    });
    const account = accounts.find(
      (entry) => entry.id === body.organizzeAccountId,
    );
    if (!account) {
      throw new NotFoundException(
        `Organizze account ${body.organizzeAccountId} not found`,
      );
    }

    const amountCents = Math.round(body.amountCents);
    const description =
      body.description?.trim() ||
      (amountCents > 0
        ? 'Ajuste de saldo (rendimento)'
        : 'Ajuste de saldo (perda)');
    const notes = `[balance-adjust:${body.date}:oz:${body.organizzeAccountId}]`;
    const tags = normalizeOrganizzeTagNames(body.tags);

    const created = await this.organizze.createTransaction({
      description,
      date: body.date,
      amount_cents: amountCents,
      paid: true,
      notes,
      category_id: body.categoryId ?? null,
      account_id: body.organizzeAccountId,
      ...(tags ? { tags } : {}),
    });

    return {
      organizzeTransaction: created,
      snapshot: await this.getSnapshot(),
    };
  }

  /**
   * Create a credit-card transaction on an Organizze invoice to align totals.
   * Convention: expenses are negative (raise invoice); credits positive (lower).
   * Suggested UI amount is typically `-diffCents` when OF bill > Organizze total.
   */
  async createInvoiceAdjustment(body: {
    organizzeCreditCardId: number;
    invoiceId: number;
    amountCents: number;
    date: string;
    description?: string;
    categoryId?: number | null;
    tags?: string[];
  }) {
    if (
      !Number.isFinite(body.organizzeCreditCardId) ||
      body.organizzeCreditCardId <= 0
    ) {
      throw new BadRequestException('organizzeCreditCardId is required');
    }
    if (!Number.isFinite(body.invoiceId) || body.invoiceId <= 0) {
      throw new BadRequestException('invoiceId is required');
    }
    if (!Number.isFinite(body.amountCents) || body.amountCents === 0) {
      throw new BadRequestException('amountCents must be a non-zero integer');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }

    const cards = await this.organizze.listCreditCards({
      includeArchived: false,
    });
    const card = cards.find((entry) => entry.id === body.organizzeCreditCardId);
    if (!card) {
      throw new NotFoundException(
        `Organizze credit card ${body.organizzeCreditCardId} not found`,
      );
    }

    const invoices = await this.organizze.listInvoices(
      body.organizzeCreditCardId,
    );
    const invoice = invoices.find((entry) => entry.id === body.invoiceId);
    if (!invoice) {
      throw new NotFoundException(
        `Invoice ${body.invoiceId} not found on card ${body.organizzeCreditCardId}`,
      );
    }

    const amountCents = Math.round(body.amountCents);
    const description =
      body.description?.trim() ||
      (amountCents < 0
        ? 'Ajuste de fatura (lançamento)'
        : 'Ajuste de fatura (crédito)');
    const notes = `[invoice-adjust:${body.date}:card:${body.organizzeCreditCardId}:inv:${body.invoiceId}]`;
    const tags = normalizeOrganizzeTagNames(body.tags);

    const created = await this.organizze.createTransaction({
      description,
      date: body.date,
      amount_cents: amountCents,
      paid: true,
      notes,
      category_id: body.categoryId ?? null,
      credit_card_id: body.organizzeCreditCardId,
      credit_card_invoice_id: body.invoiceId,
      ...(tags ? { tags } : {}),
    });

    return {
      organizzeTransaction: created,
      snapshot: await this.getSnapshot(),
    };
  }

  /**
   * Resolve balance sources:
   * 1. Explicit balanceMaps (wins, including enabled:false / other Oz account)
   * 2. Auto-derive BANK accountMaps → Organizze account
   * 3. Auto-attach reservedBalances (cofrinho / caixinhas) of those BANK accounts
   * 4. Auto-attach investments from the same Pluggy item when all BANK maps
   *    of that item point to a single Organizze account
   */
  private resolveBalanceMaps(
    balanceMaps: BalanceMap[],
    accountMaps: Array<{
      pluggyAccountId: string;
      targetType: 'account' | 'credit_card';
      organizzeTargetId: number;
      nickname?: string | null;
    }>,
    accountById: Map<string, Account>,
    investments: PluggyInvestmentView[],
  ): { maps: BalanceMap[]; unmappedInvestments: UnmappedInvestment[] } {
    const byKey = new Map<string, BalanceMap>();

    for (const map of balanceMaps) {
      byKey.set(map.sourceKey, map);
    }

    for (const map of accountMaps) {
      if (map.targetType !== 'account') {
        continue;
      }
      const account = accountById.get(map.pluggyAccountId);
      if (account && (account.type ?? '').toUpperCase() === 'CREDIT') {
        continue;
      }
      const sourceKey = buildBalanceSourceKey('account', map.pluggyAccountId);
      if (byKey.has(sourceKey)) {
        continue;
      }
      byKey.set(sourceKey, {
        sourceKey,
        sourceKind: 'account',
        pluggySourceId: map.pluggyAccountId,
        organizzeAccountId: map.organizzeTargetId,
        nickname: map.nickname ?? null,
        enabled: true,
      });
    }

    // Reserved balances (Mercado Pago cofrinho, caixinhas, etc.) on mapped BANK accounts
    for (const map of [...byKey.values()]) {
      if (map.sourceKind !== 'account' || map.enabled === false) {
        continue;
      }
      const account = accountById.get(map.pluggySourceId);
      if (!account) {
        continue;
      }
      const reservedList = account.bankData?.reservedBalances ?? [];
      if (reservedList.length > 0) {
        this.logger.log(
          `Reserved balances on ${account.name}: ${reservedList.length} → Oz ${map.organizzeAccountId}`,
        );
      }
      for (const reserved of reservedList) {
        if (!reserved.identification) {
          continue;
        }
        const pluggySourceId = buildReservedSourceId(
          account.id,
          reserved.identification,
        );
        const sourceKey = buildBalanceSourceKey('reserved', pluggySourceId);
        if (byKey.has(sourceKey)) {
          continue;
        }
        byKey.set(sourceKey, {
          sourceKey,
          sourceKind: 'reserved',
          pluggySourceId,
          organizzeAccountId: map.organizzeAccountId,
          nickname: reserved.name?.trim() || null,
          enabled: true,
        });
      }
    }

    /** itemId → Organizze account ids targeted by enabled BANK sources of that item */
    const itemToOzAccounts = new Map<string, Set<number>>();
    for (const map of byKey.values()) {
      if (map.sourceKind !== 'account' || map.enabled === false) {
        continue;
      }
      const account = accountById.get(map.pluggySourceId);
      const itemId = account?.itemId;
      if (!itemId) {
        continue;
      }
      const set = itemToOzAccounts.get(itemId) ?? new Set<number>();
      set.add(map.organizzeAccountId);
      itemToOzAccounts.set(itemId, set);
    }

    const unmappedInvestments: UnmappedInvestment[] = [];

    for (const investment of investments) {
      const sourceKey = buildBalanceSourceKey('investment', investment.id);
      if (byKey.has(sourceKey)) {
        continue;
      }

      const ozTargets = itemToOzAccounts.get(investment.itemId);
      if (!ozTargets || ozTargets.size !== 1) {
        unmappedInvestments.push({
          id: investment.id,
          name: investment.name,
          balanceCents: investment.balanceCents,
          type: investment.type,
          subtype: investment.subtype,
          connectionName: investment.connectionName,
          itemId: investment.itemId,
        });
        continue;
      }

      const organizzeAccountId = [...ozTargets][0];
      byKey.set(sourceKey, {
        sourceKey,
        sourceKind: 'investment',
        pluggySourceId: investment.id,
        organizzeAccountId,
        nickname: null,
        enabled: true,
      });
    }

    return { maps: [...byKey.values()], unmappedInvestments };
  }
}
