import {
  addInterval,
  generateOccurrenceDates,
  signedAmountCents,
  toIsoDateOnly,
} from './custom-recurring.dates';

describe('custom-recurring.dates', () => {
  it('adds weeks', () => {
    expect(toIsoDateOnly(addInterval(new Date('2026-01-01T00:00:00.000Z'), 5, 'WEEK'))).toBe(
      '2026-02-05',
    );
  });

  it('clamps month end', () => {
    expect(toIsoDateOnly(addInterval(new Date('2026-01-31T00:00:00.000Z'), 1, 'MONTH'))).toBe(
      '2026-02-28',
    );
  });

  it('generates every 5 weeks inclusive', () => {
    const dates = generateOccurrenceDates({
      startDateIso: '2026-01-01',
      endDateIso: '2026-04-30',
      intervalCount: 5,
      intervalUnit: 'WEEK',
    });
    expect(dates).toEqual([
      '2026-01-01',
      '2026-02-05',
      '2026-03-12',
      '2026-04-16',
    ]);
  });

  it('throws when schedule exceeds max', () => {
    expect(() =>
      generateOccurrenceDates({
        startDateIso: '2026-01-01',
        endDateIso: '2028-01-01',
        intervalCount: 1,
        intervalUnit: 'WEEK',
        maxOccurrences: 5,
      }),
    ).toThrow(/exceed 5/);
  });

  it('signs amount by kind', () => {
    expect(signedAmountCents('EXPENSE', 1990)).toBe(-1990);
    expect(signedAmountCents('INCOME', 1990)).toBe(1990);
  });
});
