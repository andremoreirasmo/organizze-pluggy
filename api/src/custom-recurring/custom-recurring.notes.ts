const MARKER_RE = /\[custom-recurring:([a-z0-9]+):(\d+)\]/gi;

export function buildCustomRecurringMarker(
  seriesId: string,
  index: number,
): string {
  return `[custom-recurring:${seriesId}:${index}]`;
}

export function parseCustomRecurringMarker(
  notes: string | null | undefined,
): { seriesId: string; index: number } | null {
  if (!notes) {
    return null;
  }
  const match = MARKER_RE.exec(notes);
  MARKER_RE.lastIndex = 0;
  if (!match) {
    return null;
  }
  return {
    seriesId: match[1]!,
    index: Number(match[2]),
  };
}
