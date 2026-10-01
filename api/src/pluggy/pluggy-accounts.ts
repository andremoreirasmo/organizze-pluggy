import type { Account } from 'pluggy-sdk';

export type PluggyAdditionalCard = {
  number: string;
};

export type PluggyAccountView = {
  /** Always the Pluggy source account id (parent). */
  id: string;
  sourceAccountId: string;
  /** Primary card last4 when CREDIT; otherwise null. */
  cardNumber: string | null;
  /** Physical cards under a CREDIT account (for nicknames only). */
  additionalCards: PluggyAdditionalCard[];
  name: string;
  type: string;
  subtype: string | null;
  number: string | null;
  owner: string | null;
  marketingName: string | null;
  creditData: Account['creditData'];
  bankData: Account['bankData'];
};

type CreditDataWithAdditional = NonNullable<Account['creditData']> & {
  additionalCards?: Array<{ number?: string | null }>;
};

export function normalizeCardNumber(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) {
    return digits.length > 0 ? digits : null;
  }
  return digits.slice(-4);
}

export function parsePluggyAccountMapKey(key: string): {
  sourceAccountId: string;
  cardNumber: string | null;
} {
  const separatorIndex = key.indexOf('::');
  if (separatorIndex === -1) {
    return { sourceAccountId: key, cardNumber: null };
  }
  return {
    sourceAccountId: key.slice(0, separatorIndex),
    cardNumber: normalizeCardNumber(key.slice(separatorIndex + 2)),
  };
}

function listCreditCardNumbers(account: Account): string[] {
  const primary = normalizeCardNumber(account.number);
  const creditData = account.creditData as CreditDataWithAdditional | null;
  const additional = (creditData?.additionalCards ?? [])
    .map((card) => normalizeCardNumber(card.number))
    .filter((value): value is string => Boolean(value));

  const numbers: string[] = [];
  const seen = new Set<string>();
  for (const value of [primary, ...additional]) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    numbers.push(value);
  }
  return numbers;
}

/** Drop obvious duplicates Pluggy sometimes returns for the same bank account. */
export function dedupePluggyAccounts(accounts: Account[]): Account[] {
  const seen = new Set<string>();
  const result: Account[] = [];
  for (const account of accounts) {
    const numberKey = normalizeCardNumber(account.number) ?? account.id;
    const key = `${account.type}:${numberKey}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(account);
  }
  return result;
}

/**
 * One row per Pluggy account. CREDIT accounts expose additionalCards for
 * nickname UI; Organizze mapping stays on the parent id only.
 */
export function expandPluggyAccountsForMapping(
  accounts: Account[],
): PluggyAccountView[] {
  const deduped = dedupePluggyAccounts(accounts);
  const views: PluggyAccountView[] = [];

  for (const account of deduped) {
    if ((account.type ?? '').toUpperCase() !== 'CREDIT') {
      views.push({
        id: account.id,
        sourceAccountId: account.id,
        cardNumber: null,
        additionalCards: [],
        name: account.name,
        type: account.type,
        subtype: account.subtype ?? null,
        number: account.number ?? null,
        owner: account.owner ?? null,
        marketingName: account.marketingName ?? null,
        creditData: account.creditData,
        bankData: account.bankData,
      });
      continue;
    }

    const cardNumbers = listCreditCardNumbers(account);
    const primary = cardNumbers[0] ?? normalizeCardNumber(account.number);
    views.push({
      id: account.id,
      sourceAccountId: account.id,
      cardNumber: primary,
      additionalCards: cardNumbers.map((number) => ({ number })),
      name: account.name,
      type: account.type,
      subtype: account.subtype ?? null,
      number: primary ?? account.number ?? null,
      owner: account.owner ?? null,
      marketingName: account.marketingName ?? null,
      creditData: account.creditData,
      bankData: account.bankData,
    });
  }

  return views;
}

export function transactionCardNumber(
  tx: { creditCardMetadata?: { cardNumber?: string | null } | null },
  account: { number?: string | null; type?: string | null },
): string | null {
  const fromTx = normalizeCardNumber(tx.creditCardMetadata?.cardNumber);
  if (fromTx) {
    return fromTx;
  }
  if ((account.type ?? '').toUpperCase() === 'CREDIT') {
    return normalizeCardNumber(account.number);
  }
  return null;
}

export function resolveCardNickname(
  map: { nickname?: string | null; cardNicknames?: Record<string, string> | null },
  cardNumber: string | null | undefined,
): string | null {
  const normalized = normalizeCardNumber(cardNumber);
  if (normalized && map.cardNicknames?.[normalized]) {
    return map.cardNicknames[normalized] ?? null;
  }
  return map.nickname?.trim() ? map.nickname.trim() : null;
}
