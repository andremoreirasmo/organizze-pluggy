export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'op-theme'

export function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return 'light'
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function readThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') {
      return raw
    }
  } catch {
    // ignore
  }
  return 'system'
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? getSystemTheme() : preference
}

export function applyResolvedTheme(resolved: ResolvedTheme): void {
  document.documentElement.setAttribute('data-theme', resolved)
  document.documentElement.style.colorScheme = resolved
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    meta.setAttribute('content', resolved === 'dark' ? '#121512' : '#129e3f')
  }
}

/** Cycle: system → light → dark → system */
export function nextThemePreference(
  current: ThemePreference,
): ThemePreference {
  if (current === 'system') {
    return 'light'
  }
  if (current === 'light') {
    return 'dark'
  }
  return 'system'
}

export function themePreferenceLabel(preference: ThemePreference): string {
  if (preference === 'light') {
    return 'Claro'
  }
  if (preference === 'dark') {
    return 'Escuro'
  }
  return 'Sistema'
}
