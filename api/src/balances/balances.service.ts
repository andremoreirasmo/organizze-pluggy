import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Account } from 'pluggy-sdk';
import { OrganizzeService } from '../organizze/organizze.service';
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
  UnmappedInvestment,
} from './balances.types';

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

    const [accounts, investments, organizzeAccounts] = await Promise.all([
      this.pluggy.listAccounts().catch((error) => {
        this.logger.warn(`listAccounts failed: ${String(error)}`);
        return [] as Account[];
      }),
      this.pluggy.listInvestments().catch((error) => {
        this.logger.warn(`listInvestments failed: ${String(error)}`);
        return [] as PluggyInvestmentView[];
      }),
      this.organizze.listAccounts({ includeArchived: false }),
    ]);
    perf.mark(
      `pluggy+oz accounts=${accounts.length} investments=${investments.length}`,
    );
    this.logger.log(
      `Balance snapshot: ${accounts.length} accounts, ${investments.length} investments`,
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

    perf.end(
      `rows=${rows.length} investments=${investments.length} unmapped=${unmappedInvestments.length}`,
    );
    return {
      generatedAt: new Date().toISOString(),
      toleranceCents: BALANCE_TOLERANCE_CENTS,
      investmentsFound: investments.length,
      rows,
      unmappedInvestments,
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
