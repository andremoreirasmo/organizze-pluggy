import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ReviewDecisionType } from '@prisma/client';
import type { Account, Transaction as PluggyTransaction } from 'pluggy-sdk';
import { OrganizzeService } from '../organizze/organizze.service';
import { normalizeOrganizzeTagNames } from '../organizze/organizze-tags';
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

export type DecisionSnapshot = {
  description: string;
  amountCents: number;
  /** Valor Open Finance já no referencial Organizze (centavos). */
  organizzeAmountCents: number;
  date: string;
  accountName: string;
  kind: ReconciliationKind;
  installmentNumber: number | null;
  totalInstallments: number | null;
  organizzeTransactionId: number | null;
  organizzeDescription: string | null;
  /** Conta/cartão Organizze onde ficou o lançamento. */
  organizzeAccountName: string | null;
  /** Destino no Organizze: conta bancária ou cartão. */
  organizzeTargetType: 'account' | 'credit_card' | null;
  /** Valor efetivo no lançamento Organizze após vincular/importar. */
  organizzeLinkedAmountCents: number | null;
  /** Lançamento fixo/recorrente no Organizze (desfazer = não pago). */
  organizzeRecurring: boolean | null;
  wasPaidBeforeLink: boolean | null;
};

/** @deprecated alias — same shape used by ignore list */
export type IgnoredTransactionSnapshot = DecisionSnapshot;

export type IgnoredTransactionItem = {
  id: string;
  pluggyTransactionId: string;
  providerId: string | null;
  notes: string | null;
  createdAt: string;
  snapshot: DecisionSnapshot | null;
};

export type DoneDecisionType = 'LINKED' | 'IMPORTED' | 'INVOICE_PAYMENT';

export type DoneTransactionItem = {
  id: string;
  pluggyTransactionId: string;
  providerId: string | null;
  decision: DoneDecisionType;
  notes: string | null;
  createdAt: string;
  snapshot: DecisionSnapshot | null;
};

const DONE_DECISIONS: ReviewDecisionType[] = [
  ReviewDecisionType.LINKED,
  ReviewDecisionType.IMPORTED,
  ReviewDecisionType.INVOICE_PAYMENT,
];

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
      accountId?: number;
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
      account_id?: number;
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
    if (body.accountId !== undefined) {
      payload.account_id = body.accountId;
    }

    const updated = await this.organizze.updateTransaction(
      body.organizzeTransactionId,
      payload,
    );
    perf.mark('organizze.updateTransaction');

    const [accountNames, cardNames] = await Promise.all([
      this.loadOrganizzeAccountNames(),
      this.loadOrganizzeCreditCardNames(),
    ]);
    // Capture Open Finance amounts before any Organizze write so the done
    // card can show OF ≠ Organizze when the user linked with a different value
    // (e.g. Buscar lançamento).
    const pluggy = queueItem.pluggy;
    const ofAmountCents = pluggy.amountCents;
    const ofOrganizzeAmountCents = pluggy.organizzeAmountCents;
    await this.upsertDecision(
      pluggyTxId,
      pluggy.providerId,
      ReviewDecisionType.LINKED,
      undefined,
      {
        ...this.toDecisionSnapshot(pluggy, {
          organizzeTransactionId: updated.id,
          organizzeDescription: updated.description,
          organizzeAccountName: this.organizzeTxDestination(
            updated,
            accountNames,
            cardNames,
          ),
          organizzeTargetType: this.organizzeTxTargetType(updated),
          organizzeLinkedAmountCents: updated.amount_cents,
          organizzeRecurring: updated.recurring,
          wasPaidBeforeLink: existing.paid,
        }),
        amountCents: ofAmountCents,
        organizzeAmountCents: ofOrganizzeAmountCents,
      },
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
      tags?: string[];
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
    const tags = normalizeOrganizzeTagNames(body.tags);
    const [accountNames, cardNames] = await Promise.all([
      this.loadOrganizzeAccountNames(),
      this.loadOrganizzeCreditCardNames(),
    ]);

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
        ...(tags ? { tags } : {}),
      });
      perf.mark('organizze.createTransaction');

      await this.upsertDecision(
        pluggyTxId,
        pluggy.providerId,
        ReviewDecisionType.IMPORTED,
        undefined,
        this.toDecisionSnapshot(pluggy, {
          organizzeTransactionId: created.id,
          organizzeDescription: created.description,
          organizzeAccountName: this.organizzeTxDestination(
            created,
            accountNames,
            cardNames,
          ),
          organizzeTargetType: this.organizzeTxTargetType(created),
          organizzeLinkedAmountCents: created.amount_cents,
          organizzeRecurring: created.recurring,
          wasPaidBeforeLink: null,
        }),
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
      ...(tags ? { tags } : {}),
    });
    perf.mark('organizze.createTransaction');

    await this.upsertDecision(
      pluggyTxId,
      pluggy.providerId,
      ReviewDecisionType.IMPORTED,
      undefined,
      this.toDecisionSnapshot(pluggy, {
        organizzeTransactionId: created.id,
        organizzeDescription: created.description,
        organizzeAccountName: this.organizzeTxDestination(
          created,
          accountNames,
          cardNames,
        ),
        organizzeTargetType: this.organizzeTxTargetType(created),
        organizzeLinkedAmountCents: created.amount_cents,
        organizzeRecurring: created.recurring,
        wasPaidBeforeLink: null,
      }),
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

    const cards = await this.organizze.listCreditCards({
      includeArchived: true,
    });
    const card = cards.find((entry) => entry.id === body.creditCardId) ?? null;
    const cardPaymentAccountId =
      typeof card?.payment_account_id === 'number'
        ? card.payment_account_id
        : null;

    const accountId =
      body.accountId ??
      cardPaymentAccountId ??
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
    const accountNames = await this.loadOrganizzeAccountNames();
    const cardNames = new Map(
      cards.map((entry) => [entry.id, entry.name] as const),
    );

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
      undefined,
      this.toDecisionSnapshot(pluggy, {
        organizzeTransactionId: created.id,
        organizzeDescription: created.description,
        organizzeAccountName: this.organizzeTxDestination(
          created,
          accountNames,
          cardNames,
        ),
        organizzeTargetType: this.organizzeTxTargetType(created),
        organizzeLinkedAmountCents: created.amount_cents,
        organizzeRecurring: created.recurring,
        wasPaidBeforeLink: null,
      }),
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

    const accountNames = await this.loadOrganizzeAccountNames();
    await this.upsertDecision(
      pluggyTxId,
      pluggy.providerId,
      ReviewDecisionType.IMPORTED,
      counterpart
        ? `transfer+counterpart:${counterpart.id}`
        : `transfer→${creditAccountId}`,
      this.toDecisionSnapshot(pluggy, {
        organizzeTransactionId: created.id,
        organizzeDescription: created.description,
        organizzeAccountName: [
          accountNames.get(debitAccountId) ?? `Conta #${debitAccountId}`,
          accountNames.get(creditAccountId) ?? `Conta #${creditAccountId}`,
        ].join(' → '),
        organizzeTargetType: 'account',
        organizzeLinkedAmountCents: created.amount_cents,
        organizzeRecurring: created.recurring,
        wasPaidBeforeLink: null,
      }),
    );
    if (counterpart) {
      await this.upsertDecision(
        counterpart.id,
        counterpart.providerId,
        ReviewDecisionType.IMPORTED,
        `transfer+counterpart:${pluggyTxId}`,
        this.toDecisionSnapshot(counterpart, {
          organizzeTransactionId: oppositeId ?? created.id,
          organizzeDescription: created.description,
          organizzeAccountName: [
            accountNames.get(debitAccountId) ?? `Conta #${debitAccountId}`,
            accountNames.get(creditAccountId) ?? `Conta #${creditAccountId}`,
          ].join(' → '),
          organizzeTargetType: 'account',
          organizzeLinkedAmountCents: created.amount_cents,
          organizzeRecurring: created.recurring,
          wasPaidBeforeLink: null,
        }),
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
    const snapshot = this.toDecisionSnapshot(queueItem.pluggy);
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
        snapshot: this.parseDecisionSnapshot(row.snapshot),
      })),
    };
  }

  async listDone(
    from: string,
    to: string,
  ): Promise<{ items: DoneTransactionItem[] }> {
    this.requireDateRange(from, to);
    const rows = await this.prisma.reviewDecision.findMany({
      where: { decision: { in: DONE_DECISIONS } },
      orderBy: { updatedAt: 'desc' },
    });

    const appSettings = await this.settings.getSettings();
    const activeMaps = appSettings.accountMaps.filter(isActiveAccountMap);
    const mappedAccountIds = activeMaps.map((map) => map.pluggyAccountId);

    const [ozByPluggyId, accountNames, cardNames, pluggyById, pluggyAccounts] =
      await Promise.all([
        this.indexOrganizzeTxByPluggyId(from, to),
        this.loadOrganizzeAccountNames(),
        this.loadOrganizzeCreditCardNames(),
        this.indexPluggyTxById(from, to, mappedAccountIds, activeMaps),
        this.pluggy.listAccounts().catch(() => []),
      ]);
    const mapsByPluggyId = new Map(
      activeMaps.map((map) => [map.pluggyAccountId, map]),
    );
    const accountsById = new Map(
      pluggyAccounts.map((account) => [account.id, account]),
    );

    const items: DoneTransactionItem[] = [];
    for (const row of rows) {
      if (
        row.decision !== ReviewDecisionType.LINKED &&
        row.decision !== ReviewDecisionType.IMPORTED &&
        row.decision !== ReviewDecisionType.INVOICE_PAYMENT
      ) {
        continue;
      }
      let snapshot = this.parseDecisionSnapshot(row.snapshot);
      const ozMatch = ozByPluggyId.get(row.pluggyTransactionId) ?? null;
      let pluggyMatch = pluggyById.get(row.pluggyTransactionId) ?? null;
      if (!pluggyMatch) {
        pluggyMatch = await this.resolvePluggyTxById(
          row.pluggyTransactionId,
          mapsByPluggyId,
          accountsById,
        );
        if (pluggyMatch) {
          pluggyById.set(row.pluggyTransactionId, pluggyMatch);
        }
      }

      if (!snapshot) {
        if (!ozMatch && !pluggyMatch) {
          continue;
        }
        snapshot = {
          description:
            pluggyMatch?.description ??
            'Lançamento Open Finance',
          // Never fall back to Organizze amounts for the Open Finance side.
          amountCents: pluggyMatch?.amountCents ?? 0,
          organizzeAmountCents: pluggyMatch?.organizzeAmountCents ?? 0,
          date: (pluggyMatch?.date ?? ozMatch?.date ?? from).slice(0, 10),
          accountName: pluggyMatch
            ? this.formatAccountLabel(pluggyMatch)
            : 'Open Finance',
          kind: pluggyMatch?.kind ?? 'bank',
          installmentNumber:
            pluggyMatch?.installmentNumber ?? ozMatch?.installment ?? null,
          totalInstallments:
            pluggyMatch?.totalInstallments ??
            ozMatch?.total_installments ??
            null,
          organizzeTransactionId: ozMatch?.id ?? null,
          organizzeDescription: ozMatch?.description ?? null,
          organizzeAccountName: ozMatch
            ? this.organizzeTxDestination(ozMatch, accountNames, cardNames)
            : null,
          organizzeTargetType: ozMatch
            ? this.organizzeTxTargetType(ozMatch)
            : null,
          organizzeLinkedAmountCents: ozMatch?.amount_cents ?? null,
          organizzeRecurring: ozMatch?.recurring ?? null,
          wasPaidBeforeLink: null,
        };
      } else {
        const ozDescription =
          snapshot.organizzeDescription ?? ozMatch?.description ?? null;
        const pluggyDescription = pluggyMatch?.description?.trim() ?? '';
        const ozDescriptionTrimmed = ozDescription?.trim() ?? '';
        const descriptionLooksCopiedFromOz =
          ozDescriptionTrimmed.length > 0 &&
          snapshot.description.trim() === ozDescriptionTrimmed &&
          pluggyDescription.length > 0 &&
          pluggyDescription !== ozDescriptionTrimmed;

        snapshot = {
          ...snapshot,
          description:
            pluggyMatch &&
            (descriptionLooksCopiedFromOz || !snapshot.description.trim())
              ? pluggyMatch.description
              : snapshot.description,
          accountName: pluggyMatch
            ? this.formatAccountLabel(pluggyMatch)
            : snapshot.accountName,
          amountCents: pluggyMatch?.amountCents ?? snapshot.amountCents,
          organizzeAmountCents:
            pluggyMatch?.organizzeAmountCents ?? snapshot.organizzeAmountCents,
          kind: pluggyMatch?.kind ?? snapshot.kind,
          installmentNumber:
            pluggyMatch?.installmentNumber ?? snapshot.installmentNumber,
          totalInstallments:
            pluggyMatch?.totalInstallments ?? snapshot.totalInstallments,
          organizzeTransactionId:
            snapshot.organizzeTransactionId ?? ozMatch?.id ?? null,
          organizzeDescription: ozDescription,
          organizzeAccountName:
            snapshot.organizzeAccountName ??
            (ozMatch
              ? this.organizzeTxDestination(ozMatch, accountNames, cardNames)
              : null),
          organizzeTargetType:
            snapshot.organizzeTargetType ??
            (ozMatch ? this.organizzeTxTargetType(ozMatch) : null),
          // Prefer live Organizze amount so the compare stays accurate after edits.
          organizzeLinkedAmountCents:
            ozMatch?.amount_cents ??
            snapshot.organizzeLinkedAmountCents ??
            null,
          organizzeRecurring:
            snapshot.organizzeRecurring ?? ozMatch?.recurring ?? null,
        };
      }

      const date = snapshot.date.slice(0, 10);
      if (date < from || date > to) {
        continue;
      }

      items.push({
        id: row.id,
        pluggyTransactionId: row.pluggyTransactionId,
        providerId: row.providerId,
        decision: row.decision,
        notes: row.notes,
        createdAt: row.createdAt.toISOString(),
        snapshot,
      });
    }

    return { items };
  }

  async undoDoneTransaction(
    pluggyTxId: string,
    body: { from: string; to: string },
  ): Promise<{ restored: true }> {
    this.requireDateRange(body.from, body.to);
    const existing = await this.prisma.reviewDecision.findUnique({
      where: { pluggyTransactionId: pluggyTxId },
    });
    if (
      !existing ||
      (existing.decision !== ReviewDecisionType.LINKED &&
        existing.decision !== ReviewDecisionType.IMPORTED &&
        existing.decision !== ReviewDecisionType.INVOICE_PAYMENT)
    ) {
      throw new NotFoundException('Completed reconciliation not found');
    }

    const snapshot = this.parseDecisionSnapshot(existing.snapshot);
    let organizzeTransactionId = snapshot?.organizzeTransactionId ?? null;
    if (!organizzeTransactionId) {
      const indexed = await this.indexOrganizzeTxByPluggyId(body.from, body.to);
      organizzeTransactionId = indexed.get(pluggyTxId)?.id ?? null;
    }

    if (organizzeTransactionId) {
      await this.revertOrganizzeOnUndo({
        pluggyTxId,
        organizzeTransactionId,
        decision: existing.decision,
        snapshotRecurring: snapshot?.organizzeRecurring ?? null,
      });
    }

    await this.prisma.reviewDecision.delete({
      where: { pluggyTransactionId: pluggyTxId },
    });
    return { restored: true as const };
  }

  /**
   * Fixo (recurring): marca não pago e remove marker.
   * Normal / cartão / importado / fatura: exclui o lançamento no Organizze.
   */
  private async revertOrganizzeOnUndo(params: {
    pluggyTxId: string;
    organizzeTransactionId: number;
    decision: ReviewDecisionType;
    snapshotRecurring: boolean | null;
  }): Promise<void> {
    const { pluggyTxId, organizzeTransactionId, decision, snapshotRecurring } =
      params;

    let current: OrganizzeTransaction | null = null;
    try {
      current = await this.organizze.getTransaction(organizzeTransactionId);
    } catch (error) {
      this.logger.warn(
        `Could not load Organizze tx ${organizzeTransactionId} on undo: ${String(error)}`,
      );
    }

    const isFixed =
      current?.recurring === true ||
      (current == null && snapshotRecurring === true);
    const keepAsUnpaid = decision === ReviewDecisionType.LINKED && isFixed;

    if (keepAsUnpaid && current) {
      try {
        await this.organizze.updateTransaction(organizzeTransactionId, {
          notes: this.organizze.removePluggyMarker(current.notes, pluggyTxId),
          paid: false,
        });
        return;
      } catch (error) {
        this.logger.warn(
          `Could not mark Organizze tx ${organizzeTransactionId} unpaid on undo: ${String(error)}`,
        );
      }
    }

    try {
      await this.organizze.deleteTransaction(organizzeTransactionId);
      return;
    } catch (error) {
      this.logger.warn(
        `Could not delete Organizze tx ${organizzeTransactionId} on undo: ${String(error)}`,
      );
    }

    if (current) {
      try {
        await this.organizze.updateTransaction(organizzeTransactionId, {
          notes: this.organizze.removePluggyMarker(current.notes, pluggyTxId),
          ...(decision === ReviewDecisionType.LINKED ? { paid: false } : {}),
        });
      } catch (fallbackError) {
        this.logger.warn(
          `Fallback marker removal also failed for ${organizzeTransactionId}: ${String(fallbackError)}`,
        );
      }
    }
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
    snapshot?: DecisionSnapshot | null,
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

  private organizzeTxDestination(
    tx: OrganizzeTransaction,
    accountNames: Map<number, string>,
    cardNames: Map<number, string>,
  ): string {
    if (tx.credit_card_id) {
      return cardNames.get(tx.credit_card_id) ?? `Cartão #${tx.credit_card_id}`;
    }
    if (tx.account_id) {
      return accountNames.get(tx.account_id) ?? `Conta #${tx.account_id}`;
    }
    return 'Organizze';
  }

  private organizzeTxTargetType(
    tx: OrganizzeTransaction,
  ): 'account' | 'credit_card' | null {
    if (tx.credit_card_id) {
      return 'credit_card';
    }
    if (tx.account_id) {
      return 'account';
    }
    return null;
  }

  private toDecisionSnapshot(
    pluggy: QueuePluggyTransaction,
    extras?: {
      organizzeTransactionId?: number | null;
      organizzeDescription?: string | null;
      organizzeAccountName?: string | null;
      organizzeTargetType?: 'account' | 'credit_card' | null;
      organizzeLinkedAmountCents?: number | null;
      organizzeRecurring?: boolean | null;
      wasPaidBeforeLink?: boolean | null;
    },
  ): DecisionSnapshot {
    return {
      description: pluggy.description,
      amountCents: pluggy.amountCents,
      organizzeAmountCents: pluggy.organizzeAmountCents,
      date: pluggy.date,
      accountName: this.formatAccountLabel(pluggy),
      kind: pluggy.kind,
      installmentNumber: pluggy.installmentNumber,
      totalInstallments: pluggy.totalInstallments,
      organizzeTransactionId: extras?.organizzeTransactionId ?? null,
      organizzeDescription: extras?.organizzeDescription ?? null,
      organizzeAccountName: extras?.organizzeAccountName ?? null,
      organizzeTargetType: extras?.organizzeTargetType ?? null,
      organizzeLinkedAmountCents: extras?.organizzeLinkedAmountCents ?? null,
      organizzeRecurring: extras?.organizzeRecurring ?? null,
      wasPaidBeforeLink: extras?.wasPaidBeforeLink ?? null,
    };
  }

  private parseDecisionSnapshot(
    value: Prisma.JsonValue | null,
  ): DecisionSnapshot | null {
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
      organizzeTransactionId:
        typeof data.organizzeTransactionId === 'number'
          ? data.organizzeTransactionId
          : null,
      organizzeDescription:
        typeof data.organizzeDescription === 'string'
          ? data.organizzeDescription
          : null,
      organizzeAccountName:
        typeof data.organizzeAccountName === 'string'
          ? data.organizzeAccountName
          : null,
      organizzeTargetType:
        data.organizzeTargetType === 'account' ||
        data.organizzeTargetType === 'credit_card'
          ? data.organizzeTargetType
          : null,
      organizzeLinkedAmountCents:
        typeof data.organizzeLinkedAmountCents === 'number'
          ? data.organizzeLinkedAmountCents
          : null,
      organizzeRecurring:
        typeof data.organizzeRecurring === 'boolean'
          ? data.organizzeRecurring
          : null,
      wasPaidBeforeLink:
        typeof data.wasPaidBeforeLink === 'boolean'
          ? data.wasPaidBeforeLink
          : null,
    };
  }

  private async indexOrganizzeTxByPluggyId(
    from: string,
    to: string,
  ): Promise<Map<string, OrganizzeTransaction>> {
    const byId = new Map<string, OrganizzeTransaction>();
    try {
      const rows = await this.organizze.listTransactions({
        startDate: from,
        endDate: to,
      });
      for (const tx of rows) {
        for (const pluggyId of this.organizze.extractPluggyIds(tx.notes)) {
          if (!byId.has(pluggyId)) {
            byId.set(pluggyId, tx);
          }
        }
      }
    } catch (error) {
      this.logger.warn(
        `Could not index Organizze transactions for done list: ${String(error)}`,
      );
    }
    return byId;
  }

  private async indexPluggyTxById(
    from: string,
    to: string,
    mappedAccountIds: string[],
    activeMaps: ActiveAccountMap[],
  ): Promise<Map<string, QueuePluggyTransaction>> {
    const byId = new Map<string, QueuePluggyTransaction>();
    if (mappedAccountIds.length === 0) {
      return byId;
    }
    try {
      const mapsByPluggyId = new Map(
        activeMaps.map((map) => [map.pluggyAccountId, map]),
      );
      const bundles = await this.pluggy.listTransactionsForAccounts({
        accountIds: mappedAccountIds,
        dateFrom: from,
        dateTo: to,
      });
      for (const bundle of bundles) {
        const map = mapsByPluggyId.get(bundle.mapKey);
        if (!map) {
          continue;
        }
        for (const tx of bundle.transactions) {
          const cardNumber = transactionCardNumber(tx, bundle.account);
          const queueTx = this.toQueueTransaction(
            tx,
            bundle.account,
            map,
            cardNumber,
            resolveCardNickname(map, cardNumber),
          );
          byId.set(queueTx.id, queueTx);
        }
      }
    } catch (error) {
      this.logger.warn(
        `Could not index Pluggy transactions for done list: ${String(error)}`,
      );
    }
    return byId;
  }

  /** Fallback when the month-range index misses a linked Pluggy tx. */
  private async resolvePluggyTxById(
    pluggyTxId: string,
    mapsByPluggyId: Map<string, ActiveAccountMap>,
    accountsById: Map<string, Account>,
  ): Promise<QueuePluggyTransaction | null> {
    const tx = await this.pluggy.getTransaction(pluggyTxId);
    if (!tx) {
      return null;
    }
    const account = accountsById.get(tx.accountId);
    if (!account) {
      return null;
    }
    const map = mapsByPluggyId.get(account.id) ?? {
      pluggyAccountId: account.id,
      targetType: 'account' as const,
      organizzeTargetId: 0,
      nickname: null,
      cardNicknames: {},
    };
    const cardNumber = transactionCardNumber(tx, account);
    return this.toQueueTransaction(
      tx,
      account,
      map,
      cardNumber,
      resolveCardNickname(map, cardNumber),
    );
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
