import { Injectable, Logger } from '@nestjs/common';
import { OrganizzeService } from '../organizze/organizze.service';
import type { OrganizzeTransaction } from '../organizze/organizze.types';
import { SettingsService } from '../settings/settings.service';
import type {
  InstallmentMonthBar,
  InstallmentNextPayoff,
  InstallmentPurchase,
  InstallmentScheduleEntry,
  InstallmentScheduleStatus,
  InstallmentsOverviewResponse,
} from './installments.types';

const LOOKBACK_MONTHS = 24;
const LOOKAHEAD_MONTHS = 24;
/** Max invoices to hydrate per card (≈ monthly bills). */
const MAX_INVOICES_PER_CARD = 24;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function monthKeyFromDate(isoDate: string): string {
  return isoDate.slice(0, 7);
}

function addMonths(year: number, monthIndex0: number, delta: number): {
  year: number;
  monthIndex0: number;
} {
  const absolute = year * 12 + monthIndex0 + delta;
  return {
    year: Math.floor(absolute / 12),
    monthIndex0: ((absolute % 12) + 12) % 12,
  };
}

function shiftMonthKey(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split('-').map(Number);
  const shifted = addMonths(y, m - 1, delta);
  return `${shifted.year}-${pad2(shifted.monthIndex0 + 1)}`;
}

function monthLabelPt(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  const raw = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('pt-BR', {
    month: 'short',
    timeZone: 'UTC',
  });
  return raw.replace('.', '').slice(0, 3).toLowerCase();
}

function focusMonthLabelPt(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('pt-BR', {
    month: 'long',
    timeZone: 'UTC',
  });
}

function currentMonthKeySaoPaulo(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
  })
    .format(new Date())
    .slice(0, 7);
}

/**
 * Cent drift / interest micro-adjustments across the same purchase.
 * Organizze often keeps two near-identical series a few cents apart.
 */
const AMOUNT_TOLERANCE_CENTS = 100;
/** Max distance between inferred starts to still treat as one purchase. */
const START_MONTH_TOLERANCE = 3;

function normalizeDescription(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
    .toUpperCase()
    .replace(/\s+\d+\s*\/\s*\d+\s*$/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferredStartMonth(tx: OrganizzeTransaction): string {
  const installment =
    typeof tx.installment === 'number' && tx.installment > 0
      ? tx.installment
      : 1;
  return shiftMonthKey(monthKeyFromDate(tx.date), -(installment - 1));
}

/**
 * Soft identity without exact cents — Organizze often drifts a few cents
 * across installments of the same purchase.
 */
function softPurchaseKey(tx: OrganizzeTransaction): string {
  const card = tx.credit_card_id ?? 0;
  const total = tx.total_installments ?? 0;
  const desc = normalizeDescription(tx.description ?? '');
  return `cc:${card}|t:${total}|d:${desc}`;
}

function monthDistance(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return Math.abs(ay * 12 + am - (by * 12 + bm));
}

function amountsCompatible(a: number, b: number): boolean {
  const left = Math.abs(a);
  const right = Math.abs(b);
  const diff = Math.abs(left - right);
  if (diff <= AMOUNT_TOLERANCE_CENTS) {
    return true;
  }
  const max = Math.max(left, right, 1);
  return diff / max <= 0.02;
}

/**
 * Invoice competence month → month the bill is paid.
 * In this household, the October invoice is paid in November (always +1).
 */
function invoicePaymentMonthKey(invoiceMonthKey: string): string {
  return shiftMonthKey(invoiceMonthKey, 1);
}

function medianCents(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].map(Math.abs).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
}

function clusterMeanAmount(txs: OrganizzeTransaction[]): number {
  if (txs.length === 0) {
    return 0;
  }
  const sum = txs.reduce((acc, tx) => acc + Math.abs(tx.amount_cents), 0);
  return Math.round(sum / txs.length);
}

function clustersShareInstallmentProgress(
  left: OrganizzeTransaction[],
  right: OrganizzeTransaction[],
): boolean {
  const leftMonths = new Map<number, string>();
  for (const tx of left) {
    const n =
      typeof tx.installment === 'number' && tx.installment > 0
        ? tx.installment
        : 0;
    if (n <= 0) {
      continue;
    }
    leftMonths.set(n, monthKeyFromDate(tx.date));
  }
  for (const tx of right) {
    const n =
      typeof tx.installment === 'number' && tx.installment > 0
        ? tx.installment
        : 0;
    if (n <= 0) {
      continue;
    }
    const other = leftMonths.get(n);
    if (other && monthDistance(other, monthKeyFromDate(tx.date)) <= 1) {
      return true;
    }
  }
  return false;
}

/**
 * Within the same soft key, split into real purchases by start month and
 * amount band, then re-merge near-duplicate series (cent drift / re-import).
 */
function clusterTransactions(
  txs: OrganizzeTransaction[],
): OrganizzeTransaction[][] {
  const decorated = txs.map((tx) => ({
    tx,
    start: inferredStartMonth(tx),
    amount: Math.abs(tx.amount_cents),
  }));
  decorated.sort((a, b) => {
    const byStart = a.start.localeCompare(b.start);
    if (byStart !== 0) {
      return byStart;
    }
    return a.amount - b.amount;
  });

  const clusters: Array<{
    start: string;
    amount: number;
    txs: OrganizzeTransaction[];
  }> = [];

  for (const item of decorated) {
    const match = clusters.find(
      (cluster) =>
        monthDistance(cluster.start, item.start) <= START_MONTH_TOLERANCE &&
        amountsCompatible(cluster.amount, item.amount),
    );
    if (match) {
      match.txs.push(item.tx);
      match.amount = clusterMeanAmount(match.txs);
      continue;
    }
    clusters.push({
      start: item.start,
      amount: item.amount,
      txs: [item.tx],
    });
  }

  // Second pass: merge parallel series that share installment N on the same
  // bill month (classic Organizze duplicate with ± cents).
  const merged: typeof clusters = [];
  for (const cluster of clusters) {
    const match = merged.find(
      (existing) =>
        amountsCompatible(existing.amount, cluster.amount) &&
        (monthDistance(existing.start, cluster.start) <= START_MONTH_TOLERANCE ||
          clustersShareInstallmentProgress(existing.txs, cluster.txs)),
    );
    if (match) {
      match.txs.push(...cluster.txs);
      match.amount = clusterMeanAmount(match.txs);
      if (cluster.start < match.start) {
        match.start = cluster.start;
      }
      continue;
    }
    merged.push({ ...cluster, txs: [...cluster.txs] });
  }

  return merged.map((cluster) => cluster.txs);
}

function realScheduleCount(purchase: InstallmentPurchase): number {
  return purchase.schedule.filter((entry) => entry.transactionId > 0).length;
}

function descriptionsCompatible(a: string, b: string): boolean {
  const left = normalizeDescription(a);
  const right = normalizeDescription(b);
  if (left === right) {
    return true;
  }
  return left.includes(right) || right.includes(left);
}

function purchasesShareScheduleProgress(
  left: InstallmentPurchase,
  right: InstallmentPurchase,
): boolean {
  const leftMonths = new Map<number, string>();
  for (const entry of left.schedule) {
    if (entry.transactionId <= 0) {
      continue;
    }
    leftMonths.set(entry.installment, entry.monthKey);
  }
  for (const entry of right.schedule) {
    if (entry.transactionId <= 0) {
      continue;
    }
    const other = leftMonths.get(entry.installment);
    if (other && monthDistance(other, entry.monthKey) <= 1) {
      return true;
    }
  }
  return false;
}

function areDuplicatePurchases(
  left: InstallmentPurchase,
  right: InstallmentPurchase,
): boolean {
  if (left.creditCardId !== right.creditCardId) {
    return false;
  }
  if (left.totalInstallments !== right.totalInstallments) {
    return false;
  }
  if (
    !amountsCompatible(
      left.installmentAmountCents,
      right.installmentAmountCents,
    )
  ) {
    return false;
  }
  if (!descriptionsCompatible(left.description, right.description)) {
    return false;
  }
  const leftStart = left.purchaseMonthKey;
  const rightStart = right.purchaseMonthKey;
  if (!leftStart || !rightStart) {
    return true;
  }
  if (monthDistance(leftStart, rightStart) <= START_MONTH_TOLERANCE) {
    return true;
  }
  return purchasesShareScheduleProgress(left, right);
}

function pickBetterPurchase(
  left: InstallmentPurchase,
  right: InstallmentPurchase,
): InstallmentPurchase {
  const leftReal = realScheduleCount(left);
  const rightReal = realScheduleCount(right);
  if (rightReal !== leftReal) {
    return rightReal > leftReal ? right : left;
  }
  if (right.paidCount !== left.paidCount) {
    return right.paidCount > left.paidCount ? right : left;
  }
  return left.schedule.length >= right.schedule.length ? left : right;
}

function dedupePurchases(
  purchases: InstallmentPurchase[],
): InstallmentPurchase[] {
  const result: InstallmentPurchase[] = [];
  for (const purchase of purchases) {
    const index = result.findIndex((existing) =>
      areDuplicatePurchases(existing, purchase),
    );
    if (index < 0) {
      result.push(purchase);
      continue;
    }
    result[index] = pickBetterPurchase(result[index], purchase);
  }
  return result;
}

function monthStartIso(monthKey: string): string {
  return `${monthKey}-01`;
}

function shiftIsoMonths(isoDate: string, deltaMonths: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const shifted = addMonths(y, m - 1, deltaMonths);
  const lastDay = new Date(
    Date.UTC(shifted.year, shifted.monthIndex0 + 1, 0),
  ).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${shifted.year}-${pad2(shifted.monthIndex0 + 1)}-${pad2(day)}`;
}

function dayFromIso(isoDate: string): number {
  const day = Number(isoDate.slice(8, 10));
  return Number.isFinite(day) && day > 0 ? day : 1;
}

function isoOnMonth(monthKey: string, day: number): string {
  const [y, m] = monthKey.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${monthKey}-${pad2(Math.min(day, lastDay))}`;
}

@Injectable()
export class InstallmentsService {
  private readonly logger = new Logger(InstallmentsService.name);

  constructor(
    private readonly organizze: OrganizzeService,
    private readonly settings: SettingsService,
  ) {}

  async getOverview(focusMonth?: string): Promise<InstallmentsOverviewResponse> {
    const focus =
      focusMonth && /^\d{4}-\d{2}$/.test(focusMonth)
        ? focusMonth
        : currentMonthKeySaoPaulo();

    const ignoredKeys = new Set(
      (await this.settings.getSettings()).ignoredInstallmentKeys,
    );

    const cards = await this.organizze.listCreditCards({
      includeArchived: true,
    });
    const cardNameById = new Map(
      cards.map((card) => [card.id, card.name] as const),
    );

    const transactions = await this.loadInstallmentTransactions(focus, cards);
    this.logger.log(
      `Installments pool: ${transactions.length} txs (focus=${focus})`,
    );

    const softGroups = new Map<string, OrganizzeTransaction[]>();
    for (const tx of transactions) {
      const key = softPurchaseKey(tx);
      const list = softGroups.get(key) ?? [];
      list.push(tx);
      softGroups.set(key, list);
    }

    const purchases: InstallmentPurchase[] = [];
    for (const [softKey, txs] of softGroups) {
      const clusters = clusterTransactions(txs);
      clusters.forEach((cluster, index) => {
        const purchase = this.buildPurchase(
          softKey,
          `${softKey}|c:${index}`,
          cluster,
          focus,
          cardNameById,
          ignoredKeys.has(softKey),
        );
        if (purchase) {
          purchases.push(purchase);
        }
      });
    }

    const stillOpen = dedupePurchases(
      purchases.filter((purchase) => {
        if (purchase.paidCount >= purchase.totalInstallments) {
          return false;
        }
        const ends = purchase.endsMonthKey;
        return typeof ends === 'string' && ends >= focus;
      }),
    );

    const active = stillOpen
      .filter((purchase) => !purchase.ignored)
      .sort((a, b) => b.installmentAmountCents - a.installmentAmountCents);

    const ignoredPurchases = stillOpen
      .filter((purchase) => purchase.ignored)
      .sort((a, b) => b.installmentAmountCents - a.installmentAmountCents);

    let committedThisMonthCents = 0;
    for (const purchase of active) {
      for (const entry of purchase.schedule) {
        if (entry.monthKey === focus) {
          committedThisMonthCents += Math.abs(entry.amountCents);
        }
      }
    }

    const monthlyBars: InstallmentMonthBar[] = [];
    for (let i = 0; i < 6; i += 1) {
      const key = shiftMonthKey(focus, i);
      let amountCents = 0;
      for (const purchase of active) {
        for (const entry of purchase.schedule) {
          if (entry.monthKey === key) {
            amountCents += Math.abs(entry.amountCents);
          }
        }
      }
      monthlyBars.push({
        monthKey: key,
        label: monthLabelPt(key),
        amountCents,
      });
    }

    const toPayoff = (
      purchase: (typeof active)[number],
    ): InstallmentNextPayoff => {
      const endsMonthKey = purchase.endsMonthKey as string;
      const paymentMonthKey = invoicePaymentMonthKey(endsMonthKey);
      const reliefMonthKey = shiftMonthKey(paymentMonthKey, 1);
      return {
        purchaseId: purchase.id,
        description: purchase.description,
        reliefCentsPerMonth: purchase.installmentAmountCents,
        endsMonthKey,
        paymentMonthKey,
        reliefMonthKey,
      };
    };

    const payoffsThisMonth = active
      .filter((purchase) => purchase.endsMonthKey === focus)
      .map(toPayoff)
      .sort((a, b) => b.reliefCentsPerMonth - a.reliefCentsPerMonth);

    const focusPaymentMonth = invoicePaymentMonthKey(focus);

    // Soonest quitação by payment month (fatura de set → paga em out).
    // Includes purchases ending on the focused invoice, so we don't skip
    // the October payment when viewing September.
    const nextPayoff =
      [...active]
        .filter(
          (purchase) =>
            typeof purchase.endsMonthKey === 'string' &&
            purchase.endsMonthKey >= focus,
        )
        .map(toPayoff)
        .sort((a, b) => {
          const byPay = a.paymentMonthKey.localeCompare(b.paymentMonthKey);
          if (byPay !== 0) {
            return byPay;
          }
          const byEnd = a.endsMonthKey.localeCompare(b.endsMonthKey);
          if (byEnd !== 0) {
            return byEnd;
          }
          return b.reliefCentsPerMonth - a.reliefCentsPerMonth;
        })[0] ?? null;

    return {
      generatedAt: new Date().toISOString(),
      focusMonth: focus,
      focusMonthLabel: focusMonthLabelPt(focus),
      focusPaymentMonth,
      focusPaymentMonthLabel: focusMonthLabelPt(focusPaymentMonth),
      committedThisMonthCents,
      activePurchaseCount: active.length,
      ignoredPurchaseCount: ignoredPurchases.length,
      monthlyBars,
      nextPayoff,
      payoffsThisMonth,
      purchases: active,
      ignoredPurchases,
    };
  }

  async ignorePurchase(key: string): Promise<{ ignoredInstallmentKeys: string[] }> {
    const trimmed = key.trim();
    const current = await this.settings.getSettings();
    if (!trimmed || current.ignoredInstallmentKeys.includes(trimmed)) {
      return { ignoredInstallmentKeys: current.ignoredInstallmentKeys };
    }
    const updated = await this.settings.updateSettings({
      ignoredInstallmentKeys: [...current.ignoredInstallmentKeys, trimmed],
    });
    return { ignoredInstallmentKeys: updated.ignoredInstallmentKeys };
  }

  async unignorePurchase(
    key: string,
  ): Promise<{ ignoredInstallmentKeys: string[] }> {
    const trimmed = key.trim();
    const current = await this.settings.getSettings();
    const updated = await this.settings.updateSettings({
      ignoredInstallmentKeys: current.ignoredInstallmentKeys.filter(
        (item) => item !== trimmed,
      ),
    });
    return { ignoredInstallmentKeys: updated.ignoredInstallmentKeys };
  }

  private async loadInstallmentTransactions(
    focus: string,
    cards: Array<{ id: number }>,
  ): Promise<OrganizzeTransaction[]> {
    const focusStart = monthStartIso(focus);
    const startDate = shiftIsoMonths(focusStart, -LOOKBACK_MONTHS);
    const endDate = shiftIsoMonths(focusStart, LOOKAHEAD_MONTHS);
    const byId = new Map<number, OrganizzeTransaction>();

    try {
      const all = await this.organizze.listTransactions({
        startDate,
        endDate,
      });
      for (const tx of all) {
        if (this.isInstallmentCandidate(tx)) {
          byId.set(tx.id, tx);
        }
      }
    } catch (error) {
      this.logger.warn(
        `Could not list Organizze transactions for installments: ${String(error)}`,
      );
    }

    await Promise.all(
      cards.map(async (card) => {
        try {
          const invoices = await this.organizze.listInvoices(card.id);
          const relevant = invoices
            .filter((invoice) => {
              const key = monthKeyFromDate(invoice.date || invoice.closing_date);
              return (
                key >= shiftMonthKey(focus, -LOOKBACK_MONTHS) &&
                key <= shiftMonthKey(focus, LOOKAHEAD_MONTHS)
              );
            })
            .sort((a, b) => b.date.localeCompare(a.date))
            .slice(0, MAX_INVOICES_PER_CARD);

          const details = await Promise.all(
            relevant.map(async (invoice) => {
              try {
                return await this.organizze.getInvoice(card.id, invoice.id);
              } catch {
                return null;
              }
            }),
          );

          for (const detail of details) {
            if (!detail) {
              continue;
            }
            for (const tx of detail.transactions ?? []) {
              const normalized: OrganizzeTransaction = {
                ...tx,
                credit_card_id: tx.credit_card_id ?? card.id,
              };
              if (this.isInstallmentCandidate(normalized)) {
                byId.set(normalized.id, normalized);
              }
            }
          }
        } catch (error) {
          this.logger.warn(
            `Could not hydrate invoices for card ${card.id}: ${String(error)}`,
          );
        }
      }),
    );

    return [...byId.values()];
  }

  private isInstallmentCandidate(tx: OrganizzeTransaction): boolean {
    return (
      typeof tx.total_installments === 'number' &&
      tx.total_installments > 1 &&
      typeof tx.credit_card_id === 'number' &&
      tx.credit_card_id > 0
    );
  }

  private buildPurchase(
    ignoreKey: string,
    groupKey: string,
    txs: OrganizzeTransaction[],
    focusMonth: string,
    cardNameById: Map<number, string>,
    ignored: boolean,
  ): InstallmentPurchase | null {
    if (txs.length === 0) {
      return null;
    }

    const byInstallment = new Map<number, OrganizzeTransaction>();
    const undated: OrganizzeTransaction[] = [];
    for (const tx of txs) {
      const n =
        typeof tx.installment === 'number' && tx.installment > 0
          ? tx.installment
          : 0;
      if (n <= 0) {
        undated.push(tx);
        continue;
      }
      const existing = byInstallment.get(n);
      if (!existing || (!existing.paid && tx.paid) || tx.id > existing.id) {
        byInstallment.set(n, tx);
      }
    }

    if (byInstallment.size === 0 && undated.length > 0) {
      const ordered = [...undated].sort((a, b) => a.date.localeCompare(b.date));
      ordered.forEach((tx, index) => {
        byInstallment.set(index + 1, {
          ...tx,
          installment: index + 1,
        });
      });
    }

    if (byInstallment.size === 0) {
      return null;
    }

    const known = [...byInstallment.values()].sort(
      (a, b) => (a.installment ?? 0) - (b.installment ?? 0),
    );
    const sample = known[0];
    const totalInstallments = sample.total_installments;
    if (totalInstallments <= 1) {
      return null;
    }

    const creditCardId = sample.credit_card_id as number;
    const installmentAmountCents = medianCents(
      known.map((tx) => tx.amount_cents),
    );
    const totalAmountCents = installmentAmountCents * totalInstallments;
    const startMonth = inferredStartMonth(sample);
    const billingDay = dayFromIso(sample.date);

    const schedule: InstallmentScheduleEntry[] = [];
    for (let n = 1; n <= totalInstallments; n += 1) {
      const monthKey = shiftMonthKey(startMonth, n - 1);
      const existing = byInstallment.get(n);
      if (existing) {
        const existingMonth = monthKeyFromDate(existing.date);
        let status: InstallmentScheduleStatus = 'pendente';
        if (existing.paid) {
          status = 'paga';
        } else if (existingMonth === focusMonth) {
          status = 'nesta_fatura';
        }
        schedule.push({
          date: existing.date,
          monthKey: existingMonth,
          installment: n,
          totalInstallments,
          amountCents: existing.amount_cents,
          paid: existing.paid,
          status,
          transactionId: existing.id,
        });
        continue;
      }

      const date = isoOnMonth(monthKey, billingDay);
      let status: InstallmentScheduleStatus = 'pendente';
      let paid = false;
      if (monthKey < focusMonth) {
        const laterPaid = [...byInstallment.values()].some(
          (tx) => (tx.installment ?? 0) > n && tx.paid,
        );
        const laterExists = [...byInstallment.values()].some(
          (tx) => (tx.installment ?? 0) > n,
        );
        // If a later installment already exists, the earlier missing one
        // almost certainly already hit a previous invoice.
        if (laterPaid || laterExists) {
          status = 'paga';
          paid = true;
        }
      } else if (monthKey === focusMonth) {
        status = 'nesta_fatura';
      }

      schedule.push({
        date,
        monthKey,
        installment: n,
        totalInstallments,
        amountCents: -Math.abs(installmentAmountCents),
        paid,
        status,
        transactionId: -n,
      });
    }

    const paidCount = schedule.filter((entry) => entry.paid).length;
    const remainingCount = Math.max(0, totalInstallments - paidCount);
    const currentInstallment =
      schedule.find(
        (entry) => !entry.paid && entry.monthKey >= focusMonth,
      )?.installment ??
      schedule.find((entry) => !entry.paid)?.installment ??
      Math.min(paidCount + 1, totalInstallments);

    const lastScheduleMonth = schedule[schedule.length - 1]?.monthKey ?? null;

    return {
      id: groupKey,
      ignoreKey,
      ignored,
      description: sample.description,
      creditCardId,
      creditCardName:
        cardNameById.get(creditCardId) ?? `Cartão #${creditCardId}`,
      installmentAmountCents,
      totalAmountCents,
      remainingCents: remainingCount * installmentAmountCents,
      paidCount,
      totalInstallments,
      currentInstallment,
      purchaseMonthKey: startMonth,
      endsMonthKey:
        lastScheduleMonth ?? shiftMonthKey(startMonth, totalInstallments - 1),
      schedule,
    };
  }
}
