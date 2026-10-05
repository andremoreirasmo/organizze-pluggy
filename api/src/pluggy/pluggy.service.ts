import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PluggyClient,
  Transaction,
  Account,
  Investment,
  type CreditCardBills,
} from 'pluggy-sdk';
import { PrismaService } from '../prisma/prisma.module';
import { InstitutionBrandService } from '../institution/institution-brand.service';
import {
  dedupePluggyAccounts,
  expandPluggyAccountsForMapping,
  parsePluggyAccountMapKey,
  type PluggyAccountView,
} from './pluggy-accounts';

export type PluggyInvestmentView = {
  id: string;
  itemId: string;
  name: string;
  type: string;
  subtype: string | null;
  balance: number;
  balanceCents: number;
  amountProfit: number | null;
  amountOriginal: number | null;
  amount: number | null;
  quantity: number | null;
  dueDate: string | null;
  issueDate: string | null;
  purchaseDate: string | null;
  rate: number | null;
  rateType: string | null;
  fixedAnnualRate: number | null;
  lastTwelveMonthsRate: number | null;
  status: string | null;
  currencyCode: string | null;
  connectionId: string | null;
  connectionName: string | null;
  connectionImageUrl: string | null;
  connectionPrimaryColor: string | null;
};

export type StoredConnection = {
  id: string;
  itemId: string;
  customName: string | null;
  displayName: string;
  connectorId: number | null;
  connectorName: string | null;
  connectorImageUrl: string | null;
  connectorPrimaryColor: string | null;
  connectorType: string | null;
  institutionName: string | null;
  institutionImageUrl: string | null;
  institutionPrimaryColor: string | null;
  institutionCompeCode: string | null;
  status: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PluggyConnectionSummary = StoredConnection & {
  accounts: PluggyAccountView[];
};

export type PluggySyncConnectionResult = {
  id: string;
  displayName: string;
  status: string | null;
  executionStatus: string | null;
  lastUpdatedAt: string | null;
  institutionImageUrl: string | null;
  /** False for sandbox / MeuPluggy items that reject manual update. */
  updatable: boolean;
  error: string | null;
};

const ITEM_SYNC_TERMINAL_STATUSES = new Set([
  'UPDATED',
  'OUTDATED',
  'LOGIN_ERROR',
  'WAITING_USER_INPUT',
]);

const ITEM_SYNC_POLL_MS = 2500;
const ITEM_SYNC_TIMEOUT_MS = 90_000;

type InstitutionSnapshot = {
  connectorId: number | null;
  connectorName: string | null;
  connectorImageUrl: string | null;
  connectorPrimaryColor: string | null;
  connectorType: string | null;
  institutionName: string | null;
  institutionImageUrl: string | null;
  institutionPrimaryColor: string | null;
  institutionCompeCode: string | null;
  status: string | null;
};

@Injectable()
export class PluggyService {
  private readonly logger = new Logger(PluggyService.name);
  private readonly client: PluggyClient;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly institutionBrand: InstitutionBrandService,
  ) {
    this.client = new PluggyClient({
      clientId: this.config.getOrThrow<string>('PLUGGY_CLIENT_ID'),
      clientSecret: this.config.getOrThrow<string>('PLUGGY_CLIENT_SECRET'),
    });
  }

  async createConnectToken(itemId?: string): Promise<{ accessToken: string }> {
    const data = await this.client.createConnectToken(itemId);
    return { accessToken: data.accessToken };
  }

  listInstitutions(search?: string) {
    return this.institutionBrand.listInstitutions(search);
  }

  async listConfiguredConnections(): Promise<StoredConnection[]> {
    this.requireDatabase();
    const rows = await this.prisma.pluggyItem.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toStoredConnection(row));
  }

  async addConnection(
    itemId: string,
    options?: {
      customName?: string;
      institutionName?: string;
      institutionImageUrl?: string;
      institutionPrimaryColor?: string;
    },
  ): Promise<StoredConnection> {
    this.requireDatabase();
    const trimmed = itemId.trim();
    if (!trimmed) {
      throw new BadRequestException('itemId is required');
    }
    if (!options?.institutionImageUrl || !options.institutionName) {
      throw new BadRequestException(
        'Selecione o ícone/banco da instituição ao cadastrar a conexão',
      );
    }

    const snapshot = await this.buildSnapshot(trimmed, options);

    const row = await this.prisma.pluggyItem.upsert({
      where: { itemId: trimmed },
      create: {
        itemId: trimmed,
        customName: options.customName?.trim() || null,
        ...snapshot,
      },
      update: {
        customName:
          options.customName !== undefined
            ? options.customName.trim() || null
            : undefined,
        ...snapshot,
      },
    });

    return this.toStoredConnection(row);
  }

  async updateConnection(
    id: string,
    data: {
      customName?: string | null;
      institutionName?: string | null;
      institutionImageUrl?: string | null;
      institutionPrimaryColor?: string | null;
    },
  ): Promise<StoredConnection> {
    this.requireDatabase();
    const existing = await this.prisma.pluggyItem.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Connection not found');
    }

    const row = await this.prisma.pluggyItem.update({
      where: { id },
      data: {
        customName:
          data.customName === undefined
            ? existing.customName
            : data.customName?.trim() || null,
        institutionName:
          data.institutionName === undefined
            ? existing.institutionName
            : data.institutionName,
        institutionImageUrl:
          data.institutionImageUrl === undefined
            ? existing.institutionImageUrl
            : data.institutionImageUrl,
        institutionPrimaryColor:
          data.institutionPrimaryColor === undefined
            ? existing.institutionPrimaryColor
            : this.normalizeColor(data.institutionPrimaryColor) ??
              data.institutionPrimaryColor,
      },
    });

    return this.toStoredConnection(row);
  }

  async deleteConnection(id: string): Promise<{ deleted: true }> {
    this.requireDatabase();
    const existing = await this.prisma.pluggyItem.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Connection not found');
    }
    await this.prisma.pluggyItem.delete({ where: { id } });
    return { deleted: true };
  }

  async syncAllConnections(): Promise<{ results: PluggySyncConnectionResult[] }> {
    this.requireDatabase();
    const connections = await this.listConfiguredConnections();
    if (connections.length === 0) {
      return { results: [] };
    }

    const results = await Promise.all(
      connections.map((connection) => this.syncOneConnection(connection)),
    );
    return { results };
  }

  async listConnectionSyncStatuses(): Promise<{
    results: PluggySyncConnectionResult[];
  }> {
    this.requireDatabase();
    const connections = await this.listConfiguredConnections();
    const results = await Promise.all(
      connections.map(async (connection) => {
        const base: PluggySyncConnectionResult = {
          id: connection.id,
          displayName: connection.displayName,
          status: connection.status,
          executionStatus: null,
          lastUpdatedAt: null,
          institutionImageUrl:
            connection.institutionImageUrl || connection.connectorImageUrl,
          updatable: this.isConnectionUpdatable(connection),
          error: null,
        };
        try {
          const item = await this.client.fetchItem(connection.itemId);
          const updatable = this.isItemUpdatable(item, connection);
          await this.prisma.pluggyItem.update({
            where: { id: connection.id },
            data: {
              status: item.status ?? null,
              connectorName: item.connector?.name ?? undefined,
              connectorImageUrl: item.connector?.imageUrl ?? undefined,
            },
          });
          return {
            ...base,
            status: item.status ?? null,
            executionStatus: item.executionStatus ?? null,
            lastUpdatedAt: this.formatItemTimestamp(item.lastUpdatedAt),
            updatable,
            error: updatable
              ? null
              : 'Conta de teste — sync manual não disponível.',
          };
        } catch (error) {
          this.logger.warn(
            `Could not fetch sync status for ${connection.itemId}: ${String(error)}`,
          );
          return {
            ...base,
            error: this.formatUnknownError(error),
          };
        }
      }),
    );
    return { results };
  }

  async syncConnection(id: string): Promise<PluggySyncConnectionResult> {
    this.requireDatabase();
    const connection = await this.prisma.pluggyItem.findUnique({
      where: { id },
    });
    if (!connection) {
      throw new NotFoundException('Connection not found');
    }
    return this.syncOneConnection(this.toStoredConnection(connection));
  }

  async listConnections(): Promise<{
    connections: PluggyConnectionSummary[];
  }> {
    this.requireDatabase();
    const stored = await this.listConfiguredConnections();
    const connections: PluggyConnectionSummary[] = [];

    for (const connection of stored) {
      try {
        const item = await this.client.fetchItem(connection.itemId);
        const accountsPage = await this.client.fetchAccounts(connection.itemId);

        const refreshed = await this.prisma.pluggyItem.update({
          where: { id: connection.id },
          data: {
            connectorId: item.connector?.id ?? null,
            connectorName: item.connector?.name ?? null,
            connectorImageUrl: item.connector?.imageUrl ?? null,
            connectorPrimaryColor: this.normalizeColor(
              item.connector?.primaryColor,
            ),
            connectorType: item.connector?.type ?? null,
            status: item.status ?? null,
          },
        });

        connections.push({
          ...this.toStoredConnection(refreshed),
          accounts: expandPluggyAccountsForMapping(accountsPage.results),
        });
      } catch (error) {
        this.logger.warn(
          `Skipping item ${connection.itemId}: ${String(error)}`,
        );
        connections.push({
          ...connection,
          accounts: [],
        });
      }
    }

    return { connections };
  }

  async listAccounts(itemId?: string): Promise<Account[]> {
    if (itemId) {
      const page = await this.client.fetchAccounts(itemId);
      return dedupePluggyAccounts(page.results);
    }

    this.requireDatabase();
    const stored = await this.listConfiguredConnections();
    if (stored.length === 0) {
      throw new NotFoundException(
        'Nenhum banco cadastrado. Adicione conexões em Configurações.',
      );
    }

    const pages = await Promise.all(
      stored.map(async (connection) => {
        try {
          const page = await this.client.fetchAccounts(connection.itemId);
          return dedupePluggyAccounts(page.results);
        } catch (error) {
          this.logger.warn(
            `Could not list accounts for item ${connection.itemId}: ${String(error)}`,
          );
          return [] as Account[];
        }
      }),
    );

    const byId = new Map<string, Account>();
    for (const accounts of pages) {
      for (const account of accounts) {
        byId.set(account.id, account);
      }
    }
    return [...byId.values()];
  }

  /** Closed/open credit-card bills (faturas) for a Pluggy CREDIT account. */
  async listCreditCardBills(accountId: string): Promise<CreditCardBills[]> {
    const results: CreditCardBills[] = [];
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      const response = await this.client.fetchCreditCardBills(accountId, {
        page,
        pageSize: 50,
      });
      results.push(...response.results);
      totalPages = Math.max(1, response.totalPages ?? 1);
      page += 1;
      if (page > 20) {
        break;
      }
    }
    return results;
  }

  async listAccountViews(): Promise<PluggyAccountView[]> {
    const accounts = await this.listAccounts();
    return expandPluggyAccountsForMapping(accounts);
  }

  private async fetchAllInvestmentsForItem(
    itemId: string,
  ): Promise<Investment[]> {
    const results: Investment[] = [];
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages) {
      const response = await this.client.fetchInvestments(itemId, undefined, {
        page,
        pageSize: 100,
      });
      results.push(...response.results);
      totalPages = Math.max(1, response.totalPages ?? 1);
      page += 1;
      if (page > 50) {
        break;
      }
    }
    return results;
  }

  async listInvestments(): Promise<PluggyInvestmentView[]> {
    this.requireDatabase();
    const stored = await this.listConfiguredConnections();
    if (stored.length === 0) {
      return [];
    }

    const pages = await Promise.all(
      stored.map(async (connection) => {
        try {
          const investments = await this.fetchAllInvestmentsForItem(
            connection.itemId,
          );
          this.logger.log(
            `Pluggy investments for ${connection.displayName} (${connection.itemId}): ${investments.length}`,
          );
          return investments.map((investment) => ({
            investment,
            connection,
          }));
        } catch (error) {
          this.logger.warn(
            `Could not list investments for item ${connection.itemId} (${connection.displayName}): ${String(error)}`,
          );
          return [] as Array<{
            investment: Investment;
            connection: StoredConnection;
          }>;
        }
      }),
    );

    const byId = new Map<string, PluggyInvestmentView>();
    for (const batch of pages) {
      for (const { investment, connection } of batch) {
        const status = investment.status ?? null;
        if (status === 'TOTAL_WITHDRAWAL') {
          continue;
        }
        const balance =
          typeof investment.balance === 'number' ? investment.balance : 0;
        byId.set(investment.id, {
          id: investment.id,
          itemId: investment.itemId,
          name: investment.name,
          type: investment.type,
          subtype: investment.subtype ?? null,
          balance,
          balanceCents: Math.round(balance * 100),
          amountProfit:
            typeof investment.amountProfit === 'number'
              ? investment.amountProfit
              : null,
          amountOriginal:
            typeof investment.amountOriginal === 'number'
              ? investment.amountOriginal
              : null,
          amount:
            typeof investment.amount === 'number' ? investment.amount : null,
          quantity:
            typeof investment.quantity === 'number'
              ? investment.quantity
              : null,
          dueDate: investment.dueDate
            ? new Date(investment.dueDate).toISOString().slice(0, 10)
            : null,
          issueDate: investment.issueDate
            ? new Date(investment.issueDate).toISOString().slice(0, 10)
            : null,
          purchaseDate: investment.purchaseDate
            ? new Date(investment.purchaseDate).toISOString().slice(0, 10)
            : null,
          rate: typeof investment.rate === 'number' ? investment.rate : null,
          rateType: investment.rateType ?? null,
          fixedAnnualRate:
            typeof investment.fixedAnnualRate === 'number'
              ? investment.fixedAnnualRate
              : null,
          lastTwelveMonthsRate:
            typeof investment.lastTwelveMonthsRate === 'number'
              ? investment.lastTwelveMonthsRate
              : null,
          status,
          currencyCode: investment.currencyCode ?? null,
          connectionId: connection.id,
          connectionName: connection.displayName,
          connectionImageUrl:
            connection.institutionImageUrl ||
            connection.connectorImageUrl ||
            null,
          connectionPrimaryColor:
            connection.institutionPrimaryColor ||
            connection.connectorPrimaryColor ||
            null,
        });
      }
    }
    return [...byId.values()].sort((a, b) =>
      a.name.localeCompare(b.name, 'pt-BR'),
    );
  }

  async listTransactions(params: {
    accountId: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<Transaction[]> {
    this.logger.log(
      `Fetching Pluggy transactions for account ${params.accountId}`,
    );
    return this.client.fetchAllTransactions(params.accountId, {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    });
  }

  async getTransaction(transactionId: string): Promise<Transaction | null> {
    try {
      return await this.client.fetchTransaction(transactionId);
    } catch (error) {
      this.logger.warn(
        `Could not fetch Pluggy transaction ${transactionId}: ${String(error)}`,
      );
      return null;
    }
  }

  async listTransactionsForAccounts(params: {
    accountIds: string[];
    dateFrom?: string;
    dateTo?: string;
    /** Reuse accounts already loaded by the caller to avoid a second Pluggy round-trip. */
    accounts?: Account[];
  }): Promise<
    Array<{
      account: Account;
      mapKey: string;
      transactions: Transaction[];
    }>
  > {
    const allAccounts = params.accounts ?? (await this.listAccounts());
    const byId = new Map(allAccounts.map((account) => [account.id, account]));
    const sourceIds = [
      ...new Set(
        params.accountIds.map(
          (key) => parsePluggyAccountMapKey(key).sourceAccountId,
        ),
      ),
    ];

    const settled = await Promise.all(
      sourceIds.map(async (sourceAccountId) => {
        const account = byId.get(sourceAccountId);
        if (!account) {
          this.logger.warn(
            `Pluggy account ${sourceAccountId} not found — skipping`,
          );
          return null;
        }
        const transactions = await this.listTransactions({
          accountId: sourceAccountId,
          dateFrom: params.dateFrom,
          dateTo: params.dateTo,
        });
        return {
          account,
          mapKey: sourceAccountId,
          transactions,
        };
      }),
    );

    return settled.filter(
      (
        entry,
      ): entry is {
        account: Account;
        mapKey: string;
        transactions: Transaction[];
      } => entry !== null,
    );
  }

  private async syncOneConnection(
    connection: StoredConnection,
  ): Promise<PluggySyncConnectionResult> {
    const base: PluggySyncConnectionResult = {
      id: connection.id,
      displayName: connection.displayName,
      status: connection.status,
      executionStatus: null,
      lastUpdatedAt: null,
      institutionImageUrl:
        connection.institutionImageUrl || connection.connectorImageUrl,
      updatable: this.isConnectionUpdatable(connection),
      error: null,
    };

    try {
      const before = await this.client.fetchItem(connection.itemId);
      const updatable = this.isItemUpdatable(before, connection);
      base.updatable = updatable;

      if (!updatable) {
        return {
          ...base,
          status: before.status ?? null,
          executionStatus: before.executionStatus ?? null,
          lastUpdatedAt: this.formatItemTimestamp(before.lastUpdatedAt),
          updatable: false,
          error: 'Conta de teste — sync manual não disponível.',
        };
      }

      const beforeUpdatedAt = this.formatItemTimestamp(before.lastUpdatedAt);

      let item =
        before.status === 'UPDATING'
          ? before
          : await this.triggerItemUpdate(connection.itemId);

      item = await this.pollItemUntilTerminal(connection.itemId, item);
      // Re-fetch so lastUpdatedAt reflects the finished execution.
      item = await this.client.fetchItem(connection.itemId);

      await this.prisma.pluggyItem.update({
        where: { id: connection.id },
        data: {
          status: item.status ?? null,
          connectorId: item.connector?.id ?? undefined,
          connectorName: item.connector?.name ?? undefined,
          connectorImageUrl: item.connector?.imageUrl ?? undefined,
          connectorPrimaryColor: this.normalizeColor(
            item.connector?.primaryColor,
          ),
          connectorType: item.connector?.type ?? undefined,
        },
      });

      const lastUpdatedAt =
        this.formatItemTimestamp(item.lastUpdatedAt) ??
        (item.status === 'UPDATED' ? new Date().toISOString() : null);

      const unchanged =
        item.status === 'UPDATED' &&
        beforeUpdatedAt !== null &&
        lastUpdatedAt === beforeUpdatedAt;

      const error =
        item.status === 'UPDATED'
          ? unchanged
            ? 'O banco não aceitou uma nova coleta agora (ainda na sync anterior). Tente em alguns minutos.'
            : null
          : item.status === 'OUTDATED'
            ? 'Sincronização incompleta — tente de novo em instantes.'
            : item.status === 'LOGIN_ERROR'
              ? 'Credenciais inválidas — reconecte em Configurações.'
              : item.status === 'WAITING_USER_INPUT'
                ? 'Aguardando confirmação no banco ou app.'
                : 'Sincronização não concluída.';

      return {
        ...base,
        status: item.status ?? null,
        executionStatus: item.executionStatus ?? null,
        lastUpdatedAt,
        updatable: true,
        error,
      };
    } catch (error) {
      const message = this.friendlySyncError(error);
      this.logger.warn(
        `Sync failed for item ${connection.itemId}: ${message}`,
      );
      return {
        ...base,
        error: message,
      };
    }
  }

  private isConnectionUpdatable(connection: StoredConnection): boolean {
    const name = (connection.connectorName ?? '').toLowerCase();
    if (name.includes('meupluggy')) {
      return false;
    }
    if (connection.connectorImageUrl?.includes('sandbox.svg')) {
      return false;
    }
    return true;
  }

  private isItemUpdatable(
    item: Awaited<ReturnType<PluggyClient['fetchItem']>>,
    connection: StoredConnection,
  ): boolean {
    if (item.connector?.isSandbox) {
      return false;
    }
    const name = (item.connector?.name ?? connection.connectorName ?? '').toLowerCase();
    if (name.includes('meupluggy')) {
      return false;
    }
    return this.isConnectionUpdatable(connection);
  }

  /**
   * pluggy-sdk rejects any PATCH status other than exactly 200 (e.g. 201),
   * incorrectly rejecting with the *request* body. Treat that as success and
   * continue from the current item state.
   */
  private async triggerItemUpdate(
    itemId: string,
  ): Promise<Awaited<ReturnType<PluggyClient['fetchItem']>>> {
    try {
      return await this.client.updateItem(itemId);
    } catch (error) {
      if (this.isSdkFalseReject(error, itemId)) {
        this.logger.log(
          `Pluggy updateItem returned non-200 for ${itemId}; continuing with poll`,
        );
        return this.client.fetchItem(itemId);
      }

      const refreshed = await this.client.fetchItem(itemId);
      if (refreshed.status === 'UPDATING') {
        return refreshed;
      }

      throw error;
    }
  }

  private isSdkFalseReject(error: unknown, itemId: string): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const record = error as Record<string, unknown>;
    return (
      record.id === itemId &&
      Object.prototype.hasOwnProperty.call(record, 'parameters')
    );
  }

  private friendlySyncError(error: unknown): string {
    const raw = this.formatUnknownError(error);
    if (/meupluggy item can'?t be updated/i.test(raw)) {
      return 'Conta de teste — sync manual não disponível.';
    }
    return raw;
  }

  private formatUnknownError(error: unknown): string {
    if (error instanceof Error && error.message.trim()) {
      return error.message.trim();
    }
    if (typeof error === 'string' && error.trim()) {
      return error.trim();
    }
    if (error && typeof error === 'object') {
      const record = error as Record<string, unknown>;
      for (const key of ['message', 'error', 'code', 'description'] as const) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) {
          return value.trim();
        }
        if (value && typeof value === 'object') {
          const nested = value as Record<string, unknown>;
          if (typeof nested.message === 'string' && nested.message.trim()) {
            return nested.message.trim();
          }
        }
      }
      try {
        return JSON.stringify(error);
      } catch {
        return 'Falha ao sincronizar com o banco';
      }
    }
    return 'Falha ao sincronizar com o banco';
  }

  private async pollItemUntilTerminal(
    itemId: string,
    initial: Awaited<ReturnType<PluggyClient['fetchItem']>>,
  ): Promise<Awaited<ReturnType<PluggyClient['fetchItem']>>> {
    const started = Date.now();
    let item = initial;

    while (Date.now() - started < ITEM_SYNC_TIMEOUT_MS) {
      if (item.status && ITEM_SYNC_TERMINAL_STATUSES.has(item.status)) {
        return item;
      }
      await this.sleep(ITEM_SYNC_POLL_MS);
      item = await this.client.fetchItem(itemId);
    }

    throw new Error(
      'Tempo esgotado aguardando o banco (90s). Tente novamente.',
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private formatItemTimestamp(value: Date | string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    return String(value);
  }

  private async buildSnapshot(
    itemId: string,
    institution: {
      institutionName?: string;
      institutionImageUrl?: string;
      institutionPrimaryColor?: string;
    },
  ): Promise<InstitutionSnapshot> {
    const item = await this.client.fetchItem(itemId);

    return {
      connectorId: item.connector?.id ?? null,
      connectorName: item.connector?.name ?? null,
      connectorImageUrl: item.connector?.imageUrl ?? null,
      connectorPrimaryColor: this.normalizeColor(item.connector?.primaryColor),
      connectorType: item.connector?.type ?? null,
      institutionName: institution.institutionName?.trim() || null,
      institutionImageUrl: institution.institutionImageUrl?.trim() || null,
      institutionPrimaryColor:
        this.normalizeColor(institution.institutionPrimaryColor) ||
        institution.institutionPrimaryColor?.trim() ||
        null,
      institutionCompeCode: null,
      status: item.status ?? null,
    };
  }

  private normalizeColor(color: string | null | undefined): string | null {
    if (!color) {
      return null;
    }
    return `#${color.replace(/^#/, '')}`;
  }

  private requireDatabase(): void {
    if (!this.prisma.isEnabled()) {
      throw new BadRequestException(
        'DATABASE_URL is required to manage Pluggy connections',
      );
    }
  }

  private toStoredConnection(row: {
    id: string;
    itemId: string;
    customName: string | null;
    connectorId: number | null;
    connectorName: string | null;
    connectorImageUrl: string | null;
    connectorPrimaryColor: string | null;
    connectorType: string | null;
    institutionName: string | null;
    institutionImageUrl: string | null;
    institutionPrimaryColor: string | null;
    institutionCompeCode: string | null;
    status: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): StoredConnection {
    const displayName =
      row.customName ||
      row.institutionName ||
      row.connectorName ||
      'Banco conectado';

    return {
      id: row.id,
      itemId: row.itemId,
      customName: row.customName,
      displayName,
      connectorId: row.connectorId,
      connectorName: row.connectorName,
      connectorImageUrl: row.connectorImageUrl,
      connectorPrimaryColor: row.connectorPrimaryColor,
      connectorType: row.connectorType,
      institutionName: row.institutionName,
      institutionImageUrl: row.institutionImageUrl,
      institutionPrimaryColor: row.institutionPrimaryColor,
      institutionCompeCode: row.institutionCompeCode,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
