import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PluggyClient, Transaction, Account } from 'pluggy-sdk';
import { PrismaService } from '../prisma/prisma.module';
import { InstitutionBrandService } from '../institution/institution-brand.service';
import {
  dedupePluggyAccounts,
  expandPluggyAccountsForMapping,
  parsePluggyAccountMapKey,
  transactionCardNumber,
  type PluggyAccountView,
} from './pluggy-accounts';

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

    const byId = new Map<string, Account>();
    for (const connection of stored) {
      try {
        const page = await this.client.fetchAccounts(connection.itemId);
        for (const account of dedupePluggyAccounts(page.results)) {
          byId.set(account.id, account);
        }
      } catch (error) {
        this.logger.warn(
          `Could not list accounts for item ${connection.itemId}: ${String(error)}`,
        );
      }
    }
    return [...byId.values()];
  }

  async listAccountViews(): Promise<PluggyAccountView[]> {
    const { connections } = await this.listConnections();
    return connections.flatMap((connection) => connection.accounts);
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

  async listTransactionsForAccounts(params: {
    accountIds: string[];
    dateFrom?: string;
    dateTo?: string;
  }): Promise<
    Array<{
      account: Account;
      mapKey: string;
      cardNumber: string | null;
      transactions: Transaction[];
    }>
  > {
    const allAccounts = await this.listAccounts();
    const byId = new Map(allAccounts.map((account) => [account.id, account]));
    const sourceIds = [
      ...new Set(
        params.accountIds.map(
          (key) => parsePluggyAccountMapKey(key).sourceAccountId,
        ),
      ),
    ];
    const results: Array<{
      account: Account;
      mapKey: string;
      cardNumber: string | null;
      transactions: Transaction[];
    }> = [];

    const txsBySource = new Map<string, Transaction[]>();
    for (const sourceAccountId of sourceIds) {
      const account = byId.get(sourceAccountId);
      if (!account) {
        this.logger.warn(
          `Pluggy account ${sourceAccountId} not found — skipping`,
        );
        continue;
      }
      const transactions = await this.listTransactions({
        accountId: sourceAccountId,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
      });
      txsBySource.set(sourceAccountId, transactions);
    }

    const hasCardSpecificMap = new Map<string, boolean>();
    for (const mapKey of params.accountIds) {
      const parsed = parsePluggyAccountMapKey(mapKey);
      if (parsed.cardNumber) {
        hasCardSpecificMap.set(parsed.sourceAccountId, true);
      }
    }

    for (const mapKey of params.accountIds) {
      const parsed = parsePluggyAccountMapKey(mapKey);
      const account = byId.get(parsed.sourceAccountId);
      const transactions = txsBySource.get(parsed.sourceAccountId);
      if (!account || !transactions) {
        continue;
      }

      const cardSplit = hasCardSpecificMap.get(parsed.sourceAccountId) === true;
      const filtered = !cardSplit
        ? transactions
        : parsed.cardNumber == null
          ? transactions.filter((tx) => !transactionCardNumber(tx, account))
          : transactions.filter(
              (tx) => transactionCardNumber(tx, account) === parsed.cardNumber,
            );

      results.push({
        account,
        mapKey,
        cardNumber: parsed.cardNumber,
        transactions: filtered,
      });
    }

    return results;
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
