import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Account, CreditCardBills } from 'pluggy-sdk';
import { OrganizzeService } from '../organizze/organizze.service';
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

/** Prefer most recent closed bill; else nearest upcoming due. */
function pickPluggyBillForCompare(
  bills: CreditCardBills[],
): CreditCardBills | null {
  if (bills.length === 0) {
    return null;
  }
  const today = todayIsoSaoPaulo();
  const withDates = bills
    .map((bill) => ({
      bill,
      due: toIsoDate(bill.dueDate),
      close: toIsoDate(bill.billClosingDate),
    }))
    .filter((entry) => entry.due);

  const closed = withDates
    .filter((entry) => entry.close && entry.close <= today)
    .sort((a, b) => (b.close ?? '').localeCompare(a.close ?? ''));
  if (closed[0]) {
    return closed[0].bill;
  }

  const upcoming = withDates
    .filter((entry) => entry.due && entry.due >= today)
    .sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));
  if (upcoming[0]) {
    return upcoming[0].bill;
  }

  return (
    withDates.sort((a, b) => (b.due ?? '').localeCompare(a.due ?? ''))[0]
      ?.bill ?? null
  );
}

function pickOrganizzeInvoiceForBill(
  invoices: OrganizzeInvoice[],
  billDueDate: string | null,
  billCloseDate: string | null,
): OrganizzeInvoice | null {
  if (invoices.length === 0) {
    return null;
  }
  const sorted = [...invoices].sort((a, b) => b.date.localeCompare(a.date));
  if (billDueDate) {
    const exact = sorted.find((invoice) => invoice.date === billDueDate);
    if (exact) {
      return exact;
    }
    const near = sorted
      .map((invoice) => ({
        invoice,
        distance: daysBetween(invoice.date, billDueDate),
      }))
      .filter((entry) => entry.distance <= 3)
      .sort((a, b) => a.distance - b.distance)[0];
    if (near) {
      return near.invoice;
    }
  }
  if (billCloseDate) {
    const byClose = sorted.find(
      (invoice) => invoice.closing_date === billCloseDate,
    );
    if (byClose) {
      return byClose;
    }
  }
  const today = todayIsoSaoPaulo();
  const covering = sorted.find(
    (invoice) =>
      invoice.starting_date <= today && today <= invoice.closing_date,
  );
  if (covering) {
    return covering;
  }
  const closed = sorted.find((invoice) => invoice.closing_date <= today);
  return closed ?? sorted[0] ?? null;
}

@Injectable()
export class BalancesService {
  private readonly logger = new Logger(BalancesService.name);

  constructor(
    private readonly organizze: OrganizzeService,
    private readonly pluggy: PluggyService,
    private readonly settings: SettingsService,
  ) {}

  async getSnapshot(): Promise<BalanceSnapshotResponse> {
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

      const bill = pickPluggyBillForCompare(bills);
      const pluggyBillDueDate = bill ? toIsoDate(bill.dueDate) : null;
      const pluggyBillCloseDate = bill
        ? toIsoDate(bill.billClosingDate)
        : null;
      const pluggyBillTotalCents = bill
        ? Math.round(Math.abs(bill.totalAmount) * 100)
        : null;
      const pluggyMinimumPaymentCents = bill
        ? reaisToCents(bill.minimumPaymentAmount)
        : null;

      let invoices: OrganizzeInvoice[] = [];
      try {
        invoices = await this.organizze.listInvoices(organizzeCreditCardId);
      } catch (error) {
        this.logger.warn(
          `listInvoices(${organizzeCreditCardId}) failed: ${String(error)}`,
        );
      }

      const invoice = pickOrganizzeInvoiceForBill(
        invoices,
        pluggyBillDueDate,
        pluggyBillCloseDate,
      );

      if (!bill) {
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
          invoiceId: invoice?.id ?? null,
          invoiceDueDate: invoice?.date ?? null,
          invoiceStartingDate: invoice?.starting_date ?? null,
          invoiceClosingDate: invoice?.closing_date ?? null,
          organizzeAmountCents: invoice?.amount_cents ?? null,
          organizzePaymentCents: invoice?.payment_amount_cents ?? null,
          organizzeBalanceCents: invoice?.balance_cents ?? null,
          diffCents: null,
          status: 'no_pluggy_bill',
        });
        continue;
      }

      if (!invoice) {
        invoiceRows.push({
          organizzeCreditCardId,
          organizzeCreditCardName: cardName,
          pluggyAccountId: primary.id,
          pluggyAccountName,
          pluggyBillId: bill.id,
          pluggyBillTotalCents,
          pluggyBillDueDate,
          pluggyBillCloseDate,
          pluggyMinimumPaymentCents,
          invoiceId: null,
          invoiceDueDate: null,
          invoiceStartingDate: null,
          invoiceClosingDate: null,
          organizzeAmountCents: null,
          organizzePaymentCents: null,
          organizzeBalanceCents: null,
          diffCents: null,
          status: 'no_invoice',
        });
        continue;
      }

      const organizzeAmountCents = Math.abs(invoice.amount_cents);
      const diffCents =
        (pluggyBillTotalCents ?? 0) - organizzeAmountCents;
      invoiceRows.push({
        organizzeCreditCardId,
        organizzeCreditCardName: cardName,
        pluggyAccountId: primary.id,
        pluggyAccountName,
        pluggyBillId: bill.id,
        pluggyBillTotalCents,
        pluggyBillDueDate,
        pluggyBillCloseDate,
        pluggyMinimumPaymentCents,
        invoiceId: invoice.id,
        invoiceDueDate: invoice.date,
        invoiceStartingDate: invoice.starting_date,
        invoiceClosingDate: invoice.closing_date,
        organizzeAmountCents,
        organizzePaymentCents: invoice.payment_amount_cents,
        organizzeBalanceCents: invoice.balance_cents,
        diffCents,
        status:
          Math.abs(diffCents) <= BALANCE_TOLERANCE_CENTS ? 'ok' : 'diverged',
      });
    }

    invoiceRows.sort((a, b) =>
      a.organizzeCreditCardName.localeCompare(
        b.organizzeCreditCardName,
        'pt-BR',
      ),
    );

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

    const created = await this.organizze.createTransaction({
      description,
      date: body.date,
      amount_cents: amountCents,
      paid: true,
      notes,
      category_id: body.categoryId ?? null,
      account_id: body.organizzeAccountId,
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

    const created = await this.organizze.createTransaction({
      description,
      date: body.date,
      amount_cents: amountCents,
      paid: true,
      notes,
      category_id: body.categoryId ?? null,
      credit_card_id: body.organizzeCreditCardId,
      credit_card_invoice_id: body.invoiceId,
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
