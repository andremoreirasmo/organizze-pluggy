import { normalizeOrganizzeTagNames } from './organizze-tags';

describe('normalizeOrganizzeTagNames', () => {
  it('returns undefined for empty input', () => {
    expect(normalizeOrganizzeTagNames(undefined)).toBeUndefined();
    expect(normalizeOrganizzeTagNames([])).toBeUndefined();
    expect(normalizeOrganizzeTagNames(['  ', ''])).toBeUndefined();
  });

  it('trims, dedupes case-insensitively, and caps length', () => {
    expect(
      normalizeOrganizzeTagNames([
        '  Home ',
        'home',
        'viagem',
        `${'x'.repeat(50)}`,
      ]),
    ).toEqual([
      { name: 'Home' },
      { name: 'viagem' },
      { name: 'x'.repeat(40) },
    ]);
  });
});
