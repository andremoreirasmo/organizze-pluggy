import type { OrganizzeTag } from './organizze.types';

export const TAG_NAME_MAX_LEN = 40;

/** Normalize user-provided tag names for Organizze create payloads. */
export function normalizeOrganizzeTagNames(
  names: string[] | null | undefined,
): OrganizzeTag[] | undefined {
  if (!names || names.length === 0) {
    return undefined;
  }
  const seen = new Set<string>();
  const tags: OrganizzeTag[] = [];
  for (const raw of names) {
    const name = raw.trim().slice(0, TAG_NAME_MAX_LEN);
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tags.push({ name });
  }
  return tags.length > 0 ? tags : undefined;
}
