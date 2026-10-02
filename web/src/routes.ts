export const ROUTES = {
  reconcile: '/conciliacao',
  balances: '/saldos',
  dashboard: '/relatorios',
  settings: '/configuracoes',
} as const

export type AppView = keyof typeof ROUTES

export type SettingsTab = 'banks' | 'accounts' | 'balances'

export type ReportSection = 'installments' | 'investments'

export type ReconciliationKindFilter =
  | ''
  | 'bank'
  | 'credit_purchase'
  | 'invoice_payment_candidate'
  | 'same_person_transfer'

const SETTINGS_TABS: SettingsTab[] = ['banks', 'accounts', 'balances']
const REPORT_SECTIONS: ReportSection[] = ['installments', 'investments']
const KINDS: ReconciliationKindFilter[] = [
  'bank',
  'credit_purchase',
  'invoice_payment_candidate',
  'same_person_transfer',
]

const MONTH_RE = /^\d{4}-\d{2}$/

/** Sentinela relativa: “sempre o mês corrente”, não um YYYY-MM fixo. */
export const CURRENT_MONTH_PARAM = 'atual'

const CURRENT_MONTH_ALIASES = new Set(['atual', 'current'])

export function viewFromPath(pathname: string): AppView {
  const normalized = pathname.replace(/\/+$/, '') || '/'
  if (normalized === ROUTES.balances) {
    return 'balances'
  }
  if (normalized === ROUTES.dashboard) {
    return 'dashboard'
  }
  if (normalized === ROUTES.settings) {
    return 'settings'
  }
  return 'reconcile'
}

export function pathForView(view: AppView): string {
  return ROUTES[view]
}

/**
 * Lê mês concreto da URL.
 * `null` = ausente, inválido ou sentinela relativa (`atual` / `current`) → usar mês corrente.
 */
export function readMonthParam(params: URLSearchParams): string | null {
  const month = params.get('month')
  if (!month || CURRENT_MONTH_ALIASES.has(month.toLowerCase())) {
    return null
  }
  return MONTH_RE.test(month) ? month : null
}

/** Resolve o YYYY-MM efetivo a partir dos search params. */
export function resolveYearMonth(
  params: URLSearchParams,
  currentYm: string,
): string {
  return readMonthParam(params) ?? currentYm
}

/** Serializa mês para a URL: mês atual → `atual`; outro → `YYYY-MM`. */
export function monthParamForUrl(
  yearMonth: string,
  currentYm: string,
): string {
  return yearMonth === currentYm ? CURRENT_MONTH_PARAM : yearMonth
}

export function searchParamsEqual(
  a: URLSearchParams,
  b: URLSearchParams,
): boolean {
  return a.toString() === b.toString()
}

export function readAccountParam(params: URLSearchParams): string | null {
  const account = params.get('account')
  return account && account.trim() ? account : null
}

export function readKindParam(
  params: URLSearchParams,
): ReconciliationKindFilter {
  const kind = params.get('kind')
  return kind && (KINDS as string[]).includes(kind)
    ? (kind as ReconciliationKindFilter)
    : ''
}

export function readQueryParam(params: URLSearchParams): string | null {
  const q = params.get('q')
  return q && q.trim() ? q : null
}

export function readSectionParam(
  params: URLSearchParams,
): ReportSection | null {
  const section = params.get('section')
  return section && (REPORT_SECTIONS as string[]).includes(section)
    ? (section as ReportSection)
    : null
}

export function readSettingsTabParam(
  params: URLSearchParams,
): SettingsTab | null {
  const tab = params.get('tab')
  return tab && (SETTINGS_TABS as string[]).includes(tab)
    ? (tab as SettingsTab)
    : null
}

/** Patch search params; omit null/empty to delete. */
export function patchSearchParams(
  current: URLSearchParams,
  patch: Record<string, string | null | undefined>,
): URLSearchParams {
  const next = new URLSearchParams(current)
  for (const [key, value] of Object.entries(patch)) {
    if (!value) {
      next.delete(key)
    } else {
      next.set(key, value)
    }
  }
  return next
}
