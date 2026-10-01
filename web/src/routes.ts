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

export function readMonthParam(params: URLSearchParams): string | null {
  const month = params.get('month')
  return month && MONTH_RE.test(month) ? month : null
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
