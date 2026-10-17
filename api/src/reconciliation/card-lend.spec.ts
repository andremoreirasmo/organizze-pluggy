import {
  cardLendInstallmentsAttributes,
  cardLendSeriesTotal,
  defaultCardLendReceiveDate,
  validateCardLendSplit,
} from './card-lend';

describe('validateCardLendSplit', () => {
  it('accepts a balanced split including my=0', () => {
    expect(
      validateCardLendSplit({
        totalCents: 15000,
        myAmountCents: 0,
        people: [
          { name: 'Ana', amountCents: 7500 },
          { name: 'Bia', amountCents: 7500 },
        ],
      }),
    ).toEqual({ ok: true });
  });

  it('accepts the 150 / 43×3 / 10 / 11 example', () => {
    expect(
      validateCardLendSplit({
        totalCents: 15000,
        myAmountCents: 4300,
        people: [
          { name: 'A', amountCents: 4300 },
          { name: 'B', amountCents: 4300 },
          { name: 'C', amountCents: 1000 },
          { name: 'D', amountCents: 1100 },
        ],
      }),
    ).toEqual({ ok: true });
  });

  it('rejects empty people and bad sums', () => {
    expect(
      validateCardLendSplit({
        totalCents: 15000,
        myAmountCents: 15000,
        people: [],
      }).ok,
    ).toBe(false);
    expect(
      validateCardLendSplit({
        totalCents: 15000,
        myAmountCents: 5000,
        people: [{ name: 'Ana', amountCents: 5000 }],
      }).ok,
    ).toBe(false);
  });

  it('rejects blank names', () => {
    expect(
      validateCardLendSplit({
        totalCents: 1000,
        myAmountCents: 0,
        people: [{ name: '  ', amountCents: 1000 }],
      }).ok,
    ).toBe(false);
  });
});

describe('defaultCardLendReceiveDate', () => {
  it('returns 3 days before due when that is still in the future', () => {
    expect(defaultCardLendReceiveDate('2026-11-10', '2026-10-17')).toBe(
      '2026-11-07',
    );
  });

  it('clamps to today when due-3 is in the past', () => {
    expect(defaultCardLendReceiveDate('2026-10-18', '2026-10-17')).toBe(
      '2026-10-17',
    );
  });
});

describe('cardLendInstallmentsAttributes', () => {
  it('omits series for single-shot or last parcel', () => {
    expect(cardLendInstallmentsAttributes(null, null)).toBeUndefined();
    expect(cardLendInstallmentsAttributes(1, 1)).toBeUndefined();
    expect(cardLendInstallmentsAttributes(12, 12)).toBeUndefined();
    expect(cardLendSeriesTotal(1, 1)).toBe(1);
    expect(cardLendSeriesTotal(12, 12)).toBe(1);
  });

  it('mirrors remaining parcels from the current OF installment', () => {
    expect(cardLendInstallmentsAttributes(1, 12)).toEqual({
      periodicity: 'monthly',
      total: 12,
    });
    expect(cardLendInstallmentsAttributes(3, 12)).toEqual({
      periodicity: 'monthly',
      total: 10,
    });
    expect(cardLendInstallmentsAttributes(null, 6)).toEqual({
      periodicity: 'monthly',
      total: 6,
    });
    expect(cardLendSeriesTotal(3, 12)).toBe(10);
    expect(cardLendSeriesTotal(1, 6)).toBe(6);
  });
});
