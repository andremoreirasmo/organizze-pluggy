import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ReviewDecisionType } from '@prisma/client';
import type { Account, Transaction as PluggyTransaction } from 'pluggy-sdk';
import { OrganizzeService } from '../organizze/organizze.service';
import {
  OrganizzeTransaction,
} from '../organizze/organizze.types';
import {
  normalizeCardNumber,
  resolveCardNickname,
  transactionCardNumber,
  expandPluggyAccountsForMapping,
} from '../pluggy/pluggy-accounts';
import { PluggyService } from '../pluggy/pluggy.service';
import { PrismaService } from '../prisma/prisma.module';
import { SettingsService } from '../settings/settings.service';
import {
  AccountMap,
  ActiveAccountMap,
  isActiveAccountMap,
} from '../settings/settings.types';
import { startPerf } from '../common/perf';
import {
  MatchCandidate,
  QueuePluggyTransaction,
  ReconciliationKind,
  ReconciliationQueueResponse,
  TransferCounterpartHint,
  daysBetween,
  looksLikeInvoicePayment,
  looksLikeSamePersonTransfer,
  parseDateOnly,
  scoreMatch,
  toAmountCents,
  toOrganizzeAmountCents,
} from './reconciliation.types';

export type IgnoredTransactionSnapshot = {
  description: string;
  amountCents: number;
  organizzeAmountCents: number;
  date: string;
  accountName: string;
  kind: ReconciliationKind;
  installmentNumber: number | null;
  totalInstallments: number | null;
};

export type IgnoredTransactionItem = {
  id: string;
  pluggyTransactionId: string;
  providerId: string | null;
  notes: string | null;
  createdAt: string;
  snapshot: IgnoredTransactionSnapshot | null;
};

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly organizze: OrganizzeService,
    private readonly pluggy: PluggyService,
  ) {}

  async getQueue(from: string, to: string): Promise<ReconciliationQueueResponse> {
    const perf = startPerf(`getQueue ${from}..${to}`);
    this.requireDateRange(from, to);
    const appSettings = await this.settings.getSettings();
    perf.mark('settings');
    const mapsByPluggyId = new Map(
      appSettings.accountMaps.map((map) => [map.pluggyAccountId, map]),
    );

    const pluggyAccounts = await this.pluggy.listAccounts().catch((error) => {
      this.logger.warn(`Could not list Pluggy accounts: ${String(error)}`);
      return [] as Awaited<ReturnType<PluggyService['listAccounts']>>;
    });
    const allPluggyAccounts = expandPluggyAccountsForMapping(pluggyAccounts);
    perf.mark(`listAccounts n=${allPluggyAccounts.length}`);
    const unmappedPluggyAccounts = allPluggyAccounts
      .filter((account) => !mapsByPluggyId.has(account.id))
      .map((account) => ({
        id: account.id,
        name: account.name,
        type: account.type ?? null,
        subtype: account.subtype ?? null,
      }));

    const activeMaps = appSettings.accountMaps.filter(isActiveAccountMap);
    const mappedAccountIds = activeMaps.map((map) => map.pluggyAccountId);
    if (mappedAccountIds.length === 0) {
      perf.end('no active maps');
      return {
        from,
        to,
        items: [],
        unmappedPluggyAccounts,
      };
    }

    const decided = await this.prisma.reviewDecision.findMany({
      select: { pluggyTransactionId: true },
    });
    const decidedIds = new Set(decided.map((row) => row.pluggyTransactionId));
    perf.mark(`decided n=${decidedIds.size}`);

    const [organizzePool, accountNameById, creditCardNameById, categoryNameById] =
      await Promise.all([
        this.loadOrganizzeCandidates(from, to, activeMaps),
        this.loadOrganizzeAccountNames(),
        this.loadOrganizzeCreditCardNames(),
        this.loadOrganizzeCategoryNames(),
      ]);
    perf.mark(
      `organizzePool+lookups n=${organizzePool.length} accounts=${accountNameById.size} cards=${creditCardNameById.size} cats=${categoryNameById.size}`,
    );
    const linkedPluggyIds = new Set<string>();
    for (const tx of organizzePool) {
      for (const id of this.organizze.extractPluggyIds(tx.notes)) {
        linkedPluggyIds.add(id);
      }
    }

    const pluggyBundles = await this.pluggy.listTransactionsForAccounts({
      accountIds: mappedAccountIds,
      dateFrom: from,
      dateTo: to,
      accounts: pluggyAccounts,
    });
    const pluggyTxCount = pluggyBundles.reduce(
      (sum, bundle) => sum + bundle.transactions.length,
      0,
    );
    perf.mark(
      `pluggyBundles bundles=${pluggyBundles.length} txs=${pluggyTxCount}`,
    );

    const items: ReconciliationQueueResponse['items'] = [];

    for (const bundle of pluggyBundles) {
      const map = mapsByPluggyId.get(bundle.mapKey);
      if (!map || !isActiveAccountMap(map)) {
        continue;
      }

      for (const tx of bundle.transactions) {
        if (decidedIds.has(tx.id) || linkedPluggyIds.has(tx.id)) {
          continue;
        }

        const cardNumber = transactionCardNumber(tx, bundle.account);
        const queueTx = this.toQueueTransaction(
          tx,
          bundle.account,
          map,
          cardNumber,
          resolveCardNickname(map, cardNumber),
        );
        const suggestions = this.buildSuggestions(
          queueTx,
          organizzePool,
          appSettings.amountTolerancePercent,
          appSettings.dateToleranceDays,
          accountNameById,
          creditCardNameById,
          categoryNameById,
        );

        items.push({ pluggy: queueTx, suggestions });
      }
    }

    this.attachTransferCounterparts(items);

    items.sort((a, b) => {
      const dateCmp = b.pluggy.date.localeCompare(a.pluggy.date);
      if (dateCmp !== 0) {
        return dateCmp;
      }
      return Math.abs(b.pluggy.amountCents) - Math.abs(a.pluggy.amountCents);
    });
    perf.mark(`match+sort items=${items.length}`);
    perf.end();

    return {
      from,
      to,
      items,
      unmappedPluggyAccounts,
    };
  }

  async linkTransaction(
    pluggyTxId: string,
    body: {
      organizzeTransactionId: number;
      syncDate?: boolean;
      syncAmount?: boolean;
      amountCents?: number;
      from: string;
      to: string;
    },
  ) {
    const perf = startPerf(`link ${pluggyTxId}`);
    const queueItem = await this.resolvePendingPluggyTransaction(
      pluggyTxId,
      body.from,
      body.to,
    );
    perf.mark('resolvePending');
    const existing = await this.organizze.getTransaction(
      body.organizzeTransactionId,
    );
    perf.mark('organizze.getTransaction');

    const payload: {
      paid: boolean;
      notes: string;
      date?: string;
      amount_cents?: number;
    } = {
      paid: true,
      notes: this.organizze.appendPluggyMarker(existing.notes, pluggyTxId),
    };

    if (body.syncDate) {
      payload.date = queueItem.pluggy.date.slice(0, 10);
    }
    if (body.amountCents !== undefined) {
      payload.amount_cents = body.amountCents;
    } else if (body.syncAmount) {
      payload.amount_cents = queueItem.pluggy.organizzeAmountCents;
    }

    const updated = await this.organizze.updateTransaction(
      body.organizzeTransactionId,
      payload,
    );
    perf.mark('organizze.updateTransaction');

    await this.upsertDecision(
      pluggyTxId,
      queueItem.pluggy.providerId,
      ReviewDecisionType.LINKED,
    );
    perf.mark('upsertDecision');
    perf.end(`ozTx=${body.organizzeTransactionId}`);

    return { organizzeTransaction: updated, pluggy: queueItem.pluggy };
  }

  async importTransaction(
    pluggyTxId: string,
    body: {
      from: string;
      to: string;
      description?: string;
      categoryId?: number | null;
      accountId?: number | null;
      creditCardId?: number | null;
      creditCardInvoiceId?: number | null;
      paid?: boolean;
      amountCents?: number;
    },
  ) {
    const perf = startPerf(`import ${pluggyTxId}`);
    const queueItem = await this.resolvePendingPluggyTransaction(
      pluggyTxId,
      body.from,
      body.to,
    );
    perf.mark('resolvePending');
    const pluggy = queueItem.pluggy;
    const notes = this.organizze.appendPluggyMarker(null, pluggyTxId);
    const amountCents =
      body.amountCents !== undefined
        ? body.amountCents
        : pluggy.organizzeAmountCents;

    if (pluggy.kind === 'credit_purchase' || body.creditCardId) {
      const creditCardId =
        body.creditCardId ??
        (pluggy.mappedTargetType === 'credit_card'
          ? pluggy.mappedOrganizzeTargetId
          : null);
      if (!creditCardId) {
        throw new BadRequestException(
          'creditCardId is required to import a credit card purchase',
        );
      }

      const created = await this.organizze.createTransaction({
        description: this.buildImportDescription(pluggy, body.description),
        date: pluggy.date.slice(0, 10),
        amount_cents: amountCents,
        paid: body.paid ?? true,
        notes,
        category_id: body.categoryId ?? null,
        credit_card_id: creditCardId,
        credit_card_invoice_id: body.creditCardInvoiceId ?? null,
        installment: pluggy.installmentNumber ?? 1,
        total_installments: pluggy.totalInstallments ?? 1,
      });
      perf.mark('organizze.createTransaction');

      await this.upsertDecision(
        pluggyTxId,
        pluggy.providerId,
        ReviewDecisionType.IMPORTED,
      );
      perf.mark('upsertDecision');
      perf.end(`creditCardId=${creditCardId}`);

      return { organizzeTransaction: created, pluggy };
    }

    const accountId =
      body.accountId ??
      (pluggy.mappedTargetType === 'account'
        ? pluggy.mappedOrganizzeTargetId
        : null);
    if (!accountId) {
      throw new BadRequestException(
        'accountId is required to import a bank transaction',
      );
    }

    const created = await this.organizze.createTransaction({
      description: body.description?.trim() || pluggy.description,
      date: pluggy.date.slice(0, 10),
      amount_cents: amountCents,
      paid: body.paid ?? true,
      notes,
      category_id: body.categoryId ?? null,
      account_id: accountId,
    });
    perf.mark('organizze.createTransaction');

    await this.upsertDecision(
      pluggyTxId,
      pluggy.providerId,
      ReviewDecisionType.IMPORTED,
    );
    perf.mark('upsertDecision');
    perf.end(`accountId=${accountId}`);

    return { organizzeTransaction: created, pluggy };
  }

  async createInvoicePayment(
    pluggyTxId: string,
    body: {
      from: string;
      to: string;
      creditCardId: number;
      invoiceId: number;
      accountId?: number;
      categoryId?: number | null;
    },
  ) {
    const queueItem = await this.resolvePendingPluggyTransaction(
      pluggyTxId,
      body.from,
      body.to,
    );
    const pluggy = queueItem.pluggy;

    const accountId =
      body.accountId ??
      (pluggy.mappedTargetType === 'account'
        ? pluggy.mappedOrganizzeTargetId
        : null);
    if (!accountId) {
      throw new BadRequestException(
        'accountId is required for invoice payment (source bank account)',
      );
    }

    const notes = this.organizze.appendPluggyMarker(null, pluggyTxId);
    const amountCents = pluggy.organizzeAmountCents;

    const created = await this.organizze.createInvoicePayment(
      body.creditCardId,
      body.invoiceId,
      {
        account_id: accountId,
        amount_cents: amountCents,
        date: pluggy.date.slice(0, 10),
        notes,
        category_id: body.categoryId ?? null,
      },
    );

    await this.upsertDecision(
      pluggyTxId,
      pluggy.providerId,
      ReviewDecisionType.INVOICE_PAYMENT,
    );

    return { organizzeTransaction: created, pluggy };
  }

  async createAccountTransfer(
    pluggyTxId: string,
    body: {
      from: string;
      to: string;
      otherAccountId: number;
      description?: string;
      counterpartPluggyId?: string;
      amountCents?: number;
    },
  ) {
    const perf = startPerf(`transfer ${pluggyTxId}`);
    const queueItem = await this.resolvePendingPluggyTransaction(
      pluggyTxId,
      body.from,
      body.to,
    );
    perf.mark('resolvePending');
    const pluggy = queueItem.pluggy;

    if (pluggy.mappedTargetType !== 'account') {
      throw new BadRequestException(
        'Transferências entre contas só são permitidas para contas bancárias mapeadas',
      );
    }

    if (
      pluggy.kind !== 'same_person_transfer' &&
      pluggy.kind !== 'bank'
    ) {
      throw new BadRequestException(
        'Este lançamento não pode ser registrado como transferência entre contas',
      );
    }

    const sourceAccountId = pluggy.mappedOrganizzeTargetId;
    const otherAccountId = body.otherAccountId;
    if (!otherAccountId || otherAccountId === sourceAccountId) {
      throw new BadRequestException(
        'Selecione a outra conta do Organizze para a transferência',
      );
    }

    let counterpart: QueuePluggyTransaction | null = null;
    if (body.counterpartPluggyId) {
      if (body.counterpartPluggyId === pluggyTxId) {
        throw new BadRequestException(
          'counterpartPluggyId não pode ser o mesmo lançamento',
        );
      }
      const counterpartItem = await this.resolvePendingPluggyTransaction(
        body.counterpartPluggyId,
        body.from,
        body.to,
      );
      counterpart = counterpartItem.pluggy;
      if (counterpart.mappedTargetType !== 'account') {
        throw new BadRequestException(
          'A contraparte da transferência precisa ser uma conta bancária',
        );
      }
      if (counterpart.mappedOrganizzeTargetId !== otherAccountId) {
        throw new BadRequestException(
          'A conta selecionada não corresponde à contraparte Open Finance',
        );
      }
      if (
        Math.abs(counterpart.organizzeAmountCents) !==
          Math.abs(pluggy.organizzeAmountCents) ||
        Math.sign(counterpart.organizzeAmountCents) ===
          Math.sign(pluggy.organizzeAmountCents)
      ) {
        throw new BadRequestException(
          'A contraparte Open Finance não casa em valor/sinal com este lançamento',
        );
      }
      perf.mark('resolveCounterpart');
    }

    const transferAmountCents =
      body.amountCents !== undefined
        ? Math.abs(body.amountCents)
        : Math.abs(pluggy.organizzeAmountCents);
    if (transferAmountCents <= 0) {
      throw new BadRequestException('amountCents must be a positive value');
    }
    const debitAccountId =
      pluggy.organizzeAmountCents < 0 ? sourceAccountId : otherAccountId;
    const creditAccountId =
      pluggy.organizzeAmountCents < 0 ? otherAccountId : sourceAccountId;

    let notes = this.organizze.appendPluggyMarker(null, pluggyTxId);
    if (counterpart) {
      notes = this.organizze.appendPluggyMarker(notes, counterpart.id);
    }

    const description =
      body.description?.trim() ||
      pluggy.description ||
      'Transferência entre contas';

    const created = await this.organizze.createTransfer({
      description,
      date: pluggy.date.slice(0, 10),
      amount_cents: transferAmountCents,
      debit_account_id: debitAccountId,
      credit_account_id: creditAccountId,
      paid: true,
      notes,
    });
    perf.mark('organizze.createTransfer');

    const oppositeId = created.oposite_transaction_id ?? null;
    if (oppositeId) {
      await this.organizze.updateTransaction(oppositeId, { notes });
      perf.mark('organizze.updateOppositeNotes');
    }

    await this.upsertDecision(
      pluggyTxId,
      pluggy.providerId,
      ReviewDecisionType.IMPORTED,
      counterpart
        ? `transfer+counterpart:${counterpart.id}`
        : `transfer→${creditAccountId}`,
    );
    if (counterpart) {
      await this.upsertDecision(
        counterpart.id,
        counterpart.providerId,
        ReviewDecisionType.IMPORTED,
        `transfer+counterpart:${pluggyTxId}`,
      );
    }
    perf.mark('upsertDecision');
    perf.end(
      `debit=${debitAccountId} credit=${creditAccountId} counterpart=${counterpart?.id ?? 'none'}`,
    );

    return {
      organizzeTransaction: created,
      pluggy,
      counterpartPluggyId: counterpart?.id ?? null,
    };
  }

  async ignoreTransaction(
    pluggyTxId: string,
    body: { from: string; to: string; notes?: string },
  ) {
    const queueItem = await this.resolvePendingPluggyTransaction(
      pluggyTxId,
      body.from,
      body.to,
    );
    const snapshot = this.toIgnoredSnapshot(queueItem.pluggy);
    await this.upsertDecision(
      pluggyTxId,
      queueItem.pluggy.providerId,
      ReviewDecisionType.IGNORED,
      body.notes,
      snapshot,
    );
    return { ignored: true as const, pluggy: queueItem.pluggy };
  }

  async listIgnored(): Promise<{ items: IgnoredTransactionItem[] }> {
    const rows = await this.prisma.reviewDecision.findMany({
      where: { decision: ReviewDecisionType.IGNORED },
      orderBy: { updatedAt: 'desc' },
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        pluggyTransactionId: row.pluggyTransactionId,
        providerId: row.providerId,
        notes: row.notes,
        createdAt: row.createdAt.toISOString(),
        snapshot: this.parseIgnoredSnapshot(row.snapshot),
      })),
    };
  }

  async unignoreTransaction(pluggyTxId: string): Promise<{ restored: true }> {
    const existing = await this.prisma.reviewDecision.findUnique({
      where: { pluggyTransactionId: pluggyTxId },
    });
    if (!existing || existing.decision !== ReviewDecisionType.IGNORED) {
      throw new NotFoundException('Ignored transaction not found');
    }
    await this.prisma.reviewDecision.delete({
      where: { pluggyTransactionId: pluggyTxId },
    });
    return { restored: true as const };
  }

  private async resolvePendingPluggyTransaction(
    pluggyTxId: string,
    from: string,
    to: string,
  ): Promise<{ pluggy: QueuePluggyTransaction }> {
    const perf = startPerf(`resolvePending ${pluggyTxId}`);
    this.requireDateRange(from, to);

    const decided = await this.prisma.reviewDecision.findUnique({
      where: { pluggyTransactionId: pluggyTxId },
      select: { pluggyTransactionId: true },
    });
    if (decided) {
      perf.end('already decided');
      throw new NotFoundException(
        `Pluggy transaction ${pluggyTxId} not found in pending queue for ${from}..${to}`,
      );
    }
    perf.mark('decision check');

    const appSettings = await this.settings.getSettings();
    const activeMaps = appSettings.accountMaps.filter(isActiveAccountMap);
    if (activeMaps.length === 0) {
      perf.end('no active maps');
      throw new NotFoundException(
        `Pluggy transaction ${pluggyTxId} not found in pending queue for ${from}..${to}`,
      );
    }
    const mapsByPluggyId = new Map(
      activeMaps.map((map) => [map.pluggyAccountId, map]),
    );
    perf.mark('settings');

    const accounts = await this.pluggy.listAccounts();
    perf.mark(`accounts n=${accounts.length}`);

    const bundles = await this.pluggy.listTransactionsForAccounts({
      accountIds: activeMaps.map((map) => map.pluggyAccountId),
      dateFrom: from,
      dateTo: to,
      accounts,
    });
    const txCount = bundles.reduce(
      (sum, bundle) => sum + bundle.transactions.length,
      0,
    );
    perf.mark(`pluggyBundles bundles=${bundles.length} txs=${txCount}`);

    for (const bundle of bundles) {
      const map = mapsByPluggyId.get(bundle.mapKey);
      if (!map) {
        continue;
      }
      const tx = bundle.transactions.find((entry) => entry.id === pluggyTxId);
      if (!tx) {
        continue;
      }
      const cardNumber = transactionCardNumber(tx, bundle.account);
      const pluggy = this.toQueueTransaction(
        tx,
        bundle.account,
        map,
        cardNumber,
        resolveCardNickname(map, cardNumber),
      );
      perf.end('found');
      return { pluggy };
    }

    perf.end('not found');
    throw new NotFoundException(
      `Pluggy transaction ${pluggyTxId} not found in pending queue for ${from}..${to}`,
    );
  }

  private async upsertDecision(
    pluggyTransactionId: string,
    providerId: string | null,
    decision: ReviewDecisionType,
    notes?: string,
    snapshot?: IgnoredTransactionSnapshot | null,
  ): Promise<void> {
    const snapshotValue =
      snapshot === undefined
        ? undefined
        : snapshot === null
          ? Prisma.JsonNull
          : (snapshot as unknown as Prisma.InputJsonValue);

    await this.prisma.reviewDecision.upsert({
      where: { pluggyTransactionId },
      create: {
        pluggyTransactionId,
        providerId,
        decision,
        notes: notes ?? null,
        snapshot: snapshotValue === undefined ? Prisma.JsonNull : snapshotValue,
      },
      update: {
        providerId,
        decision,
        notes: notes ?? null,
        ...(snapshotValue !== undefined ? { snapshot: snapshotValue } : {}),
      },
    });
  }

  private formatAccountLabel(pluggy: QueuePluggyTransaction): string {
    const parts = [pluggy.accountNickname?.trim() || pluggy.accountName];
    if (pluggy.accountNumberLast4) {
      parts.push(`final ${pluggy.accountNumberLast4}`);
    }
    return parts.join(' · ');
  }

  private toIgnoredSnapshot(
    pluggy: QueuePluggyTransaction,
  ): IgnoredTransactionSnapshot {
    return {
      description: pluggy.description,
      amountCents: pluggy.amountCents,
      organizzeAmountCents: pluggy.organizzeAmountCents,
      date: pluggy.date,
      accountName: this.formatAccountLabel(pluggy),
      kind: pluggy.kind,
      installmentNumber: pluggy.installmentNumber,
      totalInstallments: pluggy.totalInstallments,
    };
  }

  private parseIgnoredSnapshot(value: Prisma.JsonValue | null): IgnoredTransactionSnapshot | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const data = value as Record<string, unknown>;
    if (typeof data.description !== 'string' || typeof data.date !== 'string') {
      return null;
    }
    return {
      description: data.description,
      amountCents:
        typeof data.amountCents === 'number' ? data.amountCents : 0,
      organizzeAmountCents:
        typeof data.organizzeAmountCents === 'number'
          ? data.organizzeAmountCents
          : typeof data.amountCents === 'number'
            ? data.amountCents
            : 0,
      date: data.date,
      accountName:
        typeof data.accountName === 'string' ? data.accountName : 'Conta',
      kind:
        data.kind === 'credit_purchase' ||
        data.kind === 'invoice_payment_candidate' ||
        data.kind === 'same_person_transfer' ||
        data.kind === 'bank'
          ? data.kind
          : 'bank',
      installmentNumber:
        typeof data.installmentNumber === 'number'
          ? data.installmentNumber
          : null,
      totalInstallments:
        typeof data.totalInstallments === 'number'
          ? data.totalInstallments
          : null,
    };
  }

  private async loadOrganizzeAccountNames(): Promise<Map<number, string>> {
    try {
      const accounts = await this.organizze.listAccounts({
        includeArchived: true,
      });
      return new Map(accounts.map((account) => [account.id, account.name]));
    } catch (error) {
      this.logger.warn(
        `Could not list Organizze accounts for suggestion labels: ${String(error)}`,
      );
      return new Map();
    }
  }

  private async loadOrganizzeCreditCardNames(): Promise<Map<number, string>> {
    try {
      const cards = await this.organizze.listCreditCards({
        includeArchived: true,
      });
      return new Map(cards.map((card) => [card.id, card.name]));
    } catch (error) {
      this.logger.warn(
        `Could not list Organizze credit cards for suggestion labels: ${String(error)}`,
      );
      return new Map();
    }
  }

  private async loadOrganizzeCategoryNames(): Promise<Map<number, string>> {
    try {
      const categories = await this.organizze.listCategories({
        includeArchived: true,
      });
      return new Map(
        categories.map((category) => [category.id, category.name]),
      );
    } catch (error) {
      this.logger.warn(
        `Could not list Organizze categories for suggestion labels: ${String(error)}`,
      );
      return new Map();
    }
  }

  private async loadOrganizzeCandidates(
    from: string,
    to: string,
    maps: AccountMap[],
  ): Promise<OrganizzeTransaction[]> {
    const byId = new Map<number, OrganizzeTransaction>();

    // Widen the search window so card installments dated near month
    // boundaries still enter the suggestion pool.
    const hasCreditMaps = maps.some((map) => map.targetType === 'credit_card');
    const searchFrom = hasCreditMaps
      ? this.shiftDate(from, -40)
      : from;
    const searchTo = hasCreditMaps ? this.shiftDate(to, 40) : to;

    // Always load the full list — Organizze returns both bank and
    // credit-card transactions here (credit_card_id set for card purchases).
    try {
      const all = await this.organizze.listTransactions({
        startDate: searchFrom,
        endDate: searchTo,
      });
      for (const tx of all) {
        byId.set(tx.id, tx);
      }
    } catch (error) {
      this.logger.warn(
        `Could not list Organizze transactions for ${searchFrom}..${searchTo}: ${String(error)}`,
      );
    }

    const accountIds = [
      ...new Set(
        maps
          .filter((map) => map.targetType === 'account')
          .map((map) => map.organizzeTargetId),
      ),
    ];
    const accountBatches = await Promise.all(
      accountIds.map(async (accountId) => {
        try {
          return await this.organizze.listTransactions({
            startDate: from,
            endDate: to,
            accountId,
          });
        } catch (error) {
          this.logger.warn(
            `Could not list Organizze account ${accountId}: ${String(error)}`,
          );
          return [] as OrganizzeTransaction[];
        }
      }),
    );
    for (const txs of accountBatches) {
      for (const tx of txs) {
        byId.set(tx.id, tx);
      }
    }

    const creditCardIds = [
      ...new Set(
        maps
          .filter((map) => map.targetType === 'credit_card')
          .map((map) => map.organizzeTargetId),
      ),
    ];

    const invoiceJobs = await Promise.all(
      creditCardIds.map(async (creditCardId) => {
        try {
          const invoices = await this.organizze.listInvoices(creditCardId);
          const relevant = invoices
            .filter(
              (invoice) =>
                this.invoiceOverlapsPeriod(
                  invoice.starting_date,
                  invoice.closing_date,
                  searchFrom,
                  searchTo,
                ) ||
                this.invoiceOverlapsPeriod(
                  invoice.date,
                  invoice.date,
                  searchFrom,
                  searchTo,
                ),
            )
            .sort((a, b) => b.date.localeCompare(a.date));

          // Also include nearest invoices around the period (installments may
          // sit on adjacent bills depending on closing day).
          const extras = invoices
            .filter(
              (invoice) => !relevant.some((item) => item.id === invoice.id),
            )
            .sort((a, b) => b.date.localeCompare(a.date))
            .slice(0, 4);

          return [...relevant, ...extras].slice(0, 12).map((invoice) => ({
            creditCardId,
            invoiceId: invoice.id,
          }));
        } catch (error) {
          this.logger.warn(
            `Could not list invoices for card ${creditCardId}: ${String(error)}`,
          );
          return [] as Array<{ creditCardId: number; invoiceId: number }>;
        }
      }),
    );

    const invoiceTargets = invoiceJobs.flat();
    const invoiceDetails = await Promise.all(
      invoiceTargets.map(async ({ creditCardId, invoiceId }) => {
        try {
          return await this.organizze.getInvoice(creditCardId, invoiceId);
        } catch (error) {
          this.logger.warn(
            `Could not load invoice ${invoiceId} for card ${creditCardId}: ${String(error)}`,
          );
          return null;
        }
      }),
    );

    for (const detail of invoiceDetails) {
      if (!detail) {
        continue;
      }
      for (const tx of detail.transactions ?? []) {
        byId.set(tx.id, tx);
      }
      for (const tx of detail.payments ?? []) {
        byId.set(tx.id, tx);
      }
    }

    return [...byId.values()];
  }

  private shiftDate(value: string, days: number): string {
    const date = parseDateOnly(value);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  private invoiceOverlapsPeriod(
    start: string,
    end: string,
    from: string,
    to: string,
  ): boolean {
    const s = start.slice(0, 10);
    const e = end.slice(0, 10);
    return s <= to && e >= from;
  }

  private extractAccountLast4(
    account: Account,
    cardNumber?: string | null,
  ): string | null {
    const fromTx = normalizeCardNumber(cardNumber);
    if (fromTx) {
      return fromTx;
    }
    const candidates: string[] = [];
    if (account.number) {
      candidates.push(account.number);
    }
    for (const limit of account.creditData?.disaggregatedCreditLimits ?? []) {
      if (limit.identificationNumber) {
        candidates.push(limit.identificationNumber);
      }
    }
    for (const value of candidates) {
      const digits = value.replace(/\D/g, '');
      if (digits.length >= 4) {
        return digits.slice(-4);
      }
    }
    return null;
  }

  private toQueueTransaction(
    tx: PluggyTransaction,
    account: Account,
    map: ActiveAccountMap,
    cardNumber?: string | null,
    accountNickname?: string | null,
  ): QueuePluggyTransaction {
    const description =
      tx.description ?? tx.merchant?.name ?? tx.category ?? 'Sem descrição';
    const amount = typeof tx.amount === 'number' ? tx.amount : 0;
    const dateSource =
      tx.date instanceof Date ? tx.date.toISOString() : String(tx.date);
    const date = dateSource.slice(0, 10);
    const accountType = account.type ?? null;
    const operationType =
      typeof tx.operationType === 'string' ? tx.operationType : null;
    const meta = tx.creditCardMetadata;
    const installmentNumber =
      typeof meta?.installmentNumber === 'number' ? meta.installmentNumber : null;
    const totalInstallments =
      typeof meta?.totalInstallments === 'number' ? meta.totalInstallments : null;
    const purchaseDate =
      meta?.purchaseDate instanceof Date
        ? meta.purchaseDate.toISOString().slice(0, 10)
        : meta?.purchaseDate
          ? String(meta.purchaseDate).slice(0, 10)
          : null;
    const totalPurchaseAmount =
      typeof meta?.totalAmount === 'number' ? meta.totalAmount : null;
    const resolvedCardNumber =
      cardNumber ?? transactionCardNumber(tx, account);

    let kind: ReconciliationKind = 'bank';
    const category = tx.category ?? null;
    if ((accountType ?? '').toUpperCase() === 'CREDIT') {
      kind = 'credit_purchase';
    } else if (
      looksLikeSamePersonTransfer({
        accountType,
        operationType,
        category,
        description,
      })
    ) {
      kind = 'same_person_transfer';
    } else if (
      looksLikeInvoicePayment({
        accountType,
        operationType,
        description,
        amount,
      })
    ) {
      kind = 'invoice_payment_candidate';
    }

    const amountCents = toAmountCents(amount);
    const amountInAccountCurrency =
      typeof tx.amountInAccountCurrency === 'number'
        ? tx.amountInAccountCurrency
        : null;
    const amountInAccountCurrencyCents =
      amountInAccountCurrency === null
        ? null
        : toAmountCents(amountInAccountCurrency);
    const accountAmountCents = amountInAccountCurrencyCents ?? amountCents;
    const currencyCode = tx.currencyCode ?? null;
    const owner = account.owner?.trim() || null;

    return {
      id: tx.id,
      providerId: tx.providerId ?? null,
      description,
      amount,
      amountCents,
      organizzeAmountCents: toOrganizzeAmountCents(accountAmountCents, kind),
      date: date.slice(0, 10),
      currencyCode,
      amountInAccountCurrency,
      amountInAccountCurrencyCents,
      type: tx.type ?? null,
      operationType,
      category,
      accountId: account.id,
      accountName: account.name,
      accountType,
      accountSubtype: account.subtype ?? null,
      kind,
      mappedTargetType: map.targetType,
      mappedOrganizzeTargetId: map.organizzeTargetId,
      accountNumberLast4: this.extractAccountLast4(account, resolvedCardNumber),
      accountOwner: owner,
      accountNickname: accountNickname ?? resolveCardNickname(map, resolvedCardNumber),
      installmentNumber,
      totalInstallments,
      purchaseDate,
      totalPurchaseAmount,
      transferCounterpart: null,
    };
  }

  private attachTransferCounterparts(
    items: ReconciliationQueueResponse['items'],
  ): void {
    const transfers = items.filter(
      (item) =>
        item.pluggy.kind === 'same_person_transfer' &&
        item.pluggy.mappedTargetType === 'account',
    );

    for (let i = 0; i < transfers.length; i += 1) {
      const item = transfers[i];
      if (item.pluggy.transferCounterpart) {
        continue;
      }

      const absAmount = Math.abs(item.pluggy.organizzeAmountCents);
      const sign = Math.sign(item.pluggy.organizzeAmountCents);

      for (let j = i + 1; j < transfers.length; j += 1) {
        const other = transfers[j];
        if (other.pluggy.transferCounterpart) {
          continue;
        }
        if (
          other.pluggy.mappedOrganizzeTargetId ===
          item.pluggy.mappedOrganizzeTargetId
        ) {
          continue;
        }
        if (Math.abs(other.pluggy.organizzeAmountCents) !== absAmount) {
          continue;
        }
        if (Math.sign(other.pluggy.organizzeAmountCents) === sign) {
          continue;
        }
        if (daysBetween(item.pluggy.date, other.pluggy.date) > 1) {
          continue;
        }

        const toHint = (
          source: QueuePluggyTransaction,
        ): TransferCounterpartHint => ({
          pluggyId: source.id,
          accountName: source.accountName,
          accountNickname: source.accountNickname,
          accountNumberLast4: source.accountNumberLast4,
          mappedOrganizzeTargetId: source.mappedOrganizzeTargetId,
          organizzeAmountCents: source.organizzeAmountCents,
          date: source.date,
        });

        item.pluggy.transferCounterpart = toHint(other.pluggy);
        other.pluggy.transferCounterpart = toHint(item.pluggy);
        break;
      }
    }
  }

  private buildImportDescription(
    pluggy: QueuePluggyTransaction,
    override?: string,
  ): string {
    const base = override?.trim() || pluggy.description;
    const total = pluggy.totalInstallments ?? 0;
    const current = pluggy.installmentNumber ?? 0;
    if (total <= 1 || current <= 0) {
      return base;
    }
    if (/\d+\s*\/\s*\d+/.test(base)) {
      return base;
    }
    return `${base} (${current}/${total})`;
  }

  private buildSuggestions(
    pluggy: QueuePluggyTransaction,
    organizzePool: OrganizzeTransaction[],
    amountTolerancePercent: number,
    dateToleranceDays: number,
    accountNameById: Map<number, string>,
    creditCardNameById: Map<number, string>,
    categoryNameById: Map<number, string>,
  ): MatchCandidate[] {
    const candidates: MatchCandidate[] = [];

    for (const oz of organizzePool) {
      if (this.organizze.notesContainPluggyId(oz.notes, pluggy.id)) {
        continue;
      }

      if (pluggy.kind === 'credit_purchase') {
        if (!oz.credit_card_id) {
          continue;
        }
        if (
          pluggy.mappedTargetType === 'credit_card' &&
          oz.credit_card_id !== pluggy.mappedOrganizzeTargetId
        ) {
          continue;
        }
      } else if (pluggy.kind === 'invoice_payment_candidate') {
        // Prefer existing unpaid payment-like txs or any bank tx on mapped account
        if (oz.credit_card_id && !oz.paid_credit_card_id) {
          continue;
        }
      } else if (pluggy.mappedTargetType === 'account' && oz.account_id) {
        if (oz.account_id !== pluggy.mappedOrganizzeTargetId) {
          continue;
        }
      }

      const score = scoreMatch({
        pluggyAmountCents: pluggy.organizzeAmountCents,
        pluggyDate: pluggy.date,
        pluggyPurchaseDate: pluggy.purchaseDate,
        pluggyDescription: pluggy.description,
        pluggyInstallmentNumber: pluggy.installmentNumber,
        pluggyTotalInstallments: pluggy.totalInstallments,
        organizzeAmountCents: oz.amount_cents,
        organizzeDate: oz.date,
        organizzeDescription: oz.description,
        organizzeInstallment: oz.installment,
        organizzeTotalInstallments: oz.total_installments,
        paid: oz.paid,
        recurring: oz.recurring,
        amountTolerancePercent,
        dateToleranceDays,
        kind: pluggy.kind,
      });

      if (score === null) {
        continue;
      }

      candidates.push({
        organizzeTransactionId: oz.id,
        description: oz.description,
        date: oz.date,
        amountCents: oz.amount_cents,
        paid: oz.paid,
        recurring: oz.recurring,
        accountId: oz.account_id,
        accountName: oz.account_id
          ? (accountNameById.get(oz.account_id) ?? null)
          : null,
        creditCardId: oz.credit_card_id,
        creditCardName: oz.credit_card_id
          ? (creditCardNameById.get(oz.credit_card_id) ?? null)
          : null,
        creditCardInvoiceId: oz.credit_card_invoice_id,
        categoryId: oz.category_id,
        categoryName: oz.category_id
          ? (categoryNameById.get(oz.category_id) ?? null)
          : null,
        installment: oz.installment ?? null,
        totalInstallments: oz.total_installments ?? null,
        score,
        amountDiffCents: Math.abs(
          Math.abs(pluggy.organizzeAmountCents) - Math.abs(oz.amount_cents),
        ),
        daysDiff: Math.min(
          daysBetween(pluggy.date, oz.date),
          pluggy.purchaseDate
            ? daysBetween(pluggy.purchaseDate, oz.date)
            : Number.POSITIVE_INFINITY,
        ),
      });
    }

    return candidates
      .sort((a, b) => {
        if (a.amountDiffCents !== b.amountDiffCents) {
          return a.amountDiffCents - b.amountDiffCents;
        }
        return b.score - a.score;
      })
      .slice(0, 10);
  }

  private requireDateRange(from: string, to: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new BadRequestException('from/to must be YYYY-MM-DD');
    }
    if (from > to) {
      throw new BadRequestException('from must be <= to');
    }
  }
}
