import {
  estimateOpenInvoiceFromBalance,
  fixtureInstallmentTx,
  keepThroughMonthForOpenInvoice,
  sumRemainingInstallmentsAfterDue,
} from './open-invoice-of';

describe('open-invoice-of', () => {
  it('keepThroughMonthForOpenInvoice is due + 1 calendar month', () => {
    expect(keepThroughMonthForOpenInvoice('2026-11-05')).toBe('2026-12');
  });

  it('estimates open invoice from balance − remaining installments', () => {
    expect(
      estimateOpenInvoiceFromBalance({
        accountBalanceCents: 666977,
        unpaidPriorCents: 0,
        remainingInstallmentCents: 278252,
      }),
    ).toBe(388725);
  });

  it('rejects peel that would equal full card debt', () => {
    expect(
      estimateOpenInvoiceFromBalance({
        accountBalanceCents: 666977,
        unpaidPriorCents: 0,
        remainingInstallmentCents: 0,
      }),
    ).toBe(0);
  });

  it('peels installments after keepThrough month (due+1)', () => {
    // Purchase Jun 2026, maxN=4 hits Sep 2026; due+1 keepThrough=2026-12
    // peels n=8,9,10 (Jan–Mar 2027) → 3 × 364.39
    const txs = [4, 5, 6, 7].map((n) =>
      fixtureInstallmentTx({
        description: 'LOJA A 4/10',
        amount: 364.39,
        date: '2026-09-15',
        installment: n,
        totalInstallments: 10,
        purchaseDate: '2026-06-15',
      }),
    );
    const remain = sumRemainingInstallmentsAfterDue(txs, '2026-12');
    expect(remain.purchaseCount).toBe(1);
    expect(remain.totalCents).toBe(3 * 36439);
  });

  it('XP known-good band: openDue1 near R$ 3.887 (not full balance, not tx-only)', () => {
    const accountBalanceCents = 666977;
    const remainDue1Cents = 278252;
    const open = estimateOpenInvoiceFromBalance({
      accountBalanceCents,
      unpaidPriorCents: 0,
      remainingInstallmentCents: remainDue1Cents,
    });
    const xpApp = 368456;
    expect(open).toBe(388725);
    // Within ~R$250 of XP app; never the bad 4980 / 3009 extremes.
    expect(Math.abs(open - xpApp)).toBeLessThan(25_000);
    expect(open).toBeGreaterThan(350_000);
    expect(open).toBeLessThan(420_000);
  });
});
