export type ReconciliationKind =
  | 'bank'
  | 'credit_purchase'
  | 'invoice_payment_candidate'
  | 'same_person_transfer';

export type TransferCounterpartHint = {
  pluggyId: string;
  accountName: string;
  accountNickname: string | null;
  accountNumberLast4: string | null;
  mappedOrganizzeTargetId: number;
  organizzeAmountCents: number;
  date: string;
};

export type QueuePluggyTransaction = {
  id: string;
  providerId: string | null;
  description: string;
  amount: number;
  amountCents: number;
  /** Amount to write/match in Organizze (credit purchases always negative) */
  organizzeAmountCents: number;
  date: string;
  currencyCode: string | null;
  type: string | null;
  operationType: string | null;
  category: string | null;
  accountId: string;
  accountName: string;
  accountType: string | null;
  accountSubtype: string | null;
  kind: ReconciliationKind;
  mappedTargetType: 'account' | 'credit_card';
  mappedOrganizzeTargetId: number;
  /** Last 4 digits from Pluggy account number, when available. */
  accountNumberLast4: string | null;
  accountOwner: string | null;
  /** Optional nickname from account mapping settings. */
  accountNickname: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
  purchaseDate: string | null;
  totalPurchaseAmount: number | null;
  /** Opposite Open Finance leg when both sides are in the queue. */
  transferCounterpart: TransferCounterpartHint | null;
};

export type MatchCandidate = {
  organizzeTransactionId: number;
  description: string;
  date: string;
  amountCents: number;
  paid: boolean;
  recurring: boolean;
  accountId: number | null;
  accountName: string | null;
  creditCardId: number | null;
  creditCardName: string | null;
  creditCardInvoiceId: number | null;
  categoryId: number | null;
  categoryName: string | null;
  installment: number | null;
  totalInstallments: number | null;
  score: number;
  amountDiffCents: number;
  daysDiff: number;
};

export type ReconciliationQueueItem = {
  pluggy: QueuePluggyTransaction;
  suggestions: MatchCandidate[];
};

export type ReconciliationQueueResponse = {
  from: string;
  to: string;
  items: ReconciliationQueueItem[];
  unmappedPluggyAccounts: Array<{
    id: string;
    name: string;
    type: string | null;
    subtype: string | null;
  }>;
};

export function toAmountCents(amountReais: number): number {
  return Math.round(amountReais * 100);
}

export function fromAmountCents(amountCents: number): number {
  return amountCents / 100;
}

export function parseDateOnly(value: string): Date {
  const datePart = value.slice(0, 10);
  const [year, month, day] = datePart.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function daysBetween(a: string, b: string): number {
  const ms = Math.abs(parseDateOnly(a).getTime() - parseDateOnly(b).getTime());
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

const INVOICE_PAYMENT_DESCRIPTION_RE =
  /pagamento\s+d[eo]\s+fatura|pagto\.?\s*fatura|pag\.?\s*fatura|pagamento.*fatura/i;

const SAME_PERSON_TRANSFER_RE =
  /same\s*person\s*transfer|transfer[eê]ncia\s+entre\s+contas|transferencia\s+mesma\s+titularidade|same.?person/i;

export function looksLikeSamePersonTransfer(params: {
  accountType: string | null | undefined;
  operationType: string | null | undefined;
  category: string | null | undefined;
  description: string;
}): boolean {
  if ((params.accountType ?? '').toUpperCase() === 'CREDIT') {
    return false;
  }
  const hay = [
    params.category ?? '',
    params.operationType ?? '',
    params.description,
  ].join(' ');
  return SAME_PERSON_TRANSFER_RE.test(hay);
}

export function looksLikeInvoicePayment(params: {
  accountType: string | null | undefined;
  operationType: string | null | undefined;
  description: string;
  amount: number;
}): boolean {
  if ((params.accountType ?? '').toUpperCase() === 'CREDIT') {
    return false;
  }
  if (params.amount >= 0) {
    return false;
  }
  const operation = (params.operationType ?? '').toUpperCase();
  if (
    operation.includes('PAGAMENTO_FATURA') ||
    operation.includes('BILL_PAYMENT')
  ) {
    return true;
  }
  return INVOICE_PAYMENT_DESCRIPTION_RE.test(params.description);
}

export function toOrganizzeAmountCents(
  amountCents: number,
  kind: ReconciliationKind,
): number {
  if (kind === 'credit_purchase' || kind === 'invoice_payment_candidate') {
    return -Math.abs(amountCents);
  }
  return amountCents;
}

export function isInstallmentPurchase(params: {
  installmentNumber: number | null;
  totalInstallments: number | null;
}): boolean {
  const total = params.totalInstallments ?? 0;
  return total > 1;
}

function normalizeDescription(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function descriptionSimilarity(a: string, b: string): number {
  const left = normalizeDescription(a);
  const right = normalizeDescription(b);
  if (!left || !right) {
    return 0;
  }
  if (left === right) {
    return 1;
  }
  if (left.includes(right) || right.includes(left)) {
    return 0.85;
  }

  const leftTokens = new Set(left.split(' ').filter((token) => token.length > 2));
  const rightTokens = new Set(
    right.split(' ').filter((token) => token.length > 2),
  );
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

export function scoreMatch(params: {
  pluggyAmountCents: number;
  pluggyDate: string;
  pluggyPurchaseDate?: string | null;
  pluggyDescription: string;
  pluggyInstallmentNumber?: number | null;
  pluggyTotalInstallments?: number | null;
  organizzeAmountCents: number;
  organizzeDate: string;
  organizzeDescription: string;
  organizzeInstallment?: number | null;
  organizzeTotalInstallments?: number | null;
  paid: boolean;
  recurring: boolean;
  amountTolerancePercent: number;
  dateToleranceDays: number;
  kind: ReconciliationKind;
}): number | null {
  const amountDiff = Math.abs(
    Math.abs(params.pluggyAmountCents) - Math.abs(params.organizzeAmountCents),
  );
  const maxAmount = Math.max(
    Math.abs(params.pluggyAmountCents),
    Math.abs(params.organizzeAmountCents),
    1,
  );
  const amountPct = (amountDiff / maxAmount) * 100;
  if (amountPct > params.amountTolerancePercent) {
    return null;
  }
  const exactAmount = amountDiff === 0;

  const installmentExact =
    (params.pluggyTotalInstallments ?? 0) > 1 &&
    params.pluggyInstallmentNumber != null &&
    params.pluggyTotalInstallments != null &&
    params.organizzeInstallment === params.pluggyInstallmentNumber &&
    params.organizzeTotalInstallments === params.pluggyTotalInstallments;

  const installmentSameSeries =
    (params.pluggyTotalInstallments ?? 0) > 1 &&
    params.pluggyTotalInstallments != null &&
    params.organizzeTotalInstallments === params.pluggyTotalInstallments;

  // Card installments often land on different calendar days across systems.
  // Exact-amount unpaid/recurring bills (e.g. Claro) also need a wider window.
  let effectiveDateTolerance =
    params.kind === 'credit_purchase'
      ? Math.max(
          params.dateToleranceDays,
          installmentExact ? 45 : installmentSameSeries ? 35 : 25,
        )
      : params.dateToleranceDays;
  if (exactAmount && (!params.paid || params.recurring)) {
    effectiveDateTolerance = Math.max(
      effectiveDateTolerance,
      params.kind === 'credit_purchase' ? 45 : 15,
    );
  }

  const dateCandidates = [params.pluggyDate];
  if (params.pluggyPurchaseDate) {
    dateCandidates.push(params.pluggyPurchaseDate);
  }
  const daysDiff = Math.min(
    ...dateCandidates.map((date) => daysBetween(date, params.organizzeDate)),
  );
  if (daysDiff > effectiveDateTolerance) {
    return null;
  }

  const descScore = descriptionSimilarity(
    params.pluggyDescription,
    params.organizzeDescription,
  );

  // For credit purchases without installment/exact-amount match, require some
  // description overlap OR a very close date, otherwise random same-ish-amount
  // txs pollute suggestions.
  if (
    params.kind === 'credit_purchase' &&
    !installmentExact &&
    !exactAmount &&
    descScore < 0.2 &&
    daysDiff > 3
  ) {
    return null;
  }

  let score = 100;
  score -= amountPct * 4;
  score -= daysDiff * (params.kind === 'credit_purchase' ? 1.2 : 3);
  score += descScore * 25;

  if (exactAmount) {
    score += 30;
  }
  if (!params.paid) {
    score += 12;
  }
  if (params.recurring) {
    score += 8;
  }
  if (installmentExact) {
    score += 40;
  } else if (installmentSameSeries && params.pluggyInstallmentNumber != null) {
    const installmentDelta = Math.abs(
      (params.organizzeInstallment ?? 0) - params.pluggyInstallmentNumber,
    );
    score += Math.max(0, 18 - installmentDelta * 4);
  }

  return Math.round(score * 10) / 10;
}
