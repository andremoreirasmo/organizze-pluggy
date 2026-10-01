const PLUGGY_MARKER_RE = /\[pluggy:([0-9a-fA-F-]{36})\]/g;

export function buildPluggyMarker(pluggyTransactionId: string): string {
  return `[pluggy:${pluggyTransactionId}]`;
}

export function extractPluggyIds(notes: string | null | undefined): string[] {
  if (!notes) {
    return [];
  }
  const ids: string[] = [];
  for (const match of notes.matchAll(PLUGGY_MARKER_RE)) {
    ids.push(match[1]);
  }
  return ids;
}

export function notesContainPluggyId(
  notes: string | null | undefined,
  pluggyTransactionId: string,
): boolean {
  return extractPluggyIds(notes).includes(pluggyTransactionId);
}

export function appendPluggyMarker(
  notes: string | null | undefined,
  pluggyTransactionId: string,
): string {
  if (notesContainPluggyId(notes, pluggyTransactionId)) {
    return notes ?? '';
  }
  const marker = buildPluggyMarker(pluggyTransactionId);
  const base = (notes ?? '').trim();
  return base.length > 0 ? `${base}\n${marker}` : marker;
}
