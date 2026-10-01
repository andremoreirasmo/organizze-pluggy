import type { Account } from 'pluggy-sdk';

const CARD_KEY_SEPARATOR = '::';

export type PluggyAccountView = {
  /** Mapping key: account id, or `accountId::last4` for additional cards. */
  id: string;
  sourceAccountId: string;
  cardNumber: string | null;
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

export function normalizeCardNumber(value: string | null | undefined): string | null {
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
  const separatorIndex = key.indexOf(CARD_KEY_SEPARATOR);
  if (separatorIndex === -1) {
    return { sourceAccountId: key, cardNumber: null };
  }
  return {
    sourceAccountId: key.slice(0, separatorIndex),
    cardNumber: normalizeCardNumber(key.slice(separatorIndex + CARD_KEY_SEPARATOR.length)),
  };
}

export function buildPluggyAccountMapKey(
  sourceAccountId: string,
  cardNumber: string | null | undefined,
): string {
  const normalized = normalizeCardNumber(cardNumber);
  if (!normalized) {
    return sourceAccountId;
  }
  return `${sourceAccountId}${CARD_KEY_SEPARATOR}${normalized}`;
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
 * Expand CREDIT accounts that expose additionalCards into one mappable row
 * per physical card (same source account, distinct map keys).
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
    if (cardNumbers.length <= 1) {
      const cardNumber = cardNumbers[0] ?? normalizeCardNumber(account.number);
      views.push({
        id: account.id,
        sourceAccountId: account.id,
        cardNumber,
        name: account.name,
        type: account.type,
        subtype: account.subtype ?? null,
        number: cardNumber ?? account.number ?? null,
        owner: account.owner ?? null,
        marketingName: account.marketingName ?? null,
        creditData: account.creditData,
        bankData: account.bankData,
      });
      continue;
    }

    for (const cardNumber of cardNumbers) {
      views.push({
        id: buildPluggyAccountMapKey(account.id, cardNumber),
        sourceAccountId: account.id,
        cardNumber,
        name: account.name,
        type: account.type,
        subtype: account.subtype ?? null,
        number: cardNumber,
        owner: account.owner ?? null,
        marketingName: account.marketingName ?? null,
        creditData: account.creditData,
        bankData: account.bankData,
      });
    }
  }

  return views;
}

export function resolveMappedAccountKey(params: {
  sourceAccountId: string;
  cardNumber: string | null | undefined;
  mappedKeys: Set<string>;
}): string {
  const specific = buildPluggyAccountMapKey(
    params.sourceAccountId,
    params.cardNumber,
  );
  if (params.mappedKeys.has(specific)) {
    return specific;
  }
  if (params.mappedKeys.has(params.sourceAccountId)) {
    return params.sourceAccountId;
  }
  return specific;
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
