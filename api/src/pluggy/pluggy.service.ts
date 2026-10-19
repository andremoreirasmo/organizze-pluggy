import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleAuth } from 'google-auth-library';
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

export type MeuPluggyRefreshProgress = {
  status: 'idle' | 'running' | 'succeeded' | 'failed';
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  total: number;
  completed: number;
  currentIndex: number;
  currentId: string | null;
  currentLabel: string | null;
  stepPercent: number | null;
  percent: number;
  message: string;
  results: Array<{
    id: string;
    label: string | null;
    ok: boolean;
    note: string;
  }>;
  mode?: 'local' | 'cloud';
  executionName?: string | null;
};

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

function isPluggyTransactionNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as {
    code?: unknown;
    message?: unknown;
    response?: { statusCode?: unknown; body?: { code?: unknown } };
  };
  if (record.code === 404 || record.code === 'TRANSACTION_NOT_FOUND') {
    return true;
  }
  if (record.response?.statusCode === 404) {
    return true;
  }
  if (record.response?.body?.code === 'TRANSACTION_NOT_FOUND') {
    return true;
  }
  const message = typeof record.message === 'string' ? record.message : '';
  return (
    /TRANSACTION_NOT_FOUND/i.test(message) ||
    /Transaction not found/i.test(message)
  );
}

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

  private localMeuRefreshChild: ChildProcess | null = null;
  private lastMeuRefreshMode: 'local' | 'cloud' | null = null;
  private lastMeuRefreshExecution: string | null = null;

  private resolveRepoRoot(): string {
    const candidates = [
      process.cwd(),
      path.resolve(process.cwd(), '..'),
      path.resolve(__dirname, '../../..'),
      path.resolve(__dirname, '../../../..'),
    ];
    for (const root of candidates) {
      if (existsSync(path.join(root, 'scripts', 'meu-pluggy-refresh.mjs'))) {
        return root;
      }
    }
    return path.resolve(process.cwd(), '..');
  }

  private localProgressPath(): string {
    const fromEnv = process.env.MEU_PLUGGY_PROGRESS_PATH?.trim();
    if (fromEnv) {
      return path.resolve(fromEnv);
    }
    return path.join(this.resolveRepoRoot(), '.cache', 'meu-pluggy-progress.json');
  }

  private progressGcsUri(): string | null {
    const explicit =
      this.config.get<string>('MEU_PLUGGY_PROGRESS_GCS')?.trim() ||
      process.env.MEU_PLUGGY_PROGRESS_GCS?.trim();
    if (explicit) {
      return explicit;
    }
    const stateUri =
      this.config.get<string>('MEU_PLUGGY_STORAGE_STATE_GCS')?.trim() ||
      process.env.MEU_PLUGGY_STORAGE_STATE_GCS?.trim();
    if (!stateUri) {
      return null;
    }
    return stateUri.replace(/[^/]+$/, 'progress.json');
  }

  private buildProgressSeed(message: string): MeuPluggyRefreshProgress {
    return {
      status: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
      total: 0,
      completed: 0,
      currentIndex: 0,
      currentId: null,
      currentLabel: null,
      stepPercent: 0,
      percent: 0,
      message,
      results: [],
    };
  }

  private writeLocalProgressSeed(message: string): void {
    const filePath = this.localProgressPath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify(this.buildProgressSeed(message), null, 2),
      'utf8',
    );
  }

  private async writeProgressSeed(message: string): Promise<void> {
    const seed = this.buildProgressSeed(message);
    const filePath = this.localProgressPath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(seed, null, 2), 'utf8');

    const gcsUri = this.progressGcsUri();
    if (!gcsUri) {
      return;
    }
    const match = gcsUri.match(/^gs:\/\/([^/]+)\/(.+)$/);
    if (!match) {
      return;
    }
    try {
      const auth = new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/devstorage.read_write'],
      });
      const client = await auth.getClient();
      const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(match[1])}/o?uploadType=media&name=${encodeURIComponent(match[2])}`;
      await client.request({
        url,
        method: 'POST',
        data: JSON.stringify(seed, null, 2),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      this.logger.warn(
        `Progress GCS seed write failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private pickFresherProgress(
    a: MeuPluggyRefreshProgress | null,
    b: MeuPluggyRefreshProgress | null,
  ): MeuPluggyRefreshProgress | null {
    if (!a) {
      return b;
    }
    if (!b) {
      return a;
    }
    const aTime = Date.parse(a.updatedAt) || 0;
    const bTime = Date.parse(b.updatedAt) || 0;
    return bTime >= aTime ? b : a;
  }

  private preferLocalMeuRefresh(projectId: string | undefined): boolean {
    const flag =
      this.config.get<string>('MEU_PLUGGY_REFRESH_LOCAL')?.trim() ||
      process.env.MEU_PLUGGY_REFRESH_LOCAL?.trim();
    if (flag === '1' || flag === 'true') {
      return true;
    }
    if (flag === '0' || flag === 'false') {
      return false;
    }
    return !projectId;
  }

  private startLocalMeuPluggyRefresh(): {
    started: true;
    mode: 'local';
    executionName: string;
    job: string;
  } {
    if (
      this.localMeuRefreshChild &&
      this.localMeuRefreshChild.exitCode === null &&
      !this.localMeuRefreshChild.killed
    ) {
      return {
        started: true as const,
        mode: 'local' as const,
        executionName: 'local/running',
        job: 'local',
      };
    }

    const root = this.resolveRepoRoot();
    const script = path.join(root, 'scripts', 'meu-pluggy-refresh.mjs');
    if (!existsSync(script)) {
      throw new ServiceUnavailableException(
        `Script Meu Pluggy não encontrado em ${script}`,
      );
    }

    this.writeLocalProgressSeed('Iniciando sync local…');
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      MEU_PLUGGY_PROGRESS_PATH: this.localProgressPath(),
    };
    // Cursor/sandbox often sets PLAYWRIGHT_BROWSERS_PATH to a cache the API
    // process does not share — drop invalid paths so Playwright uses
    // %LOCALAPPDATA%\ms-playwright (where `npm run pluggy:refresh:install` puts browsers).
    const browsersPath = childEnv.PLAYWRIGHT_BROWSERS_PATH?.trim();
    if (
      browsersPath &&
      (!existsSync(browsersPath) ||
        !existsSync(path.join(browsersPath, 'chromium_headless_shell-1248')))
    ) {
      delete childEnv.PLAYWRIGHT_BROWSERS_PATH;
    }
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.localMeuRefreshChild = child;
    this.lastMeuRefreshMode = 'local';
    this.lastMeuRefreshExecution = `local/${child.pid ?? 'unknown'}`;

    child.stdout?.on('data', (chunk: Buffer) => {
      this.logger.log(`[meu-refresh] ${chunk.toString().trimEnd()}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.logger.warn(`[meu-refresh] ${chunk.toString().trimEnd()}`);
    });
    child.on('exit', (code) => {
      this.logger.log(`Local Meu Pluggy refresh exited with code ${code}`);
      this.localMeuRefreshChild = null;
    });

    this.logger.log(`Started local Meu Pluggy refresh (pid ${child.pid})`);
    return {
      started: true as const,
      mode: 'local' as const,
      executionName: this.lastMeuRefreshExecution,
      job: 'local',
    };
  }

  /**
   * Starts Meu Pluggy Playwright refresh: local script when GCP is absent
   * (or MEU_PLUGGY_REFRESH_LOCAL=1), otherwise Cloud Run Job.
   */
  async startMeuPluggyRefresh(): Promise<{
    started: true;
    mode: 'local' | 'cloud';
    executionName: string;
    job: string;
  }> {
    const projectId =
      this.config.get<string>('GCP_PROJECT_ID')?.trim() ||
      process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
      process.env.GCLOUD_PROJECT?.trim();

    if (this.preferLocalMeuRefresh(projectId)) {
      return this.startLocalMeuPluggyRefresh();
    }

    const region =
      this.config.get<string>('GCP_REGION')?.trim() ||
      process.env.GCP_REGION?.trim() ||
      'southamerica-east1';
    const job =
      this.config.get<string>('MEU_PLUGGY_REFRESH_JOB')?.trim() ||
      process.env.MEU_PLUGGY_REFRESH_JOB?.trim() ||
      'meu-pluggy-refresh';

    if (!projectId) {
      throw new ServiceUnavailableException(
        'Refresh Meu Pluggy não configurado (GCP_PROJECT_ID ausente).',
      );
    }

    await this.writeProgressSeed('Disparando Job na Cloud Run…');

    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const accessToken =
      typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;
    if (!accessToken) {
      throw new ServiceUnavailableException(
        'Não foi possível autenticar na GCP para disparar o Job.',
      );
    }

    const url = `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs/${job}:run`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    const bodyText = await response.text();
    let payload: { name?: string; error?: { message?: string } } = {};
    try {
      payload = bodyText ? (JSON.parse(bodyText) as typeof payload) : {};
    } catch {
      payload = {};
    }

    if (!response.ok) {
      const message =
        payload.error?.message ||
        bodyText.slice(0, 300) ||
        `HTTP ${response.status}`;
      this.logger.warn(`Cloud Run Job ${job} execute failed: ${message}`);
      throw new ServiceUnavailableException(
        `Não foi possível iniciar o refresh: ${message}`,
      );
    }

    const executionName = payload.name ?? `${job}/executions/unknown`;
    this.lastMeuRefreshMode = 'cloud';
    this.lastMeuRefreshExecution = executionName;
    this.logger.log(`Started Meu Pluggy refresh job: ${executionName}`);
    return {
      started: true as const,
      mode: 'cloud' as const,
      executionName,
      job,
    };
  }

  private parseProgressJson(raw: string): MeuPluggyRefreshProgress | null {
    try {
      const parsed = JSON.parse(raw) as MeuPluggyRefreshProgress;
      if (!parsed || typeof parsed !== 'object' || !parsed.status) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async readProgressFromGcs(
    gcsUri: string,
  ): Promise<MeuPluggyRefreshProgress | null> {
    const match = gcsUri.match(/^gs:\/\/([^/]+)\/(.+)$/);
    if (!match) {
      return null;
    }
    const bucket = match[1];
    const object = match[2];
    try {
      const auth = new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/devstorage.read_only'],
      });
      const client = await auth.getClient();
      const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`;
      const response = await client.request<string>({
        url,
        responseType: 'text',
      });
      const data =
        typeof response.data === 'string'
          ? response.data
          : JSON.stringify(response.data);
      return this.parseProgressJson(data);
    } catch (error) {
      this.logger.debug(
        `Progress GCS read failed: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  async getMeuPluggyRefreshStatus(): Promise<MeuPluggyRefreshProgress> {
    let local: MeuPluggyRefreshProgress | null = null;
    const localPath = this.localProgressPath();
    if (existsSync(localPath)) {
      local = this.parseProgressJson(readFileSync(localPath, 'utf8'));
    }

    const gcsUri = this.progressGcsUri();
    const fromGcs = gcsUri ? await this.readProgressFromGcs(gcsUri) : null;

    // Prefer GCS in cloud (Job writes there). Local seed alone would stick on
    // "Disparando Job…" forever after POST on Cloud Run.
    const picked =
      gcsUri != null
        ? this.pickFresherProgress(fromGcs, local) ?? fromGcs ?? local
        : local ?? fromGcs;

    if (picked) {
      const mode =
        this.lastMeuRefreshMode ??
        picked.mode ??
        (gcsUri ? 'cloud' : 'local');
      return {
        ...picked,
        mode,
        executionName:
          this.lastMeuRefreshExecution ?? picked.executionName ?? null,
      };
    }

    return {
      status: 'idle',
      startedAt: null,
      updatedAt: new Date().toISOString(),
      finishedAt: null,
      total: 0,
      completed: 0,
      currentIndex: 0,
      currentId: null,
      currentLabel: null,
      stepPercent: null,
      percent: 0,
      message: 'Nenhum sync em andamento',
      results: [],
      mode: this.lastMeuRefreshMode ?? undefined,
      executionName: this.lastMeuRefreshExecution,
    };
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
      if (isPluggyTransactionNotFound(error)) {
        this.logger.debug(
          `Pluggy transaction ${transactionId} not found (gone or rotated)`,
        );
        return null;
      }
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
