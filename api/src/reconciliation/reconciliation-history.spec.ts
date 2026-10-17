import {
  buildHistorySuggestion,
  historyLinkScoreBonus,
  type HistoryDecisionSample,
} from './reconciliation-history';

function sample(
  partial: Partial<HistoryDecisionSample> & {
    pluggyDescription: string;
  },
): HistoryDecisionSample {
  return {
    decision: 'IMPORTED',
    organizzeDescription: null,
    categoryId: null,
    categoryName: null,
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('buildHistorySuggestion', () => {
  it('returns null when there are no similar samples', () => {
    expect(
      buildHistorySuggestion('Padaria Central', [
        sample({
          pluggyDescription: 'Uber Trip',
          categoryId: 1,
          categoryName: 'Transporte',
        }),
      ]),
    ).toBeNull();
  });

  it('returns null for a single weak match', () => {
    expect(
      buildHistorySuggestion('Padaria da Esquina LTDA', [
        sample({
          pluggyDescription: 'Padaria da Praça',
          categoryId: 10,
          categoryName: 'Alimentação',
          createdAt: '2026-02-01T00:00:00.000Z',
        }),
      ]),
    ).toBeNull();
  });

  it('suggests category and tags from repeated imports', () => {
    const hint = buildHistorySuggestion('CLARO S.A.', [
      sample({
        pluggyDescription: 'CLARO S.A.',
        categoryId: 7,
        categoryName: 'Telefone',
        tags: ['casa'],
        organizzeDescription: 'Claro internet',
        createdAt: '2026-03-01T00:00:00.000Z',
      }),
      sample({
        pluggyDescription: 'Pagamento CLARO S.A.',
        categoryId: 7,
        categoryName: 'Telefone',
        tags: ['casa', 'fixo'],
        organizzeDescription: 'Claro internet',
        createdAt: '2026-04-01T00:00:00.000Z',
      }),
    ]);

    expect(hint).not.toBeNull();
    expect(hint?.categoryId).toBe(7);
    expect(hint?.categoryName).toBe('Telefone');
    expect(hint?.tags).toEqual(expect.arrayContaining(['casa']));
    expect(hint?.suggestedOrganizzeDescription).toBe('Claro internet');
    expect(hint?.occurrences).toBe(2);
    expect(hint?.source).toBe('imported');
  });

  it('accepts a single strong exact match', () => {
    const hint = buildHistorySuggestion('Spotify AB', [
      sample({
        pluggyDescription: 'Spotify AB',
        categoryId: 3,
        categoryName: 'Lazer',
        tags: ['assinatura'],
        organizzeDescription: 'Spotify',
      }),
    ]);

    expect(hint?.categoryId).toBe(3);
    expect(hint?.tags).toEqual(['assinatura']);
    expect(hint?.occurrences).toBe(1);
  });

  it('marks mixed source when imports and links both match', () => {
    const hint = buildHistorySuggestion('Netflix', [
      sample({
        decision: 'IMPORTED',
        pluggyDescription: 'Netflix.com',
        categoryId: 2,
        categoryName: 'Lazer',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      sample({
        decision: 'LINKED',
        pluggyDescription: 'Netflix',
        categoryId: 2,
        categoryName: 'Lazer',
        organizzeDescription: 'Netflix mensal',
        createdAt: '2026-02-01T00:00:00.000Z',
      }),
    ]);

    expect(hint?.source).toBe('mixed');
    expect(hint?.preferredOrganizzeDescription).toBe('Netflix mensal');
  });
});

describe('historyLinkScoreBonus', () => {
  it('returns 0 without preferred description', () => {
    expect(historyLinkScoreBonus('Claro', null)).toBe(0);
  });

  it('returns a positive bonus for similar descriptions', () => {
    expect(
      historyLinkScoreBonus('Claro internet', 'Claro internet'),
    ).toBeGreaterThan(0);
  });
});
