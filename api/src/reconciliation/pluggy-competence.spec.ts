import type { Transaction } from 'pluggy-sdk';
import {
  creditLookbackDateFrom,
  isDateInInclusiveRange,
  pluggyCompetenceDate,
  pluggyReconMonthMembership,
} from './pluggy-competence';

function tx(partial: {
  date: string;
  billForecastDate?: string;
  installmentNumber?: number;
  totalInstallments?: number;
  purchaseDate?: string;
}): Transaction {
  return {
    id: 'tx-1',
    accountId: 'acc-1',
    date: new Date(`${partial.date}T12:00:00.000Z`),
    description: 'Test',
    amount: 10,
    currencyCode: 'BRL',
    creditCardMetadata: {
      billForecastDate: partial.billForecastDate,
      installmentNumber: partial.installmentNumber,
      totalInstallments: partial.totalInstallments,
      purchaseDate: partial.purchaseDate
        ? new Date(`${partial.purchaseDate}T12:00:00.000Z`)
        : undefined,
    },
  } as Transaction;
}

describe('pluggyCompetenceDate', () => {
  it('uses tx.date for single-shot purchases', () => {
    expect(pluggyCompetenceDate(tx({ date: '2026-03-10' }))).toBe(
      '2026-03-10',
    );
  });

  it('prefers billForecastDate (YYYY-MM)', () => {
    expect(
      pluggyCompetenceDate(
        tx({
          date: '2026-01-15',
          billForecastDate: '2026-03',
          installmentNumber: 3,
          totalInstallments: 12,
          purchaseDate: '2026-01-15',
        }),
      ),
    ).toBe('2026-03-01');
  });

  it('prefers billForecastDate when already YYYY-MM-DD', () => {
    expect(
      pluggyCompetenceDate(
        tx({
          date: '2026-01-15',
          billForecastDate: '2026-03-18',
        }),
      ),
    ).toBe('2026-03-18');
  });

  it('uses purchaseDate+(n-1) when forecast is missing', () => {
    expect(
      pluggyCompetenceDate(
        tx({
          date: '2026-01-15',
          installmentNumber: 3,
          totalInstallments: 12,
          purchaseDate: '2026-01-15',
        }),
      ),
    ).toBe('2026-03-15');
  });
});

describe('isDateInInclusiveRange', () => {
  it('includes competence inside the recon month', () => {
    expect(
      isDateInInclusiveRange('2026-03-15', '2026-03-01', '2026-03-31'),
    ).toBe(true);
  });

  it('excludes competence outside the recon month', () => {
    expect(
      isDateInInclusiveRange('2026-01-15', '2026-03-01', '2026-03-31'),
    ).toBe(false);
  });
});

describe('creditLookbackDateFrom', () => {
  it('shifts 24 months back', () => {
    expect(creditLookbackDateFrom('2026-03-01')).toBe('2024-03-01');
  });
});

describe('pluggyReconMonthMembership', () => {
  it('keeps in-month purchases even when billForecastDate is next month', () => {
    const row = tx({
      date: '2026-10-17',
      billForecastDate: '2026-11',
    });
    expect(
      pluggyReconMonthMembership(row, '2026-10-01', '2026-10-31'),
    ).toEqual({
      include: true,
      queueDate: '2026-10-17',
    });
  });

  it('pulls lookback installments by competence month', () => {
    const row = tx({
      date: '2026-01-15',
      billForecastDate: '2026-03',
      installmentNumber: 3,
      totalInstallments: 12,
      purchaseDate: '2026-01-15',
    });
    expect(
      pluggyReconMonthMembership(row, '2026-03-01', '2026-03-31'),
    ).toEqual({
      include: true,
      queueDate: '2026-03-01',
    });
    expect(
      pluggyReconMonthMembership(row, '2026-02-01', '2026-02-28'),
    ).toEqual({
      include: false,
      queueDate: '2026-03-01',
    });
  });
});
