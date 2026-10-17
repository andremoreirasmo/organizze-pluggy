import { remainingInstallments } from './reconciliation.types';

export type CardLendPersonInput = {
  name: string;
  amountCents: number;
};

export type CardLendInstallmentsAttributes = {
  periodicity: 'monthly';
  total: number;
};

/**
 * Remaining monthly installments to mirror from the current OF parcel
 * (same rule as create-import). Returns undefined when the purchase is
 * single-shot / already last parcel.
 */
export function cardLendInstallmentsAttributes(
  installmentNumber: number | null | undefined,
  totalInstallments: number | null | undefined,
): CardLendInstallmentsAttributes | undefined {
  const seriesTotal = remainingInstallments(
    installmentNumber,
    totalInstallments,
  );
  if (seriesTotal <= 1) {
    return undefined;
  }
  return { periodicity: 'monthly', total: seriesTotal };
}

export function cardLendSeriesTotal(
  installmentNumber: number | null | undefined,
  totalInstallments: number | null | undefined,
): number {
  const seriesTotal = remainingInstallments(
    installmentNumber,
    totalInstallments,
  );
  return seriesTotal > 1 ? seriesTotal : 1;
}

export function validateCardLendSplit(params: {
  totalCents: number;
  myAmountCents: number;
  people: CardLendPersonInput[];
}): { ok: true } | { ok: false; message: string } {
  const total = Math.abs(params.totalCents);
  if (total <= 0) {
    return { ok: false, message: 'Valor total da compra deve ser maior que zero' };
  }
  if (params.myAmountCents < 0) {
    return { ok: false, message: 'Sua parte não pode ser negativa' };
  }
  if (params.people.length === 0) {
    return {
      ok: false,
      message: 'Inclua pelo menos uma pessoa que vai pagar',
    };
  }
  let peopleSum = 0;
  for (const person of params.people) {
    const name = person.name.trim();
    if (!name) {
      return { ok: false, message: 'Informe o nome de cada pessoa' };
    }
    if (!Number.isInteger(person.amountCents) || person.amountCents <= 0) {
      return {
        ok: false,
        message: `Valor inválido para ${name || 'pessoa'}`,
      };
    }
    peopleSum += person.amountCents;
  }
  const sum = params.myAmountCents + peopleSum;
  if (Math.abs(sum - total) > 1) {
    return {
      ok: false,
      message: `A soma (${formatCents(sum)}) precisa fechar o total (${formatCents(total)})`,
    };
  }
  return { ok: true };
}

/** Default receive date: 3 days before invoice due, not before today. */
export function defaultCardLendReceiveDate(
  invoiceDueDate: string,
  todayIso?: string,
): string {
  const due = invoiceDueDate.slice(0, 10);
  const today = (todayIso ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
  const dueUtc = parseUtcDate(due);
  if (!dueUtc) {
    return today;
  }
  dueUtc.setUTCDate(dueUtc.getUTCDate() - 3);
  const candidate = dueUtc.toISOString().slice(0, 10);
  return candidate < today ? today : candidate;
}

function parseUtcDate(iso: string): Date | null {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) {
    return null;
  }
  return new Date(Date.UTC(y, m - 1, d));
}

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}
