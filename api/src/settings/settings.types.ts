export type AccountMapTargetType = 'account' | 'credit_card' | 'ignored';

export type AccountMap = {
  pluggyAccountId: string;
  targetType: AccountMapTargetType;
  /** Organizze account/card id; `0` when `targetType` is `ignored`. */
  organizzeTargetId: number;
  /** Optional display label (e.g. André / Fabi). */
  nickname?: string | null;
};

export type ActiveAccountMap = {
  pluggyAccountId: string;
  targetType: 'account' | 'credit_card';
  organizzeTargetId: number;
  nickname?: string | null;
};

export function isActiveAccountMap(map: AccountMap): map is ActiveAccountMap {
  return map.targetType === 'account' || map.targetType === 'credit_card';
}

export type AppSettings = {
  amountTolerancePercent: number;
  dateToleranceDays: number;
  accountMaps: AccountMap[];
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  amountTolerancePercent: 5,
  dateToleranceDays: 5,
  accountMaps: [],
};

function normalizeNickname(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().slice(0, 40);
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeAppSettings(raw: unknown): AppSettings {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_APP_SETTINGS, accountMaps: [] };
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

  const accountMaps: AccountMap[] = [];
  if (Array.isArray(data.accountMaps)) {
    for (const item of data.accountMaps) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const map = item as Partial<AccountMap>;
      if (
        typeof map.pluggyAccountId !== 'string' ||
        !map.pluggyAccountId.trim()
      ) {
        continue;
      }
      if (
        map.targetType !== 'account' &&
        map.targetType !== 'credit_card' &&
        map.targetType !== 'ignored'
      ) {
        continue;
      }

      const nickname = normalizeNickname(map.nickname);

      if (map.targetType === 'ignored') {
        accountMaps.push({
          pluggyAccountId: map.pluggyAccountId.trim(),
          targetType: 'ignored',
          organizzeTargetId: 0,
          nickname,
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
      accountMaps.push({
        pluggyAccountId: map.pluggyAccountId.trim(),
        targetType: map.targetType,
        organizzeTargetId: map.organizzeTargetId,
        nickname,
      });
    }
  }

  return {
    amountTolerancePercent,
    dateToleranceDays,
    accountMaps,
  };
}
