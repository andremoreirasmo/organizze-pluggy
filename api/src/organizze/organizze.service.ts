import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InstitutionBrandService } from '../institution/institution-brand.service';
import {
  CreateInvoicePaymentPayload,
  CreateOrganizzeTransferPayload,
  CreateOrganizzeTransactionPayload,
  OrganizzeAccount,
  OrganizzeBalancePeriod,
  OrganizzeBalancesResponse,
  OrganizzeCategory,
  OrganizzeCreditCard,
  OrganizzeInvoice,
  OrganizzePeriodCashflow,
  OrganizzeTag,
  OrganizzeTransaction,
  UpdateOrganizzeTransactionPayload,
} from './organizze.types';
import {
  cashflowExpenseCents,
  cashflowIncomeCents,
  periodMonthKey,
} from './organizze-cashflow';
import { TAG_NAME_MAX_LEN } from './organizze-tags';
import {
  appendPluggyMarker,
  extractPluggyIds,
  notesContainPluggyId,
  removePluggyMarker,
} from './pluggy-notes';

/** Cap concurrent upstream calls — Organizze/Cloudflare 502 under burst load. */
const ORGANIZZE_MAX_CONCURRENT = 4;
const ORGANIZZE_MAX_RETRIES = 4;
const ORGANIZZE_CACHE_TTL_MS = 5 * 60_000;

type CacheEntry<T> = { at: number; value: T };

@Injectable()
export class OrganizzeService {
  private readonly logger = new Logger(OrganizzeService.name);
  private readonly baseUrl = 'https://api.organizze.com.br/rest/v2';

  private inFlight = 0;
  private readonly waitQueue: Array<() => void> = [];
  /** Enriched list helpers (accounts with brand, filtered categories, …). */
  private readonly viewCache = new Map<string, CacheEntry<unknown>>();
  /** Raw GET responses keyed by full URL. */
  private readonly getCache = new Map<string, CacheEntry<unknown>>();
  /** Share identical in-flight GETs (no duplicate upstream calls). */
  private readonly getInFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly config: ConfigService,
    private readonly institutionBrand: InstitutionBrandService,
  ) {}

  private authHeader(): string {
    const email = this.config.getOrThrow<string>('ORGANIZZE_EMAIL');
    const token = this.config.getOrThrow<string>('ORGANIZZE_API_TOKEN');
    return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  }

  private acquireSlot(): Promise<void> {
    if (this.inFlight < ORGANIZZE_MAX_CONCURRENT) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.inFlight += 1;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waitQueue.shift();
    if (next) {
      next();
    }
  }

  private readTimedCache<T>(
    store: Map<string, CacheEntry<unknown>>,
    key: string,
  ): T | undefined {
    const hit = store.get(key);
    if (!hit) {
      return undefined;
    }
    if (Date.now() - hit.at > ORGANIZZE_CACHE_TTL_MS) {
      store.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  private writeTimedCache<T>(
    store: Map<string, CacheEntry<unknown>>,
    key: string,
    value: T,
  ): void {
    store.set(key, { at: Date.now(), value });
  }

  private readViewCache<T>(key: string): T | null {
    const value = this.readTimedCache<T>(this.viewCache, key);
    return value === undefined ? null : value;
  }

  private writeViewCache<T>(key: string, value: T): void {
    this.writeTimedCache(this.viewCache, key, value);
  }

  private clearGetCache(): void {
    this.getCache.clear();
    this.viewCache.clear();
  }

  private buildGetUrl(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): URL {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url;
  }

  private async request<T>(
    path: string,
    init?: RequestInit & { query?: Record<string, string | number | undefined> },
  ): Promise<T> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = this.buildGetUrl(path, init?.query);
    const cacheKey = url.toString();

    if (method === 'GET') {
      const cached = this.readTimedCache<T>(this.getCache, cacheKey);
      if (cached !== undefined) {
        return cached;
      }
      const shared = this.getInFlight.get(cacheKey);
      if (shared) {
        return shared as Promise<T>;
      }
      const pending = this.runGatedRequest<T>(path, init, method, url)
        .then((value) => {
          this.writeTimedCache(this.getCache, cacheKey, value);
          return value;
        })
        .finally(() => {
          this.getInFlight.delete(cacheKey);
        });
      this.getInFlight.set(cacheKey, pending);
      return pending;
    }

    const result = await this.runGatedRequest<T>(path, init, method, url);
    this.clearGetCache();
    return result;
  }

  private async runGatedRequest<T>(
    path: string,
    init: (RequestInit & { query?: Record<string, string | number | undefined> }) | undefined,
    method: string,
    url: URL,
  ): Promise<T> {
    await this.acquireSlot();
    try {
      return await this.requestWithRetry<T>(path, init, method, url);
    } finally {
      this.releaseSlot();
    }
  }

  private async requestWithRetry<T>(
    path: string,
    init: (RequestInit & { query?: Record<string, string | number | undefined> }) | undefined,
    method: string,
    url: URL,
  ): Promise<T> {
    const { query: _query, ...fetchInit } = init ?? {};
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= ORGANIZZE_MAX_RETRIES; attempt += 1) {
      const started = Date.now();
      try {
        const response = await fetch(url, {
          ...fetchInit,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: this.authHeader(),
            'User-Agent': this.config.getOrThrow<string>('ORGANIZZE_USER_AGENT'),
            ...(fetchInit.headers ?? {}),
          },
        });
        const elapsed = Date.now() - started;
        this.logger.log(
          `[perf] Organizze ${method} ${path} → ${response.status} in ${elapsed}ms` +
            (attempt > 0 ? ` (retry ${attempt})` : ''),
        );

        if (response.ok) {
          if (response.status === 204) {
            return undefined as T;
          }
          return (await response.json()) as T;
        }

        const body = await response.text();
        const retryable = isRetryableOrganizzeStatus(response.status);
        lastError = new Error(`Organizze API error ${response.status}: ${body}`);
        if (!retryable || attempt >= ORGANIZZE_MAX_RETRIES) {
          this.logger.error(
            `Organizze ${path} failed: ${response.status} ${body}`,
          );
          throw lastError;
        }

        const delayMs = retryDelayMs(body, attempt);
        this.logger.warn(
          `Organizze ${path} ${response.status}; backing off ${delayMs}ms before retry ${attempt + 1}/${ORGANIZZE_MAX_RETRIES}`,
        );
        await sleep(delayMs);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Organizze API error')) {
          throw error;
        }
        lastError =
          error instanceof Error ? error : new Error(String(error));
        if (attempt >= ORGANIZZE_MAX_RETRIES) {
          throw lastError;
        }
        const delayMs = retryDelayMs(null, attempt);
        this.logger.warn(
          `Organizze ${path} network error; backing off ${delayMs}ms: ${lastError.message}`,
        );
        await sleep(delayMs);
      }
    }

    throw lastError ?? new Error(`Organizze ${path} failed`);
  }

  async listAccounts(options?: {
    includeArchived?: boolean;
  }): Promise<OrganizzeAccount[]> {
    const cacheKey = `accounts:${options?.includeArchived ? 'all' : 'active'}`;
    const cached = this.readViewCache<OrganizzeAccount[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const accounts = await this.request<OrganizzeAccount[]>('/accounts');
    const filtered = accounts.filter((account) => {
      if (!options?.includeArchived && account.archived) {
        return false;
      }
      // Cash/wallet accounts are not useful for Open Finance reconciliation
      if (this.isCashWalletAccount(account.name)) {
        return false;
      }
      return true;
    });

    const enriched = await Promise.all(
      filtered.map(async (account) => {
        try {
          const brand = await this.institutionBrand.resolveFromAccountName(
            account.name,
          );
          return {
            ...account,
            institutionName: brand.name,
            institutionImageUrl: brand.imageUrl,
            institutionPrimaryColor: brand.primaryColor,
          };
        } catch (error) {
          this.logger.warn(
            `Could not resolve brand for Organizze account ${account.name}: ${String(error)}`,
          );
          return {
            ...account,
            institutionName: null,
            institutionImageUrl: null,
            institutionPrimaryColor: null,
          };
        }
      }),
    );
    this.writeViewCache(cacheKey, enriched);
    return enriched;
  }

  private isCashWalletAccount(name: string): boolean {
    const normalized = name
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .trim();
    return /^(carteira|dinheiro|cash|wallet|especie)$/.test(normalized);
  }

  /**
   * Current realized balance for a bank account (cents).
   * Uses GET /balances with a range ending today.
   */
  async getAccountBalanceCents(accountId: number): Promise<number> {
    const today = new Date();
    const endDate = today.toISOString().slice(0, 10);
    const startDate = `${today.getUTCFullYear()}-01-01`;
    const response = await this.request<OrganizzeBalancesResponse>('/balances', {
      query: {
        account_id: accountId,
        start_date: startDate,
        end_date: endDate,
        periodicity: 'monthly',
      },
    });
    if (typeof response.balance !== 'number' || !Number.isFinite(response.balance)) {
      throw new Error(
        `Organizze /balances returned invalid balance for account ${accountId}`,
      );
    }
    return Math.round(response.balance);
  }

  /**
   * Account-scoped balances for a range. Prefer this over the global call —
   * without account_id, Organizze under-reports expenses (omits fatura, etc.).
   */
  async getAccountBalances(params: {
    accountId: number;
    startDate: string;
    endDate: string;
    periodicity?: 'daily' | 'weekly' | 'monthly' | 'yearly';
  }): Promise<OrganizzeBalancesResponse> {
    return this.request<OrganizzeBalancesResponse>('/balances', {
      query: {
        account_id: params.accountId,
        start_date: params.startDate,
        end_date: params.endDate,
        periodicity: params.periodicity ?? 'monthly',
      },
    });
  }

  /**
   * Receita/despesa iguais à UI do Organizze no período (pago + previsto).
   * Soma contas bancárias ativas — não usa lançamentos (evita duplicar fatura).
   */
  async getPeriodCashflow(params: {
    startDate: string;
    endDate: string;
  }): Promise<OrganizzePeriodCashflow> {
    const accounts = await this.listAccounts({ includeArchived: false });
    const rows = await Promise.all(
      accounts.map((account) =>
        this.getAccountBalances({
          accountId: account.id,
          startDate: params.startDate,
          endDate: params.endDate,
          periodicity: 'monthly',
        }),
      ),
    );
    let incomeCents = 0;
    let expenseCents = 0;
    for (const row of rows) {
      incomeCents += cashflowIncomeCents(row);
      expenseCents += cashflowExpenseCents(row);
    }
    return { incomeCents, expenseCents };
  }

  /**
   * Monthly income/expense nets from Organizze balances (one series per account,
   * then summed). Keys are `YYYY-MM`.
   */
  async getMonthlyCashflows(params: {
    startDate: string;
    endDate: string;
  }): Promise<Map<string, OrganizzePeriodCashflow>> {
    const accounts = await this.listAccounts({ includeArchived: false });
    const rows = await Promise.all(
      accounts.map((account) =>
        this.getAccountBalances({
          accountId: account.id,
          startDate: params.startDate,
          endDate: params.endDate,
          periodicity: 'monthly',
        }),
      ),
    );
    const byMonth = new Map<string, OrganizzePeriodCashflow>();
    for (const row of rows) {
      const periods = row.balances ?? [];
      for (const period of periods) {
        const monthKey = periodMonthKey(period);
        if (!monthKey) {
          continue;
        }
        const prev = byMonth.get(monthKey) ?? {
          incomeCents: 0,
          expenseCents: 0,
        };
        byMonth.set(monthKey, {
          incomeCents: prev.incomeCents + cashflowIncomeCents(period),
          expenseCents: prev.expenseCents + cashflowExpenseCents(period),
        });
      }
    }
    return byMonth;
  }

  async listCategories(options?: {
    includeArchived?: boolean;
  }): Promise<OrganizzeCategory[]> {
    const cacheKey = `categories:${options?.includeArchived ? 'all' : 'active'}`;
    const cached = this.readViewCache<OrganizzeCategory[]>(cacheKey);
    if (cached) {
      return cached;
    }
    const categories = await this.request<OrganizzeCategory[]>('/categories');
    const result = options?.includeArchived
      ? categories
      : categories.filter((category) => !this.isArchivedFlag(category.archived));
    this.writeViewCache(cacheKey, result);
    return result;
  }

  private isArchivedFlag(value: unknown): boolean {
    return value === true || value === 1 || value === '1' || value === 'true';
  }

  listTransactions(params: {
    startDate: string;
    endDate: string;
    accountId?: number;
  }): Promise<OrganizzeTransaction[]> {
    return this.request<OrganizzeTransaction[]>('/transactions', {
      query: {
        start_date: params.startDate,
        end_date: params.endDate,
        account_id: params.accountId,
      },
    });
  }

  /**
   * Organizze caps /transactions at ~500 rows per request. Fetch in 2-month
   * windows (split further when a window hits the cap) to cut request count.
   */
  async listTransactionsCovering(params: {
    startDate: string;
    endDate: string;
    accountId?: number;
  }): Promise<OrganizzeTransaction[]> {
    const start = params.startDate.slice(0, 10);
    const end = params.endDate.slice(0, 10);
    if (start > end) {
      return [];
    }
    const byId = new Map<number, OrganizzeTransaction>();
    let ym = start.slice(0, 7);
    const endYm = end.slice(0, 7);
    while (ym <= endYm) {
      const windowEndYm =
        shiftYearMonth(ym, 1) <= endYm ? shiftYearMonth(ym, 1) : ym;
      const monthStart = `${ym}-01`;
      const monthEnd = lastDayOfMonthIso(windowEndYm);
      const chunkStart = start > monthStart ? start : monthStart;
      const chunkEnd = end < monthEnd ? end : monthEnd;
      await this.collectTransactionChunk(
        chunkStart,
        chunkEnd,
        params.accountId,
        byId,
      );
      ym = shiftYearMonth(windowEndYm, 1);
    }
    return [...byId.values()];
  }

  private async collectTransactionChunk(
    startDate: string,
    endDate: string,
    accountId: number | undefined,
    byId: Map<number, OrganizzeTransaction>,
  ): Promise<void> {
    const batch = await this.listTransactions({
      startDate,
      endDate,
      accountId,
    });
    for (const tx of batch) {
      byId.set(tx.id, tx);
    }
    if (batch.length < 500 || startDate >= endDate) {
      return;
    }
    // Month still saturated — split the window in half and refetch.
    this.logger.warn(
      `Organizze /transactions returned ${batch.length} rows for ${startDate}..${endDate}; splitting window`,
    );
    const mid = midpointIso(startDate, endDate);
    if (mid <= startDate || mid >= endDate) {
      return;
    }
    // Clear this window's ids and rebuild from halves to avoid keeping a truncated set.
    for (const tx of batch) {
      byId.delete(tx.id);
    }
    await this.collectTransactionChunk(startDate, mid, accountId, byId);
    const midNext = shiftIsoDays(mid, 1);
    if (midNext <= endDate) {
      await this.collectTransactionChunk(midNext, endDate, accountId, byId);
    }
  }

  getTransaction(id: number): Promise<OrganizzeTransaction> {
    return this.request<OrganizzeTransaction>(`/transactions/${id}`);
  }

  /**
   * Organizze has no GET /tags. Harvest unique tag names from recent txs.
   */
  async listTags(options?: { days?: number }): Promise<OrganizzeTag[]> {
    const days =
      typeof options?.days === 'number' && options.days > 0
        ? Math.min(Math.floor(options.days), 365)
        : 90;
    const end = new Date();
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - days);
    const endDate = end.toISOString().slice(0, 10);
    const startDate = start.toISOString().slice(0, 10);
    const transactions = await this.listTransactions({ startDate, endDate });
    const seen = new Set<string>();
    const tags: OrganizzeTag[] = [];
    for (const tx of transactions) {
      for (const tag of tx.tags ?? []) {
        const name = (tag.name ?? '').trim().slice(0, TAG_NAME_MAX_LEN);
        if (!name) {
          continue;
        }
        const key = name.toLowerCase();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        tags.push({ name });
      }
    }
    tags.sort((a, b) =>
      a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }),
    );
    return tags;
  }

  async listCreditCards(options?: {
    includeArchived?: boolean;
  }): Promise<OrganizzeCreditCard[]> {
    const cacheKey = `credit_cards:${options?.includeArchived ? 'all' : 'active'}`;
    const cached = this.readViewCache<OrganizzeCreditCard[]>(cacheKey);
    if (cached) {
      return cached;
    }
    const cards = await this.request<OrganizzeCreditCard[]>('/credit_cards');
    const normalized = cards.map((card) => this.normalizeCreditCard(card));
    const result = options?.includeArchived
      ? normalized
      : normalized.filter((card) => !card.archived);
    this.writeViewCache(cacheKey, result);
    return result;
  }

  private normalizeCreditCard(card: OrganizzeCreditCard): OrganizzeCreditCard {
    const raw = card as OrganizzeCreditCard & {
      payment_account_id?: number | null;
      paymentAccountId?: number | null;
    };
    const paymentAccountId =
      typeof raw.payment_account_id === 'number'
        ? raw.payment_account_id
        : typeof raw.paymentAccountId === 'number'
          ? raw.paymentAccountId
          : null;
    return {
      ...card,
      payment_account_id: paymentAccountId,
    };
  }

  listInvoices(creditCardId: number): Promise<OrganizzeInvoice[]> {
    return this.request<OrganizzeInvoice[]>(
      `/credit_cards/${creditCardId}/invoices`,
    );
  }

  getInvoice(
    creditCardId: number,
    invoiceId: number,
  ): Promise<OrganizzeInvoice> {
    return this.request<OrganizzeInvoice>(
      `/credit_cards/${creditCardId}/invoices/${invoiceId}`,
    );
  }

  async createTransaction(
    payload: CreateOrganizzeTransactionPayload,
  ): Promise<OrganizzeTransaction> {
    const row = await this.request<OrganizzeTransaction>('/transactions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    this.clearGetCache();
    return row;
  }

  async createTransfer(
    payload: CreateOrganizzeTransferPayload,
  ): Promise<OrganizzeTransaction> {
    const row = await this.request<OrganizzeTransaction>('/transfers', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    this.clearGetCache();
    return row;
  }

  async updateTransaction(
    id: number,
    payload: UpdateOrganizzeTransactionPayload,
  ): Promise<OrganizzeTransaction> {
    const row = await this.request<OrganizzeTransaction>(`/transactions/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    this.clearGetCache();
    return row;
  }

  async deleteTransaction(id: number): Promise<void> {
    await this.request<void>(`/transactions/${id}`, {
      method: 'DELETE',
    });
    this.clearGetCache();
  }

  async createInvoicePayment(
    creditCardId: number,
    invoiceId: number,
    payload: CreateInvoicePaymentPayload,
  ): Promise<OrganizzeTransaction> {
    const row = await this.request<OrganizzeTransaction>(
      `/credit_cards/${creditCardId}/invoices/${invoiceId}/payments`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
    this.clearGetCache();
    return row;
  }

  appendPluggyMarker(
    notes: string | null | undefined,
    pluggyTransactionId: string,
  ): string {
    return appendPluggyMarker(notes, pluggyTransactionId);
  }

  removePluggyMarker(
    notes: string | null | undefined,
    pluggyTransactionId: string,
  ): string {
    return removePluggyMarker(notes, pluggyTransactionId);
  }

  extractPluggyIds(notes: string | null | undefined): string[] {
    return extractPluggyIds(notes);
  }

  notesContainPluggyId(
    notes: string | null | undefined,
    pluggyTransactionId: string,
  ): boolean {
    return notesContainPluggyId(notes, pluggyTransactionId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableOrganizzeStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 520 ||
    status === 521 ||
    status === 522 ||
    status === 523 ||
    status === 524
  );
}

function retryDelayMs(body: string | null, attempt: number): number {
  if (body) {
    try {
      const parsed = JSON.parse(body) as { retry_after?: number };
      if (
        typeof parsed.retry_after === 'number' &&
        Number.isFinite(parsed.retry_after) &&
        parsed.retry_after > 0
      ) {
        // Cap so a single overview call does not hang for minutes.
        return Math.min(45_000, Math.round(parsed.retry_after * 1000));
      }
    } catch {
      // ignore non-JSON bodies
    }
  }
  return Math.min(30_000, 1_500 * 2 ** attempt);
}

function shiftYearMonth(yearMonth: string, delta: number): string {
  const [y, m] = yearMonth.split('-').map(Number);
  const abs = y * 12 + (m - 1) + delta;
  const ny = Math.floor(abs / 12);
  const nm = (abs % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

function lastDayOfMonthIso(yearMonth: string): string {
  const y = Number(yearMonth.slice(0, 4));
  const m = Number(yearMonth.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${yearMonth}-${String(last).padStart(2, '0')}`;
}

function midpointIso(startDate: string, endDate: string): string {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  const mid = new Date(Math.floor((start + end) / 2));
  return mid.toISOString().slice(0, 10);
}

function shiftIsoDays(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00.000Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
