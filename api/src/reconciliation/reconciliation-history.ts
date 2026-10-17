import { descriptionSimilarity } from './reconciliation.types';

export type HistoryDecisionSample = {
  decision: 'IMPORTED' | 'LINKED';
  pluggyDescription: string;
  organizzeDescription: string | null;
  categoryId: number | null;
  categoryName: string | null;
  tags: string[];
  createdAt: string;
};

export type HistorySuggestion = {
  source: 'imported' | 'linked' | 'mixed';
  confidence: number;
  occurrences: number;
  samplePluggyDescription: string;
  categoryId: number | null;
  categoryName: string | null;
  tags: string[];
  suggestedOrganizzeDescription: string | null;
  preferredOrganizzeDescription: string | null;
};

const DEFAULT_MIN_SIMILARITY = 0.55;
const STRONG_SIMILARITY = 0.85;
const HISTORY_SCORE_BONUS = 18;

type WeightedHit = {
  sample: HistoryDecisionSample;
  similarity: number;
};

function pickTopVotedString(
  votes: Map<string, number>,
): { value: string; count: number } | null {
  let best: { value: string; count: number } | null = null;
  for (const [value, count] of votes) {
    if (!best || count > best.count) {
      best = { value, count };
    }
  }
  return best;
}

function pickTopVotedCategory(
  votes: Map<number, { count: number; name: string | null }>,
): { id: number; name: string | null; count: number } | null {
  let best: { id: number; name: string | null; count: number } | null = null;
  for (const [id, entry] of votes) {
    if (!best || entry.count > best.count) {
      best = { id, name: entry.name, count: entry.count };
    }
  }
  return best;
}

/**
 * Build a create/link hint from past IMPORTED/LINKED decisions whose Pluggy
 * description is similar to the current one.
 */
export function buildHistorySuggestion(
  pluggyDescription: string,
  samples: HistoryDecisionSample[],
  options?: {
    minSimilarity?: number;
  },
): HistorySuggestion | null {
  const minSimilarity = options?.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const trimmed = pluggyDescription.trim();
  if (!trimmed || samples.length === 0) {
    return null;
  }

  const hits: WeightedHit[] = [];
  for (const sample of samples) {
    const similarity = descriptionSimilarity(
      trimmed,
      sample.pluggyDescription,
    );
    if (similarity < minSimilarity) {
      continue;
    }
    hits.push({ sample, similarity });
  }

  if (hits.length === 0) {
    return null;
  }

  hits.sort((a, b) => {
    if (b.similarity !== a.similarity) {
      return b.similarity - a.similarity;
    }
    return b.sample.createdAt.localeCompare(a.sample.createdAt);
  });

  const categoryVotes = new Map<
    number,
    { count: number; name: string | null }
  >();
  const tagVotes = new Map<string, { count: number; name: string }>();
  const organizzeDescVotes = new Map<string, number>();
  let imported = 0;
  let linked = 0;
  let similaritySum = 0;

  for (const hit of hits) {
    const weight = hit.similarity;
    similaritySum += hit.similarity;
    if (hit.sample.decision === 'IMPORTED') {
      imported += 1;
    } else {
      linked += 1;
    }

    if (hit.sample.categoryId != null) {
      const prev = categoryVotes.get(hit.sample.categoryId);
      categoryVotes.set(hit.sample.categoryId, {
        count: (prev?.count ?? 0) + weight,
        name: hit.sample.categoryName ?? prev?.name ?? null,
      });
    }

    for (const tag of hit.sample.tags) {
      const key = tag.toLowerCase();
      const prev = tagVotes.get(key);
      tagVotes.set(key, {
        count: (prev?.count ?? 0) + weight,
        name: prev?.name ?? tag,
      });
    }

    const ozDesc = hit.sample.organizzeDescription?.trim();
    if (ozDesc) {
      organizzeDescVotes.set(
        ozDesc,
        (organizzeDescVotes.get(ozDesc) ?? 0) + weight,
      );
    }
  }

  const topCategory = pickTopVotedCategory(categoryVotes);
  const topOrganizzeDesc = pickTopVotedString(organizzeDescVotes);
  const tags = [...tagVotes.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((entry) => entry.name);

  const bestSimilarity = hits[0]?.similarity ?? 0;
  const strongEnough =
    hits.length >= 2 || bestSimilarity >= STRONG_SIMILARITY;
  if (!strongEnough) {
    return null;
  }

  // Need at least one actionable signal for create or link boost.
  if (!topCategory && tags.length === 0 && !topOrganizzeDesc) {
    return null;
  }

  const avgSimilarity = similaritySum / hits.length;
  const confidence = Math.min(
    1,
    avgSimilarity * Math.min(1, Math.log1p(hits.length) / Math.log1p(4)),
  );

  const source: HistorySuggestion['source'] =
    imported > 0 && linked > 0
      ? 'mixed'
      : imported > 0
        ? 'imported'
        : 'linked';

  return {
    source,
    confidence: Math.round(confidence * 100) / 100,
    occurrences: hits.length,
    samplePluggyDescription: hits[0].sample.pluggyDescription,
    categoryId: topCategory?.id ?? null,
    categoryName: topCategory?.name ?? null,
    tags,
    suggestedOrganizzeDescription: topOrganizzeDesc?.value ?? null,
    preferredOrganizzeDescription: topOrganizzeDesc?.value ?? null,
  };
}

/** Extra score when a candidate matches the historical Organizze description. */
export function historyLinkScoreBonus(
  organizzeDescription: string,
  preferredOrganizzeDescription: string | null | undefined,
): number {
  if (!preferredOrganizzeDescription?.trim()) {
    return 0;
  }
  const similarity = descriptionSimilarity(
    organizzeDescription,
    preferredOrganizzeDescription,
  );
  if (similarity < 0.45) {
    return 0;
  }
  return Math.round(HISTORY_SCORE_BONUS * similarity);
}
