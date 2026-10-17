import {
  isInstallmentPurchase,
  remainingInstallments,
} from './reconciliation.types';

describe('remainingInstallments', () => {
  it('returns 0/1 for non-series totals', () => {
    expect(remainingInstallments(1, 1)).toBe(1);
    expect(remainingInstallments(null, 1)).toBe(1);
    expect(remainingInstallments(null, null)).toBe(0);
  });

  it('counts from the current parcel through the end', () => {
    expect(remainingInstallments(1, 12)).toBe(12);
    expect(remainingInstallments(3, 12)).toBe(10);
    expect(remainingInstallments(12, 12)).toBe(1);
  });

  it('treats null current as the first parcel', () => {
    expect(remainingInstallments(null, 6)).toBe(6);
    expect(remainingInstallments(undefined, 6)).toBe(6);
  });

  it('clamps when current is past total', () => {
    expect(remainingInstallments(15, 12)).toBe(1);
  });
});

describe('isInstallmentPurchase', () => {
  it('is true only when total > 1', () => {
    expect(
      isInstallmentPurchase({ installmentNumber: 1, totalInstallments: 12 }),
    ).toBe(true);
    expect(
      isInstallmentPurchase({ installmentNumber: 1, totalInstallments: 1 }),
    ).toBe(false);
  });
});
