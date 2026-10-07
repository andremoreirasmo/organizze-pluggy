import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InstitutionBrandService } from '../institution/institution-brand.service';
import {
  CreateInvoicePaymentPayload,
  CreateOrganizzeTransferPayload,
  CreateOrganizzeTransactionPayload,
  OrganizzeAccount,
  OrganizzeBalancesResponse,
  OrganizzeCategory,
  OrganizzeCreditCard,
  OrganizzeInvoice,
  OrganizzeTag,
  OrganizzeTransaction,
  UpdateOrganizzeTransactionPayload,
} from './organizze.types';
import { TAG_NAME_MAX_LEN } from './organizze-tags';
import {
  appendPluggyMarker,
  extractPluggyIds,
  notesContainPluggyId,
  removePluggyMarker,
} from './pluggy-notes';

@Injectable()
export class OrganizzeService {
  private readonly logger = new Logger(OrganizzeService.name);
  private readonly baseUrl = 'https://api.organizze.com.br/rest/v2';

  constructor(
    private readonly config: ConfigService,
    private readonly institutionBrand: InstitutionBrandService,
  ) {}

  private authHeader(): string {
    const email = this.config.getOrThrow<string>('ORGANIZZE_EMAIL');
    const token = this.config.getOrThrow<string>('ORGANIZZE_API_TOKEN');
    return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  }

  private async request<T>(
    path: string,
    init?: RequestInit & { query?: Record<string, string | number | undefined> },
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (init?.query) {
      for (const [key, value] of Object.entries(init.query)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const { query: _query, ...fetchInit } = init ?? {};
    const started = Date.now();
    const method = (fetchInit.method ?? 'GET').toUpperCase();
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
      `[perf] Organizze ${method} ${path} → ${response.status} in ${elapsed}ms`,
    );

    if (!response.ok) {
      const body = await response.text();
      this.logger.error(`Organizze ${path} failed: ${response.status} ${body}`);
      throw new Error(`Organizze API error ${response.status}: ${body}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  async listAccounts(options?: {
    includeArchived?: boolean;
  }): Promise<OrganizzeAccount[]> {
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

    return Promise.all(
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

  async listCategories(options?: {
    includeArchived?: boolean;
  }): Promise<OrganizzeCategory[]> {
    const categories = await this.request<OrganizzeCategory[]>('/categories');
    if (options?.includeArchived) {
      return categories;
    }
    return categories.filter((category) => !this.isArchivedFlag(category.archived));
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
    const cards = await this.request<OrganizzeCreditCard[]>('/credit_cards');
    const normalized = cards.map((card) => this.normalizeCreditCard(card));
    if (options?.includeArchived) {
      return normalized;
    }
    return normalized.filter((card) => !card.archived);
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

  createTransaction(
    payload: CreateOrganizzeTransactionPayload,
  ): Promise<OrganizzeTransaction> {
    return this.request<OrganizzeTransaction>('/transactions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  createTransfer(
    payload: CreateOrganizzeTransferPayload,
  ): Promise<OrganizzeTransaction> {
    return this.request<OrganizzeTransaction>('/transfers', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  updateTransaction(
    id: number,
    payload: UpdateOrganizzeTransactionPayload,
  ): Promise<OrganizzeTransaction> {
    return this.request<OrganizzeTransaction>(`/transactions/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  deleteTransaction(id: number): Promise<void> {
    return this.request<void>(`/transactions/${id}`, {
      method: 'DELETE',
    });
  }

  createInvoicePayment(
    creditCardId: number,
    invoiceId: number,
    payload: CreateInvoicePaymentPayload,
  ): Promise<OrganizzeTransaction> {
    return this.request<OrganizzeTransaction>(
      `/credit_cards/${creditCardId}/invoices/${invoiceId}/payments`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
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
