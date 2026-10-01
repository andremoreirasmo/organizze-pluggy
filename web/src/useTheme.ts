import { useCallback, useEffect, useState } from 'react'
import {
  applyResolvedTheme,
  nextThemePreference,
  readThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemePreference,
  type ResolvedTheme,
} from './theme'

export function useTheme(): {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference: (next: ThemePreference) => void
  cyclePreference: () => void
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    readThemePreference(),
  )
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolveTheme(readThemePreference()),
  )

  useEffect(() => {
    const nextResolved = resolveTheme(preference)
    setResolved(nextResolved)
    applyResolvedTheme(nextResolved)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, preference)
    } catch {
      // ignore
    }
  }, [preference])

  useEffect(() => {
    if (preference !== 'system' || !window.matchMedia) {
      return
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      const nextResolved = resolveTheme('system')
      setResolved(nextResolved)
      applyResolvedTheme(nextResolved)
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [preference])

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
  }, [])

  const cyclePreference = useCallback(() => {
    setPreferenceState((current) => nextThemePreference(current))
  }, [])

  return { preference, resolved, setPreference, cyclePreference }
}
