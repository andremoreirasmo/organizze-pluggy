import { normalizeCardNumber } from '../pluggy/pluggy-accounts';

export type AccountMapTargetType = 'account' | 'credit_card' | 'ignored';

export type BalanceSourceKind = 'account' | 'investment' | 'reserved';

export type AccountMap = {
  pluggyAccountId: string;
  targetType: AccountMapTargetType;
  /** Organizze account/card id; `0` when `targetType` is `ignored`. */
  organizzeTargetId: number;
  /** Optional label for bank accounts (or fallback). */
  nickname?: string | null;
  /** Nicknames for physical cards under a CREDIT parent (last4 → label). */
  cardNicknames?: Record<string, string> | null;
};

export type ActiveAccountMap = {
  pluggyAccountId: string;
  targetType: 'account' | 'credit_card';
  organizzeTargetId: number;
  nickname?: string | null;
  cardNicknames?: Record<string, string> | null;
};

export function isActiveAccountMap(map: AccountMap): map is ActiveAccountMap {
  return map.targetType === 'account' || map.targetType === 'credit_card';
}

export type BalanceMap = {
  /** Stable key: `account:{id}`, `investment:{id}`, or `reserved:{accountId}::{identification}`. */
  sourceKey: string;
  sourceKind: BalanceSourceKind;
  pluggySourceId: string;
  organizzeAccountId: number;
  nickname?: string | null;
  /** When false, source is excluded from balance snapshot. Default true. */
  enabled?: boolean;
};

export function buildBalanceSourceKey(
  kind: BalanceSourceKind,
  pluggySourceId: string,
): string {
  return `${kind}:${pluggySourceId}`;
}

export function parseBalanceSourceKey(sourceKey: string): {
  sourceKind: BalanceSourceKind;
  pluggySourceId: string;
} | null {
  const separator = sourceKey.indexOf(':');
  if (separator <= 0) {
    return null;
  }
  const sourceKind = sourceKey.slice(0, separator);
  const pluggySourceId = sourceKey.slice(separator + 1).trim();
  if (
    (sourceKind !== 'account' &&
      sourceKind !== 'investment' &&
      sourceKind !== 'reserved') ||
    !pluggySourceId
  ) {
    return null;
  }
  return { sourceKind, pluggySourceId };
}

/** Reserved source id: `{accountId}::{identification}` */
export function buildReservedSourceId(
  accountId: string,
  identification: string,
): string {
  return `${accountId}::${identification}`;
}

export function parseReservedSourceId(pluggySourceId: string): {
  accountId: string;
  identification: string;
} | null {
  const separator = pluggySourceId.indexOf('::');
  if (separator <= 0) {
    return null;
  }
  const accountId = pluggySourceId.slice(0, separator);
  const identification = pluggySourceId.slice(separator + 2).trim();
  if (!accountId || !identification) {
    return null;
  }
  return { accountId, identification };
}

export type AppSettings = {
  amountTolerancePercent: number;
  dateToleranceDays: number;
  accountMaps: AccountMap[];
  balanceMaps: BalanceMap[];
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  amountTolerancePercent: 5,
  dateToleranceDays: 5,
  accountMaps: [],
  balanceMaps: [],
};

function normalizeNickname(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().slice(0, 40);
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCardNicknames(
  value: unknown,
): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const card = normalizeCardNumber(key);
    const nickname = normalizeNickname(raw);
    if (card && nickname) {
      out[card] = nickname;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function mergeCardNicknames(
  ...parts: Array<Record<string, string> | null | undefined>
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const part of parts) {
    if (!part) {
      continue;
    }
    Object.assign(out, part);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Collapse legacy `accountId::last4` maps into parent maps + cardNicknames.
 */
function consolidateAccountMaps(rawItems: unknown[]): AccountMap[] {
  type Draft = {
    pluggyAccountId: string;
    targetType: AccountMapTargetType;
    organizzeTargetId: number;
    nickname: string | null;
    cardNicknames: Record<string, string>;
  };

  const byParent = new Map<string, Draft>();

  const ensureParent = (
    parentId: string,
    seed?: Partial<Draft>,
  ): Draft => {
    const existing = byParent.get(parentId);
    if (existing) {
      if (seed?.targetType && existing.targetType === 'ignored' && seed.targetType !== 'ignored') {
        existing.targetType = seed.targetType;
        existing.organizzeTargetId = seed.organizzeTargetId ?? existing.organizzeTargetId;
      }
      if (seed?.nickname && !existing.nickname) {
        existing.nickname = seed.nickname;
      }
      if (seed?.cardNicknames) {
        Object.assign(existing.cardNicknames, seed.cardNicknames);
      }
      if (
        seed?.organizzeTargetId &&
        seed.organizzeTargetId > 0 &&
        existing.organizzeTargetId <= 0
      ) {
        existing.organizzeTargetId = seed.organizzeTargetId;
        if (seed.targetType) {
          existing.targetType = seed.targetType;
        }
      }
      return existing;
    }
    const created: Draft = {
      pluggyAccountId: parentId,
      targetType: seed?.targetType ?? 'ignored',
      organizzeTargetId: seed?.organizzeTargetId ?? 0,
      nickname: seed?.nickname ?? null,
      cardNicknames: { ...(seed?.cardNicknames ?? {}) },
    };
    byParent.set(parentId, created);
    return created;
  };

  for (const item of rawItems) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const map = item as Partial<AccountMap> & { pluggyAccountId?: string };
    if (typeof map.pluggyAccountId !== 'string' || !map.pluggyAccountId.trim()) {
      continue;
    }
    if (
      map.targetType !== 'account' &&
      map.targetType !== 'credit_card' &&
      map.targetType !== 'ignored'
    ) {
      continue;
    }

    const rawId = map.pluggyAccountId.trim();
    const separator = rawId.indexOf('::');
    const nickname = normalizeNickname(map.nickname);
    const cardNicknames = normalizeCardNicknames(map.cardNicknames) ?? {};

    if (separator !== -1) {
      const parentId = rawId.slice(0, separator);
      const card = normalizeCardNumber(rawId.slice(separator + 2));
      const organizzeTargetId =
        map.targetType === 'ignored'
          ? 0
          : typeof map.organizzeTargetId === 'number' &&
              Number.isFinite(map.organizzeTargetId) &&
              map.organizzeTargetId > 0
            ? map.organizzeTargetId
            : 0;
      const parent = ensureParent(parentId, {
        targetType: map.targetType,
        organizzeTargetId,
        nickname: null,
        cardNicknames,
      });
      if (card && nickname) {
        parent.cardNicknames[card] = nickname;
      }
      if (organizzeTargetId > 0 && parent.organizzeTargetId <= 0) {
        parent.targetType = map.targetType;
        parent.organizzeTargetId = organizzeTargetId;
      }
      continue;
    }

    if (map.targetType === 'ignored') {
      ensureParent(rawId, {
        targetType: 'ignored',
        organizzeTargetId: 0,
        nickname,
        cardNicknames,
      });
      continue;
    }

    if (
      typeof map.organizzeTargetId !== 'number' ||
      !Number.isFinite(map.organizzeTargetId) ||
      map.organizzeTargetId <= 0
    ) {
      continue;
    }

    ensureParent(rawId, {
      targetType: map.targetType,
      organizzeTargetId: map.organizzeTargetId,
      nickname,
      cardNicknames,
    });
  }

  const accountMaps: AccountMap[] = [];
  for (const draft of byParent.values()) {
    if (draft.targetType === 'ignored') {
      accountMaps.push({
        pluggyAccountId: draft.pluggyAccountId,
        targetType: 'ignored',
        organizzeTargetId: 0,
        nickname: draft.nickname,
        cardNicknames: mergeCardNicknames(draft.cardNicknames),
      });
      continue;
    }
    if (draft.organizzeTargetId <= 0) {
      continue;
    }
    accountMaps.push({
      pluggyAccountId: draft.pluggyAccountId,
      targetType: draft.targetType,
      organizzeTargetId: draft.organizzeTargetId,
      nickname: draft.nickname,
      cardNicknames: mergeCardNicknames(draft.cardNicknames),
    });
  }
  return accountMaps;
}

function consolidateBalanceMaps(rawItems: unknown[]): BalanceMap[] {
  const byKey = new Map<string, BalanceMap>();

  for (const item of rawItems) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const map = item as Partial<BalanceMap>;
    let sourceKind: BalanceSourceKind | null = null;
    let pluggySourceId = '';
    let sourceKey = '';

    if (typeof map.sourceKey === 'string' && map.sourceKey.trim()) {
      const parsed = parseBalanceSourceKey(map.sourceKey.trim());
      if (!parsed) {
        continue;
      }
      sourceKind = parsed.sourceKind;
      pluggySourceId = parsed.pluggySourceId;
      sourceKey = buildBalanceSourceKey(sourceKind, pluggySourceId);
    } else if (
      (map.sourceKind === 'account' ||
        map.sourceKind === 'investment' ||
        map.sourceKind === 'reserved') &&
      typeof map.pluggySourceId === 'string' &&
      map.pluggySourceId.trim()
    ) {
      sourceKind = map.sourceKind;
      pluggySourceId = map.pluggySourceId.trim();
      sourceKey = buildBalanceSourceKey(sourceKind, pluggySourceId);
    } else {
      continue;
    }

    if (
      typeof map.organizzeAccountId !== 'number' ||
      !Number.isFinite(map.organizzeAccountId) ||
      map.organizzeAccountId <= 0
    ) {
      continue;
    }

    byKey.set(sourceKey, {
      sourceKey,
      sourceKind,
      pluggySourceId,
      organizzeAccountId: map.organizzeAccountId,
      nickname: normalizeNickname(map.nickname),
      enabled: map.enabled === false ? false : true,
    });
  }

  return [...byKey.values()];
}

export function normalizeAppSettings(raw: unknown): AppSettings {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_APP_SETTINGS, accountMaps: [], balanceMaps: [] };
  }

  const data = raw as Partial<AppSettings>;
  const amountTolerancePercent =
    typeof data.amountTolerancePercent === 'number' &&
    data.amountTolerancePercent >= 0
      ? data.amountTolerancePercent
      : DEFAULT_APP_SETTINGS.amountTolerancePercent;
  const dateToleranceDays =
    typeof data.dateToleranceDays === 'number' && data.dateToleranceDays >= 0
      ? Math.floor(data.dateToleranceDays)
      : DEFAULT_APP_SETTINGS.dateToleranceDays;

  const accountMaps = Array.isArray(data.accountMaps)
    ? consolidateAccountMaps(data.accountMaps)
    : [];
  const balanceMaps = Array.isArray(data.balanceMaps)
    ? consolidateBalanceMaps(data.balanceMaps)
    : [];

  return {
    amountTolerancePercent,
    dateToleranceDays,
    accountMaps,
    balanceMaps,
  };
}
