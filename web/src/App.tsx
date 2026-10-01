import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import './App.css'
import { BalancesView } from './BalancesView'
import { BottomSheet } from './BottomSheet'
import { DashboardView } from './DashboardView'
import { PullToRefresh } from './PullToRefresh'
import { ReconciliationView } from './ReconciliationView'
import {
  pathForView,
  patchSearchParams,
  readSettingsTabParam,
  ROUTES,
  viewFromPath,
  type AppView,
  type SettingsTab,
} from './routes'

type OrganizzeAccount = {
  id: number
  name: string
  type: string
  archived: boolean
  institutionName?: string | null
  institutionImageUrl?: string | null
  institutionPrimaryColor?: string | null
}

type PluggyAccount = {
  id: string
  name: string
  type: string
  subtype?: string | null
  number?: string | null
  owner?: string | null
  sourceAccountId?: string
  cardNumber?: string | null
  additionalCards?: Array<{ number: string }>
  creditData?: {
    disaggregatedCreditLimits?: Array<{
      identificationNumber?: string | null
    }>
  } | null
}

type PluggyConnection = {
  id: string
  itemId: string
  customName: string | null
  displayName: string
  connectorName: string | null
  connectorImageUrl: string | null
  connectorPrimaryColor: string | null
  connectorType: string | null
  institutionName: string | null
  institutionImageUrl: string | null
  institutionPrimaryColor: string | null
  institutionCompeCode: string | null
  status: string | null
  accounts: PluggyAccount[]
}

type StoredConnection = Omit<PluggyConnection, 'accounts'>

type InstitutionOption = {
  id: number
  name: string
  imageUrl: string
  primaryColor: string | null
  type: string
  isOpenFinance: boolean
}

type AccountMap = {
  pluggyAccountId: string
  targetType: 'account' | 'credit_card' | 'ignored'
  organizzeTargetId: number
  nickname?: string | null
  cardNicknames?: Record<string, string> | null
}

type BalanceMap = {
  sourceKey: string
  sourceKind: 'account' | 'investment' | 'reserved'
  pluggySourceId: string
  organizzeAccountId: number
  nickname?: string | null
  enabled?: boolean
}

type AppSettings = {
  amountTolerancePercent: number
  dateToleranceDays: number
  accountMaps: AccountMap[]
  balanceMaps: BalanceMap[]
}

type PluggyInvestment = {
  id: string
  itemId: string
  name: string
  type: string
  subtype: string | null
  balance: number
  balanceCents: number
  amountProfit: number | null
  status: string | null
  connectionId: string | null
  connectionName: string | null
}

type OrganizzeCreditCard = {
  id: number
  name: string
  archived: boolean
}

type View = AppView

function initialVisitedViews(view: View): Record<View, boolean> {
  return {
    reconcile: true,
    balances: view === 'balances',
    dashboard: view === 'dashboard',
    settings: view === 'settings',
  }
}

type GoogleCredentialResponse = {
  credential?: string
}

type GoogleAccountsId = {
  initialize: (config: {
    client_id: string
    callback: (response: GoogleCredentialResponse) => void
    auto_select?: boolean
    cancel_on_tap_outside?: boolean
  }) => void
  renderButton: (
    parent: HTMLElement,
    options: {
      theme?: 'outline' | 'filled_blue' | 'filled_black'
      size?: 'large' | 'medium' | 'small'
      text?: 'signin_with' | 'continue_with' | 'signup_with'
      shape?: 'rectangular' | 'pill' | 'circle' | 'square'
      width?: number
      locale?: string
    },
  ) => void
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: GoogleAccountsId
      }
    }
  }
}

function loadGoogleIdentityScript(): Promise<void> {
  if (window.google?.accounts?.id) {
    return Promise.resolve()
  }
  const existing = document.querySelector<HTMLScriptElement>(
    'script[data-google-gsi="true"]',
  )
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener(
        'error',
        () => reject(new Error('Falha ao carregar Google Identity Services')),
        { once: true },
      )
    })
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.dataset.googleGsi = 'true'
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener(
      'error',
      () => reject(new Error('Falha ao carregar Google Identity Services')),
      { once: true },
    )
    document.head.appendChild(script)
  })
}

function pluggyAccountLast4(account: PluggyAccount): string | null {
  if (account.cardNumber) {
    const digits = account.cardNumber.replace(/\D/g, '')
    if (digits.length >= 4) {
      return digits.slice(-4)
    }
    return digits || null
  }
  const candidates: string[] = []
  if (account.number) {
    candidates.push(account.number)
  }
  for (const limit of account.creditData?.disaggregatedCreditLimits ?? []) {
    if (limit.identificationNumber) {
      candidates.push(limit.identificationNumber)
    }
  }
  for (const value of candidates) {
    const digits = value.replace(/\D/g, '')
    if (digits.length >= 4) {
      return digits.slice(-4)
    }
  }
  return null
}

function formatPluggyMapLabel(account: PluggyAccount): string {
  const last4 = pluggyAccountLast4(account)
  if (last4 && account.type.toUpperCase() !== 'CREDIT') {
    return `${account.name} · final ${last4}`
  }
  const ownerFirst = account.owner?.trim().split(/\s+/)[0]
  if (ownerFirst && account.type.toUpperCase() === 'CREDIT') {
    return account.name
  }
  if (last4) {
    return `${account.name} · final ${last4}`
  }
  return account.name
}

function formatPluggyKind(account: PluggyAccount): string {
  const type = account.type.toUpperCase()
  if (type === 'CREDIT') {
    return 'Cartão'
  }
  if (type === 'BANK') {
    const subtype = account.subtype?.toUpperCase() ?? ''
    if (subtype.includes('SAVINGS')) {
      return 'Poupança'
    }
    return 'Conta'
  }
  return account.type
}

type UnauthorizedHandler = () => void

let unauthorizedHandler: UnauthorizedHandler | null = null
let suppressUnauthorizedHandler = false

function setUnauthorizedHandler(handler: UnauthorizedHandler | null) {
  unauthorizedHandler = handler
}

function formatApiError(status: number, body: string): string {
  let serverMessage: string | null = null
  try {
    const parsed = JSON.parse(body) as { message?: string | string[] }
    if (typeof parsed.message === 'string') {
      serverMessage = parsed.message
    } else if (Array.isArray(parsed.message)) {
      serverMessage = parsed.message.filter(Boolean).join(', ')
    }
  } catch {
    const trimmed = body.trim()
    if (trimmed && !trimmed.startsWith('{')) {
      serverMessage = trimmed.slice(0, 200)
    }
  }

  const friendlyByMessage: Record<string, string> = {
    'This Google account is not allowed':
      'Esta conta Google não tem permissão para acessar o app.',
    'Invalid Google ID token':
      'Login Google inválido ou expirado. Tente de novo.',
    'Google account email is not verified':
      'Confirme o e-mail da conta Google e tente de novo.',
    'Missing Google ID token':
      'Não foi possível obter a credencial do Google.',
    'Authentication required': 'Sessão expirada. Entre novamente.',
    'Missing Origin or Referer': 'Requisição bloqueada (origem inválida).',
    'Invalid request origin': 'Requisição bloqueada (origem inválida).',
  }

  if (serverMessage && friendlyByMessage[serverMessage]) {
    return friendlyByMessage[serverMessage]
  }
  if (serverMessage) {
    return serverMessage
  }
  if (status === 401) {
    return 'Sessão expirada. Entre novamente.'
  }
  if (status === 403) {
    return 'Acesso negado.'
  }
  if (status === 429) {
    return 'Muitas tentativas. Aguarde um momento e tente de novo.'
  }
  return `Erro ${status}. Tente novamente.`
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })

  if (!response.ok) {
    if (
      response.status === 401 &&
      !path.startsWith('/api/auth/') &&
      !suppressUnauthorizedHandler
    ) {
      unauthorizedHandler?.()
    }
    const text = await response.text()
    throw new Error(formatApiError(response.status, text))
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

function bankImage(connection: {
  institutionImageUrl: string | null
  connectorImageUrl: string | null
  connectorName: string | null
}): string | null {
  // MeuPluggy always returns a generic sandbox icon — prefer institution logo
  if (
    connection.connectorName === 'MeuPluggy' ||
    connection.connectorImageUrl?.includes('sandbox.svg')
  ) {
    return connection.institutionImageUrl
  }
  return connection.institutionImageUrl || connection.connectorImageUrl
}

function bankColor(connection: {
  institutionPrimaryColor: string | null
  connectorPrimaryColor: string | null
  connectorName: string | null
}): string | null {
  if (connection.connectorName === 'MeuPluggy') {
    return connection.institutionPrimaryColor
  }
  return connection.institutionPrimaryColor || connection.connectorPrimaryColor
}

function BankAvatar({
  name,
  imageUrl,
  color,
}: {
  name: string
  imageUrl: string | null
  color: string | null
}) {
  if (imageUrl) {
    return (
      <img
        className="bank-avatar"
        src={imageUrl}
        alt={name}
        width={40}
        height={40}
      />
    )
  }

  return (
    <div
      className="account-icon pluggy"
      style={color ? { background: `${color}22`, color } : undefined}
    >
      {initials(name)}
    </div>
  )
}

function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const view = viewFromPath(location.pathname)
  const settingsSection =
    readSettingsTabParam(searchParams) ?? ('banks' as SettingsTab)

  const [sessionEmail, setSessionEmail] = useState<string | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [googleClientId, setGoogleClientId] = useState<string | null>(null)
  const [googleButtonHost, setGoogleButtonHost] =
    useState<HTMLDivElement | null>(null)
  const [authenticated, setAuthenticated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [organizzeAccounts, setOrganizzeAccounts] = useState<
    OrganizzeAccount[]
  >([])
  const [pluggyConnections, setPluggyConnections] = useState<
    PluggyConnection[]
  >([])
  const [configConnections, setConfigConnections] = useState<StoredConnection[]>(
    [],
  )
  const [newItemId, setNewItemId] = useState('')
  const [newCustomName, setNewCustomName] = useState('')
  const [institutions, setInstitutions] = useState<InstitutionOption[]>([])
  const [institutionQuery, setInstitutionQuery] = useState('')
  const [selectedInstitution, setSelectedInstitution] =
    useState<InstitutionOption | null>(null)
  const [iconPickerForId, setIconPickerForId] = useState<string | null>(null)
  const [addConnectionOpen, setAddConnectionOpen] = useState(false)
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [expandedMapChildren, setExpandedMapChildren] = useState<
    Record<string, boolean>
  >({})
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  const [organizzeCreditCards, setOrganizzeCreditCards] = useState<
    OrganizzeCreditCard[]
  >([])
  const [pluggyInvestments, setPluggyInvestments] = useState<
    PluggyInvestment[]
  >([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [visitedViews, setVisitedViews] = useState<Record<View, boolean>>(() =>
    initialVisitedViews(viewFromPath(window.location.pathname)),
  )
  const scrollByViewRef = useRef<Record<View, number>>({
    reconcile: 0,
    balances: 0,
    dashboard: 0,
    settings: 0,
  })
  const previousViewRef = useRef<View>(view)

  useEffect(() => {
    setVisitedViews((current) =>
      current[view] ? current : { ...current, [view]: true },
    )
  }, [view])

  useEffect(() => {
    const previous = previousViewRef.current
    if (previous !== view) {
      scrollByViewRef.current[previous] = window.scrollY
      previousViewRef.current = view
      window.scrollTo(0, scrollByViewRef.current[view] ?? 0)
    }
  }, [view])

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAuthenticated((wasAuthenticated) => {
        if (wasAuthenticated) {
          setError('Sessão expirada. Entre novamente.')
        }
        return false
      })
      setSessionEmail(null)
      setOrganizzeAccounts([])
      setPluggyConnections([])
      setConfigConnections([])
      setAppSettings(null)
      setVisitedViews({
        reconcile: true,
        balances: false,
        dashboard: false,
        settings: false,
      })
      navigate(ROUTES.reconcile, { replace: true })
    })
    return () => setUnauthorizedHandler(null)
  }, [navigate])

  const flatPluggyAccounts = useMemo(
    () =>
      pluggyConnections.flatMap((connection) =>
        connection.accounts.map((account) => ({
          ...account,
          connectionName: connection.displayName,
        })),
      ),
    [pluggyConnections],
  )

  const settingsStats = useMemo(() => {
    const maps = appSettings?.accountMaps ?? []
    const mapped = flatPluggyAccounts.filter((account) => {
      const map = maps.find((item) => item.pluggyAccountId === account.id)
      return map && map.targetType !== 'ignored'
    }).length
    const ignored = flatPluggyAccounts.filter((account) => {
      const map = maps.find((item) => item.pluggyAccountId === account.id)
      return map?.targetType === 'ignored'
    }).length
    const pending = Math.max(0, flatPluggyAccounts.length - mapped - ignored)
    return {
      banks: configConnections.length,
      mapped,
      pending,
      investments: pluggyInvestments.length,
    }
  }, [
    appSettings,
    flatPluggyAccounts,
    configConnections.length,
    pluggyInvestments.length,
  ])

  const renameTarget = useMemo(
    () =>
      renameTargetId
        ? (configConnections.find((item) => item.id === renameTargetId) ?? null)
        : null,
    [configConnections, renameTargetId],
  )

  const iconPickerTarget = useMemo(
    () =>
      iconPickerForId
        ? (configConnections.find((item) => item.id === iconPickerForId) ??
          null)
        : null,
    [configConnections, iconPickerForId],
  )

  const loadHomeData = useCallback(async () => {
    const [accounts, pluggy] = await Promise.all([
      apiFetch<OrganizzeAccount[]>('/api/organizze/accounts'),
      apiFetch<{ connections: PluggyConnection[] }>('/api/pluggy/connections'),
    ])
    setOrganizzeAccounts(accounts)
    setPluggyConnections(pluggy.connections)
  }, [])

  const loadConfig = useCallback(async () => {
    const rows = await apiFetch<StoredConnection[]>(
      '/api/pluggy/connections/config',
    )
    setConfigConnections(rows)
  }, [])

  const loadInstitutions = useCallback(async (query?: string) => {
    const path = query?.trim()
      ? `/api/pluggy/institutions?q=${encodeURIComponent(query.trim())}`
      : '/api/pluggy/institutions'
    const rows = await apiFetch<InstitutionOption[]>(path)
    setInstitutions(rows)
  }, [])

  const enterAuthenticatedSession = useCallback(
    async (email: string) => {
      setSessionEmail(email)
      await loadHomeData()
      setAuthenticated(true)
      const nextView = viewFromPath(window.location.pathname)
      setVisitedViews((current) =>
        current[nextView] ? current : { ...current, [nextView]: true },
      )
      if (
        window.location.pathname === '/' ||
        window.location.pathname === ''
      ) {
        navigate(ROUTES.reconcile, { replace: true })
      }
    },
    [loadHomeData, navigate],
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const config = await apiFetch<{ googleClientId: string }>(
          '/api/auth/config',
        )
        if (cancelled) {
          return
        }
        setGoogleClientId(config.googleClientId)
        try {
          const me = await apiFetch<{ email: string | null }>('/api/auth/me')
          if (cancelled) {
            return
          }
          if (me.email) {
            await enterAuthenticatedSession(me.email)
          }
        } catch {
          // No session yet — stay on login.
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : 'Não foi possível carregar a autenticação',
          )
        }
      } finally {
        if (!cancelled) {
          setAuthReady(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enterAuthenticatedSession])

  const handleGoogleCredential = useCallback(
    async (response: GoogleCredentialResponse) => {
      if (!response.credential) {
        setError('Google não retornou credencial')
        return
      }
      setError(null)
      setLoading(true)
      try {
        const session = await apiFetch<{ email: string }>('/api/auth/google', {
          method: 'POST',
          body: JSON.stringify({ idToken: response.credential }),
        })
        await enterAuthenticatedSession(session.email)
      } catch (err) {
        setAuthenticated(false)
        setSessionEmail(null)
        setError(err instanceof Error ? err.message : 'Falha no login Google')
      } finally {
        setLoading(false)
      }
    },
    [enterAuthenticatedSession],
  )

  useEffect(() => {
    if (authenticated || !authReady || !googleClientId || !googleButtonHost) {
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        await loadGoogleIdentityScript()
        if (cancelled || !window.google?.accounts?.id) {
          return
        }
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: (response) => {
            void handleGoogleCredential(response)
          },
          auto_select: false,
          cancel_on_tap_outside: true,
        })
        googleButtonHost.innerHTML = ''
        window.google.accounts.id.renderButton(googleButtonHost, {
          theme: 'outline',
          size: 'large',
          text: 'signin_with',
          shape: 'rectangular',
          width: 320,
          locale: 'pt-BR',
        })
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : 'Falha ao iniciar login Google',
          )
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    authenticated,
    authReady,
    googleClientId,
    googleButtonHost,
    handleGoogleCredential,
  ])

  useEffect(() => {
    if (!authenticated || view !== 'settings') {
      return
    }

    const handle = window.setTimeout(() => {
      void loadInstitutions(institutionQuery).catch((err) => {
        setError(
          err instanceof Error ? err.message : 'Erro ao buscar ícones',
        )
      })
    }, 300)

    return () => window.clearTimeout(handle)
  }, [authenticated, view, institutionQuery, loadInstitutions])

  const loadSettingsData = useCallback(async () => {
    const [, , settings, cards, investments] = await Promise.all([
      loadConfig(),
      loadInstitutions(),
      apiFetch<AppSettings>('/api/settings'),
      apiFetch<OrganizzeCreditCard[]>('/api/organizze/credit-cards'),
      apiFetch<PluggyInvestment[]>('/api/pluggy/investments'),
      loadHomeData(),
    ])
    setOrganizzeCreditCards(cards)
    setAppSettings(settings)
    setPluggyInvestments(investments)
  }, [loadConfig, loadInstitutions, loadHomeData])

  const navigateToView = useCallback(
    (next: View) => {
      setError(null)
      navigate(pathForView(next))
    },
    [navigate],
  )

  const openSettings = useCallback(async () => {
    navigateToView('settings')
    if (appSettings) {
      return
    }
    setLoading(true)
    try {
      await loadSettingsData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar config')
    } finally {
      setLoading(false)
    }
  }, [appSettings, loadSettingsData, navigateToView])

  const refreshSettings = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      await loadSettingsData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar config')
      throw err
    } finally {
      setLoading(false)
    }
  }, [loadSettingsData])

  useEffect(() => {
    if (!authenticated || view !== 'settings' || appSettings) {
      return
    }
    let cancelled = false
    setLoading(true)
    void loadSettingsData()
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Erro ao carregar config',
          )
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [authenticated, view, appSettings, loadSettingsData])

  const openBalances = useCallback(() => {
    navigateToView('balances')
  }, [navigateToView])

  const openDashboard = useCallback(() => {
    navigateToView('dashboard')
  }, [navigateToView])

  const openReconcile = useCallback(() => {
    navigateToView('reconcile')
  }, [navigateToView])

  const authenticatedFetch = useCallback(
    <T,>(path: string, init?: RequestInit) => apiFetch<T>(path, init),
    [],
  )

  const saveAccountMap = useCallback(
    async (
      pluggyAccountId: string,
      targetType: 'account' | 'credit_card' | 'ignored' | '',
      organizzeTargetId: number | '',
      nickname?: string | null,
      cardNicknames?: Record<string, string> | null,
    ) => {
      if (!appSettings) {
        return
      }
      setError(null)
      setSaving(true)
      try {
        const existing = appSettings.accountMaps.find(
          (map) => map.pluggyAccountId === pluggyAccountId,
        )
        const nextNickname =
          nickname !== undefined
            ? nickname?.trim()
              ? nickname.trim().slice(0, 40)
              : null
            : (existing?.nickname ?? null)
        const nextCardNicknames =
          cardNicknames !== undefined
            ? cardNicknames
            : (existing?.cardNicknames ?? null)
        const nextMaps = appSettings.accountMaps.filter(
          (map) => map.pluggyAccountId !== pluggyAccountId,
        )
        if (targetType === 'ignored') {
          nextMaps.push({
            pluggyAccountId,
            targetType: 'ignored',
            organizzeTargetId: 0,
            nickname: nextNickname,
            cardNicknames: nextCardNicknames,
          })
        } else if (targetType && organizzeTargetId !== '') {
          nextMaps.push({
            pluggyAccountId,
            targetType,
            organizzeTargetId: Number(organizzeTargetId),
            nickname: nextNickname,
            cardNicknames: nextCardNicknames,
          })
        }
        const updated = await apiFetch<AppSettings>('/api/settings', {
          method: 'PUT',
          body: JSON.stringify({ accountMaps: nextMaps }),
        })
        setAppSettings(updated)
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Erro ao salvar mapeamento',
        )
      } finally {
        setSaving(false)
      }
    },
    [appSettings],
  )

  const saveBalanceMap = useCallback(
    async (
      investmentId: string,
      organizzeAccountId: number | '',
      nickname?: string | null,
      enabled: boolean = true,
    ) => {
      if (!appSettings) {
        return
      }
      setError(null)
      setSaving(true)
      try {
        const sourceKey = `investment:${investmentId}`
        const existing = appSettings.balanceMaps.find(
          (map) => map.sourceKey === sourceKey,
        )
        const nextNickname =
          nickname !== undefined
            ? nickname?.trim()
              ? nickname.trim().slice(0, 40)
              : null
            : (existing?.nickname ?? null)
        const nextMaps = appSettings.balanceMaps.filter(
          (map) => map.sourceKey !== sourceKey,
        )
        if (organizzeAccountId !== '') {
          nextMaps.push({
            sourceKey,
            sourceKind: 'investment',
            pluggySourceId: investmentId,
            organizzeAccountId: Number(organizzeAccountId),
            nickname: nextNickname,
            enabled,
          })
        } else if (!enabled) {
          // Exclude from auto-sum even without an explicit target: keep disabled
          // map on first inferred/default account if we had one before.
          const fallbackId = existing?.organizzeAccountId
          if (fallbackId) {
            nextMaps.push({
              sourceKey,
              sourceKind: 'investment',
              pluggySourceId: investmentId,
              organizzeAccountId: fallbackId,
              nickname: nextNickname,
              enabled: false,
            })
          }
        }
        const updated = await apiFetch<AppSettings>('/api/settings', {
          method: 'PUT',
          body: JSON.stringify({ balanceMaps: nextMaps }),
        })
        setAppSettings(updated)
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Erro ao salvar mapeamento de saldo',
        )
      } finally {
        setSaving(false)
      }
    },
    [appSettings],
  )

  const setInvestmentIncluded = useCallback(
    async (
      investment: PluggyInvestment,
      included: boolean,
      inferredOrganizzeAccountId: number | null,
    ) => {
      if (!appSettings) {
        return
      }
      const sourceKey = `investment:${investment.id}`
      const existing = appSettings.balanceMaps.find(
        (map) => map.sourceKey === sourceKey,
      )
      const organizzeAccountId =
        existing?.organizzeAccountId ?? inferredOrganizzeAccountId
      if (!included) {
        if (!organizzeAccountId) {
          setError(
            'Selecione a conta Organizze antes de desmarcar este investment.',
          )
          return
        }
        await saveBalanceMap(
          investment.id,
          organizzeAccountId,
          undefined,
          false,
        )
        return
      }
      if (existing?.enabled === false && organizzeAccountId) {
        await saveBalanceMap(investment.id, organizzeAccountId, undefined, true)
      }
    },
    [appSettings, saveBalanceMap],
  )

  const inferOrganizzeAccountForInvestment = useCallback(
    (investment: PluggyInvestment): number | null => {
      if (!appSettings) {
        return null
      }
      const existing = appSettings.balanceMaps.find(
        (map) => map.sourceKey === `investment:${investment.id}`,
      )
      if (existing?.organizzeAccountId) {
        return existing.organizzeAccountId
      }
      const connection = pluggyConnections.find(
        (entry) =>
          entry.id === investment.connectionId ||
          entry.itemId === investment.itemId,
      )
      if (!connection) {
        return null
      }
      const ozIds = new Set<number>()
      for (const account of connection.accounts) {
        if ((account.type ?? '').toUpperCase() === 'CREDIT') {
          continue
        }
        const map = appSettings.accountMaps.find(
          (entry) =>
            entry.pluggyAccountId === account.id &&
            entry.targetType === 'account',
        )
        if (map) {
          ozIds.add(map.organizzeTargetId)
        }
      }
      if (ozIds.size === 1) {
        return [...ozIds][0]
      }
      return null
    },
    [appSettings, pluggyConnections],
  )

  const saveAccountNickname = useCallback(
    async (pluggyAccountId: string, nickname: string) => {
      if (!appSettings) {
        return
      }
      const current = appSettings.accountMaps.find(
        (map) => map.pluggyAccountId === pluggyAccountId,
      )
      if (!current) {
        return
      }
      const next = nickname.trim().slice(0, 40)
      const previous = current.nickname ?? ''
      if (next === previous) {
        return
      }
      await saveAccountMap(
        pluggyAccountId,
        current.targetType,
        current.targetType === 'ignored' ? 0 : current.organizzeTargetId,
        next || null,
      )
    },
    [appSettings, saveAccountMap],
  )

  const saveCardNickname = useCallback(
    async (pluggyAccountId: string, cardNumber: string, nickname: string) => {
      if (!appSettings) {
        return
      }
      const current = appSettings.accountMaps.find(
        (map) => map.pluggyAccountId === pluggyAccountId,
      )
      if (!current) {
        return
      }
      const digits = cardNumber.replace(/\D/g, '')
      const last4 =
        digits.length >= 4 ? digits.slice(-4) : digits || null
      if (!last4) {
        return
      }
      const next = nickname.trim().slice(0, 40)
      const previous = current.cardNicknames?.[last4] ?? ''
      if (next === previous) {
        return
      }
      const nextCardNicknames: Record<string, string> = {
        ...(current.cardNicknames ?? {}),
      }
      if (next) {
        nextCardNicknames[last4] = next
      } else {
        delete nextCardNicknames[last4]
      }
      await saveAccountMap(
        pluggyAccountId,
        current.targetType,
        current.targetType === 'ignored' ? 0 : current.organizzeTargetId,
        current.nickname ?? null,
        Object.keys(nextCardNicknames).length > 0 ? nextCardNicknames : null,
      )
    },
    [appSettings, saveAccountMap],
  )

  const selectSettingsSection = useCallback(
    (tab: SettingsTab) => {
      setSearchParams(
        (current) =>
          patchSearchParams(current, {
            tab: tab === 'banks' ? null : tab,
          }),
        { replace: false },
      )
    },
    [setSearchParams],
  )

  const addConnection = useCallback(async () => {
    if (!newItemId.trim()) {
      setError('Informe o itemId do banco no Pluggy')
      return
    }
    if (!selectedInstitution) {
      setError('Selecione o ícone do banco')
      return
    }

    setError(null)
    setSaving(true)
    try {
      await apiFetch('/api/pluggy/connections', {
        method: 'POST',
        body: JSON.stringify({
          itemId: newItemId.trim(),
          customName: newCustomName.trim() || undefined,
          institutionName: selectedInstitution.name,
          institutionImageUrl: selectedInstitution.imageUrl,
          institutionPrimaryColor:
            selectedInstitution.primaryColor ?? undefined,
        }),
      })
      setNewItemId('')
      setNewCustomName('')
      setSelectedInstitution(null)
      setAddConnectionOpen(false)
      await loadConfig()
      await loadHomeData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao adicionar banco')
    } finally {
      setSaving(false)
    }
  }, [
    newItemId,
    newCustomName,
    selectedInstitution,
    loadConfig,
    loadHomeData,
  ])

  const renameConnection = useCallback(
    async (id: string, customName: string) => {
      setError(null)
      setSaving(true)
      try {
        await apiFetch(`/api/pluggy/connections/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ customName: customName.trim() || null }),
        })
        setRenameTargetId(null)
        setRenameValue('')
        await loadConfig()
        await loadHomeData()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Erro ao renomear')
      } finally {
        setSaving(false)
      }
    },
    [loadConfig, loadHomeData],
  )

  const updateConnectionIcon = useCallback(
    async (id: string, institution: InstitutionOption) => {
      setError(null)
      setSaving(true)
      try {
        await apiFetch(`/api/pluggy/connections/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            institutionName: institution.name,
            institutionImageUrl: institution.imageUrl,
            institutionPrimaryColor: institution.primaryColor,
          }),
        })
        setIconPickerForId(null)
        await loadConfig()
        await loadHomeData()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Erro ao trocar ícone')
      } finally {
        setSaving(false)
      }
    },
    [loadConfig, loadHomeData],
  )

  const deleteConnection = useCallback(
    async (id: string, name: string) => {
      if (!window.confirm(`Remover a conexão “${name}”?`)) {
        return
      }
      setError(null)
      try {
        await apiFetch(`/api/pluggy/connections/${id}`, {
          method: 'DELETE',
        })
        await loadConfig()
        await loadHomeData()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Erro ao remover')
      }
    },
    [loadConfig, loadHomeData],
  )

  const logout = useCallback(async () => {
    suppressUnauthorizedHandler = true
    setError(null)
    try {
      await apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST' })
    } catch {
      // Clear local state even if logout request fails.
    }
    setSessionEmail(null)
    setAuthenticated(false)
    setOrganizzeAccounts([])
    setPluggyConnections([])
    setConfigConnections([])
    setAppSettings(null)
    setVisitedViews({
      reconcile: true,
      balances: false,
      dashboard: false,
      settings: false,
    })
    setError(null)
    navigate(ROUTES.reconcile, { replace: true })
    window.setTimeout(() => {
      suppressUnauthorizedHandler = false
    }, 1000)
  }, [navigate])

  if (!authReady) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="brand">
            <div className="brand-mark" aria-hidden>
              o
            </div>
            <div className="brand-text">
              <strong>organizze</strong>
              <span>conexão pluggy</span>
            </div>
          </div>
          <h1>Carregando…</h1>
          <p className="subtitle">Verificando sessão.</p>
        </div>
      </div>
    )
  }

  if (!authenticated) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="brand">
            <div className="brand-mark" aria-hidden>
              o
            </div>
            <div className="brand-text">
              <strong>organizze</strong>
              <span>conexão pluggy</span>
            </div>
          </div>
          <h1>Acesse sua conta</h1>
          <p className="subtitle">
            Entre com Google. Só e-mails autorizados podem usar o app.
          </p>
          <div className="login-form">
            <div
              className="google-signin"
              ref={setGoogleButtonHost}
              aria-label="Entrar com Google"
            />
            {loading ? <p className="login-status">Entrando…</p> : null}
            {error ? <p className="error">{error}</p> : null}
          </div>
        </div>
      </div>
    )
  }

  if (
    location.pathname === '/' ||
    location.pathname === ''
  ) {
    return <Navigate to={ROUTES.reconcile} replace />
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            o
          </div>
          <div className="brand-text">
            <strong>organizze</strong>
            <span>↔ pluggy · conciliação</span>
          </div>
        </div>
        <nav className="topbar-nav" aria-label="Navegação principal">
          <button
            type="button"
            className={`btn ghost ${view === 'reconcile' ? 'active-nav' : ''}`}
            onClick={openReconcile}
          >
            <span className="nav-label-full">Conciliação</span>
            <span className="nav-label-short">Fila</span>
          </button>
          <button
            type="button"
            className={`btn ghost ${view === 'balances' ? 'active-nav' : ''}`}
            onClick={openBalances}
          >
            <span className="nav-label-full">Saldos</span>
            <span className="nav-label-short">Saldos</span>
          </button>
          <button
            type="button"
            className={`btn ghost ${view === 'dashboard' ? 'active-nav' : ''}`}
            onClick={openDashboard}
          >
            <span className="nav-label-full">Relatórios</span>
            <span className="nav-label-short">Relat.</span>
          </button>
          <button
            type="button"
            className={`btn ghost ${view === 'settings' ? 'active-nav' : ''}`}
            onClick={() => void openSettings()}
          >
            <span className="nav-label-full">Configurações</span>
            <span className="nav-label-short">Config</span>
          </button>
        </nav>
        <button
          type="button"
          className="btn ghost topbar-logout"
          onClick={() => void logout()}
        >
          <span className="nav-logout-full">
            Sair{sessionEmail ? ` · ${sessionEmail.split('@')[0]}` : ''}
          </span>
          <span className="nav-logout-short">Sair</span>
        </button>
      </header>

      <main className="content">
        {error ? <p className="error-banner">{error}</p> : null}

        {visitedViews.reconcile ? (
          <div
            className="view-pane"
            hidden={view !== 'reconcile'}
            aria-hidden={view !== 'reconcile'}
          >
            <ReconciliationView
              apiFetch={authenticatedFetch}
              onError={setError}
            />
          </div>
        ) : null}

        {visitedViews.balances ? (
          <div
            className="view-pane"
            hidden={view !== 'balances'}
            aria-hidden={view !== 'balances'}
          >
            <BalancesView apiFetch={authenticatedFetch} onError={setError} />
          </div>
        ) : null}

        {visitedViews.dashboard ? (
          <div
            className="view-pane"
            hidden={view !== 'dashboard'}
            aria-hidden={view !== 'dashboard'}
          >
            <DashboardView apiFetch={authenticatedFetch} onError={setError} />
          </div>
        ) : null}

        {visitedViews.settings ? (
          <div
            className="view-pane"
            hidden={view !== 'settings'}
            aria-hidden={view !== 'settings'}
          >
          <PullToRefresh
            onRefresh={refreshSettings}
            disabled={loading || saving}
          >
          <section className="settings settings-shell">
            <header className="settings-header">
              <div className="settings-header-top">
                <h1>Configurações</h1>
                <button
                  type="button"
                  className="reports-refresh"
                  disabled={loading || saving}
                  onClick={() => void refreshSettings()}
                >
                  {loading ? 'Atualizando…' : 'Atualizar'}
                </button>
                {settingsSection === 'banks' ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={loading || saving}
                    onClick={() => {
                      setError(null)
                      setNewItemId('')
                      setNewCustomName('')
                      setSelectedInstitution(null)
                      setInstitutionQuery('')
                      setAddConnectionOpen(true)
                    }}
                  >
                    Adicionar
                  </button>
                ) : null}
              </div>
              <p className="settings-header-copy">
                Conexões Pluggy, mapeamento Organizze e fontes de saldo.
              </p>
              <div
                className="reports-tabs settings-tabs"
                role="tablist"
                aria-label="Seção de configurações"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={settingsSection === 'banks'}
                  className={settingsSection === 'banks' ? 'active' : ''}
                  onClick={() => selectSettingsSection('banks')}
                >
                  Bancos
                  <span className="settings-tab-count">{settingsStats.banks}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={settingsSection === 'accounts'}
                  className={settingsSection === 'accounts' ? 'active' : ''}
                  onClick={() => selectSettingsSection('accounts')}
                >
                  Contas
                  {settingsStats.pending > 0 ? (
                    <span className="settings-tab-count is-warn">
                      {settingsStats.pending}
                    </span>
                  ) : (
                    <span className="settings-tab-count">
                      {settingsStats.mapped}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={settingsSection === 'balances'}
                  className={settingsSection === 'balances' ? 'active' : ''}
                  onClick={() => selectSettingsSection('balances')}
                >
                  Saldos
                  <span className="settings-tab-count">
                    {settingsStats.investments}
                  </span>
                </button>
              </div>
            </header>

            <div className="settings-body">
            {settingsSection === 'banks' ? (
            <article className="panel settings-panel">
              <div className="panel-head">
                <div>
                  <h2>Bancos salvos</h2>
                  <p>
                    {settingsStats.banks === 0
                      ? 'Nenhuma conexão ainda'
                      : `${settingsStats.banks} conexão(ões) Pluggy`}
                  </p>
                </div>
              </div>
              <div className="panel-body">
                {configConnections.length === 0 ? (
                  <div className="empty">
                    <strong>Nenhum banco</strong>
                    <p>
                      Toque em Adicionar para cadastrar o itemId do MeuPluggy.
                    </p>
                  </div>
                ) : (
                  <ul className="settings-card-list">
                    {configConnections.map((connection) => (
                      <li key={connection.id} className="settings-card">
                        <div className="settings-card-head">
                          <BankAvatar
                            name={connection.displayName}
                            imageUrl={bankImage(connection)}
                            color={bankColor(connection)}
                          />
                          <div className="settings-card-meta">
                            <strong>{connection.displayName}</strong>
                            <span>
                              {connection.institutionName
                                ? connection.institutionName
                                : 'Sem ícone selecionado'}
                            </span>
                            <span className="mono">{connection.itemId}</span>
                          </div>
                          <span
                            className={`badge ${connection.institutionImageUrl ? 'kind-bank' : 'kind-invoice'}`}
                          >
                            {connection.institutionImageUrl
                              ? 'Pronto'
                              : 'Sem ícone'}
                          </span>
                        </div>
                        <div className="settings-card-actions">
                          <button
                            type="button"
                            className="btn ghost"
                            disabled={saving}
                            onClick={() => {
                              setRenameTargetId(connection.id)
                              setRenameValue(connection.customName ?? '')
                            }}
                          >
                            Renomear
                          </button>
                          <button
                            type="button"
                            className="btn ghost"
                            disabled={saving}
                            onClick={() => {
                              setInstitutionQuery('')
                              setIconPickerForId(connection.id)
                            }}
                          >
                            Ícone
                          </button>
                          <button
                            type="button"
                            className="btn danger"
                            disabled={saving}
                            onClick={() =>
                              void deleteConnection(
                                connection.id,
                                connection.displayName,
                              )
                            }
                          >
                            Excluir
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </article>
            ) : null}

            {addConnectionOpen ? (
              <BottomSheet
                onClose={() => {
                  if (!saving) {
                    setAddConnectionOpen(false)
                  }
                }}
                busy={saving}
                labelledBy="add-connection-title"
                title="Adicionar conexão"
                subtitle="Cole o itemId do dashboard Pluggy e selecione o ícone"
              >
                <div className="settings-form modal-body">
                  <label>
                    Item ID
                    <input
                      value={newItemId}
                      onChange={(event) => setNewItemId(event.target.value)}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      autoFocus
                    />
                  </label>
                  <label>
                    Apelido (opcional)
                    <input
                      value={newCustomName}
                      onChange={(event) =>
                        setNewCustomName(event.target.value)
                      }
                      placeholder="Ex.: Nubank pessoal"
                    />
                  </label>

                  <div className="icon-picker">
                    <div className="icon-picker-head">
                      <strong>Ícone do banco</strong>
                      {selectedInstitution ? (
                        <span>Selecionado: {selectedInstitution.name}</span>
                      ) : (
                        <span>Selecione um ícone abaixo</span>
                      )}
                    </div>
                    <input
                      className="icon-search"
                      value={institutionQuery}
                      onChange={(event) =>
                        setInstitutionQuery(event.target.value)
                      }
                      placeholder="Buscar banco (Nubank, XP, Itaú…)"
                    />
                    <div className="icon-grid">
                      {institutions.map((institution) => {
                        const selected =
                          selectedInstitution?.id === institution.id
                        return (
                          <button
                            key={institution.id}
                            type="button"
                            className={`icon-option ${selected ? 'selected' : ''}`}
                            title={institution.name}
                            onClick={() =>
                              setSelectedInstitution(institution)
                            }
                          >
                            <img
                              src={institution.imageUrl}
                              alt={institution.name}
                              width={40}
                              height={40}
                            />
                            <span>{institution.name}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div className="modal-actions">
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={saving}
                      onClick={() => setAddConnectionOpen(false)}
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void addConnection()}
                      disabled={saving || !selectedInstitution}
                    >
                      {saving ? 'Salvando…' : 'Adicionar banco'}
                    </button>
                  </div>
                </div>
              </BottomSheet>
            ) : null}

            {renameTarget ? (
              <BottomSheet
                onClose={() => {
                  if (!saving) {
                    setRenameTargetId(null)
                    setRenameValue('')
                  }
                }}
                busy={saving}
                labelledBy="rename-connection-title"
                title="Renomear banco"
                subtitle={`Apelido para ${renameTarget.displayName}. Deixe vazio para usar o nome padrão.`}
              >
                <div className="settings-form modal-body">
                  <label>
                    Apelido
                    <input
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      placeholder="Ex.: Nubank pessoal"
                      maxLength={40}
                      autoFocus
                    />
                  </label>
                  <div className="modal-actions">
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={saving}
                      onClick={() => {
                        setRenameTargetId(null)
                        setRenameValue('')
                      }}
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={saving}
                      onClick={() =>
                        void renameConnection(renameTarget.id, renameValue)
                      }
                    >
                      {saving ? 'Salvando…' : 'Salvar'}
                    </button>
                  </div>
                </div>
              </BottomSheet>
            ) : null}

            {iconPickerTarget ? (
              <BottomSheet
                onClose={() => {
                  if (!saving) {
                    setIconPickerForId(null)
                  }
                }}
                busy={saving}
                labelledBy="icon-picker-title"
                title="Trocar ícone"
                subtitle={`Escolha o banco para ${iconPickerTarget.displayName}`}
              >
                <div className="settings-form modal-body">
                  <div className="icon-picker">
                    <input
                      className="icon-search"
                      value={institutionQuery}
                      onChange={(event) =>
                        setInstitutionQuery(event.target.value)
                      }
                      placeholder="Buscar banco (Nubank, XP, Itaú…)"
                      autoFocus
                    />
                    <div className="icon-grid">
                      {institutions.map((institution) => (
                        <button
                          key={institution.id}
                          type="button"
                          className="icon-option"
                          title={institution.name}
                          disabled={saving}
                          onClick={() =>
                            void updateConnectionIcon(
                              iconPickerTarget.id,
                              institution,
                            )
                          }
                        >
                          <img
                            src={institution.imageUrl}
                            alt={institution.name}
                            width={40}
                            height={40}
                          />
                          <span>{institution.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </BottomSheet>
            ) : null}

            {settingsSection === 'accounts' ? (
            <div className="settings-section">
              <div className="settings-section-head">
                <h2>Mapeamento de contas</h2>
                <p>
                  {settingsStats.pending > 0
                    ? `${settingsStats.pending} pendente(s) · ${settingsStats.mapped} mapeada(s)`
                    : `${settingsStats.mapped} conta(s) mapeada(s)`}
                </p>
              </div>
              {loading || !appSettings ? (
                  <div className="empty loading-empty">
                    <span className="spinner lg" aria-hidden />
                    <strong>Carregando mapeamento…</strong>
                  </div>
                ) : flatPluggyAccounts.length === 0 ? (
                  <div className="empty">
                    <strong>Sem contas Pluggy</strong>
                    <p>Cadastre bancos acima e atualize a home.</p>
                  </div>
                ) : (
                  <ul className="settings-card-list">
                    {flatPluggyAccounts.map((account) => {
                      const current = appSettings.accountMaps.find(
                        (map) => map.pluggyAccountId === account.id,
                      )
                      const targetType = current?.targetType ?? ''
                      const targetId = current?.organizzeTargetId ?? ''
                      const isCredit =
                        account.type.toUpperCase() === 'CREDIT'
                      const childCards = account.additionalCards ?? []
                      const hasChildCards =
                        isCredit && childCards.length > 0
                      const childrenExpanded =
                        expandedMapChildren[account.id] === true
                      const statusLabel =
                        targetType === 'ignored'
                          ? 'Ignorada'
                          : targetType
                            ? 'Mapeada'
                            : 'Pendente'
                      const statusClass =
                        targetType === 'ignored'
                          ? 'kind-invoice'
                          : targetType
                            ? 'kind-bank'
                            : 'kind-transfer'
                      const nicknamedChildren = hasChildCards
                        ? childCards.filter((card) => {
                            const nick =
                              current?.cardNicknames?.[card.number] ?? ''
                            return Boolean(nick.trim())
                          }).length
                        : 0
                      return (
                        <li
                          key={account.id}
                          className={`settings-card map-card${targetType === 'ignored' ? ' is-muted' : ''}`}
                        >
                          <div className="settings-card-head">
                            <div className="settings-card-meta">
                              <strong>{formatPluggyMapLabel(account)}</strong>
                              <span>
                                {account.connectionName} ·{' '}
                                {formatPluggyKind(account)}
                                {hasChildCards
                                  ? ` · ${childCards.length} cartões`
                                  : ''}
                              </span>
                            </div>
                            <span className={`badge ${statusClass}`}>
                              {statusLabel}
                            </span>
                          </div>
                          <div className="map-controls">
                              <select
                                value={targetType}
                                disabled={saving}
                                aria-label={`Tipo de mapeamento de ${account.name}`}
                                onChange={(event) => {
                                  const nextType = event.target.value as
                                    | 'account'
                                    | 'credit_card'
                                    | 'ignored'
                                    | ''
                                  if (!nextType) {
                                    void saveAccountMap(account.id, '', '')
                                    return
                                  }
                                  if (nextType === 'ignored') {
                                    void saveAccountMap(
                                      account.id,
                                      'ignored',
                                      0,
                                    )
                                    return
                                  }
                                  const defaultId =
                                    nextType === 'account'
                                      ? (organizzeAccounts[0]?.id ?? '')
                                      : (organizzeCreditCards[0]?.id ?? '')
                                  void saveAccountMap(
                                    account.id,
                                    nextType,
                                    defaultId,
                                  )
                                }}
                              >
                                <option value="">Sem mapeamento</option>
                                <option value="account">
                                  Conta Organizze
                                </option>
                                <option value="credit_card">
                                  Cartão Organizze
                                </option>
                                <option value="ignored">Ignorar</option>
                              </select>
                              {targetType === 'account' ? (
                                <select
                                  value={targetId}
                                  disabled={saving}
                                  aria-label={`Conta Organizze de ${account.name}`}
                                  onChange={(event) =>
                                    void saveAccountMap(
                                      account.id,
                                      'account',
                                      event.target.value
                                        ? Number(event.target.value)
                                        : '',
                                    )
                                  }
                                >
                                  <option value="">Escolha a conta</option>
                                  {organizzeAccounts
                                    .filter((item) => !item.archived)
                                    .map((item) => (
                                      <option key={item.id} value={item.id}>
                                        {item.name}
                                      </option>
                                    ))}
                                </select>
                              ) : null}
                              {targetType === 'credit_card' ? (
                                <select
                                  value={targetId}
                                  disabled={saving}
                                  aria-label={`Cartão Organizze de ${account.name}`}
                                  onChange={(event) =>
                                    void saveAccountMap(
                                      account.id,
                                      'credit_card',
                                      event.target.value
                                        ? Number(event.target.value)
                                        : '',
                                    )
                                  }
                                >
                                  <option value="">Escolha o cartão</option>
                                  {organizzeCreditCards.map((card) => (
                                    <option key={card.id} value={card.id}>
                                      {card.name}
                                    </option>
                                  ))}
                                </select>
                              ) : null}
                              {targetType &&
                              targetType !== 'ignored' &&
                              !hasChildCards ? (
                                <input
                                  className="map-nickname"
                                  type="text"
                                  maxLength={40}
                                  disabled={saving}
                                  defaultValue={current?.nickname ?? ''}
                                  key={`${account.id}-nick-${current?.nickname ?? ''}`}
                                  placeholder="Apelido"
                                  aria-label={`Apelido para ${account.name}`}
                                  onBlur={(event) =>
                                    void saveAccountNickname(
                                      account.id,
                                      event.target.value,
                                    )
                                  }
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                      event.currentTarget.blur()
                                    }
                                  }}
                                />
                              ) : null}
                            </div>
                          {hasChildCards && targetType && targetType !== 'ignored' ? (
                            <div className="map-children-block">
                              <button
                                type="button"
                                className="map-children-toggle"
                                onClick={() =>
                                  setExpandedMapChildren((currentExpanded) => ({
                                    ...currentExpanded,
                                    [account.id]: !childrenExpanded,
                                  }))
                                }
                              >
                                <span>
                                  {childrenExpanded ? '▾' : '▸'} Apelidos dos
                                  cartões
                                </span>
                                <span className="map-children-summary">
                                  {nicknamedChildren}/{childCards.length}
                                </span>
                              </button>
                              {childrenExpanded ? (
                                <ul className="map-children">
                                  {childCards.map((card) => {
                                    const nick =
                                      current?.cardNicknames?.[card.number] ??
                                      ''
                                    return (
                                      <li
                                        key={`${account.id}-${card.number}`}
                                        className="map-child-row"
                                      >
                                        <span className="map-child-label">
                                          Final {card.number}
                                        </span>
                                        <input
                                          className="map-nickname"
                                          type="text"
                                          maxLength={40}
                                          disabled={saving}
                                          defaultValue={nick}
                                          key={`${account.id}-${card.number}-nick-${nick}`}
                                          placeholder="Apelido"
                                          aria-label={`Apelido do cartão final ${card.number}`}
                                          onBlur={(event) =>
                                            void saveCardNickname(
                                              account.id,
                                              card.number,
                                              event.target.value,
                                            )
                                          }
                                          onKeyDown={(event) => {
                                            if (event.key === 'Enter') {
                                              event.currentTarget.blur()
                                            }
                                          }}
                                        />
                                      </li>
                                    )
                                  })}
                                </ul>
                              ) : null}
                            </div>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                )}
            </div>
            ) : null}

            {settingsSection === 'balances' ? (
            <article className="panel settings-panel">
              <div className="panel-head">
                <div>
                  <h2>Fontes de saldo</h2>
                  <p>
                    Investments entram na soma do saldo. Desmarque para
                    ignorar um item específico.
                  </p>
                </div>
              </div>
              <div className="panel-body">
                {loading || !appSettings ? (
                  <div className="empty loading-empty">
                    <span className="spinner lg" aria-hidden />
                    <strong>Carregando investments…</strong>
                  </div>
                ) : pluggyInvestments.length === 0 ? (
                  <div className="empty">
                    <strong>Nenhum investment encontrado</strong>
                    <p>
                      Conexões Pluggy sem produto de investimentos, ou ainda
                      sem sync recente.
                    </p>
                  </div>
                ) : (
                  <ul className="settings-card-list">
                    {pluggyInvestments.map((investment) => {
                      const sourceKey = `investment:${investment.id}`
                      const current = appSettings.balanceMaps.find(
                        (map) => map.sourceKey === sourceKey,
                      )
                      const targetId = current?.organizzeAccountId ?? ''
                      const included = current?.enabled !== false
                      const inferred =
                        inferOrganizzeAccountForInvestment(investment)
                      return (
                        <li
                          key={investment.id}
                          className={`settings-card map-card${included ? '' : ' is-muted'}`}
                        >
                          <div className="settings-card-head">
                            <div className="settings-card-meta">
                              <label className="balance-source-toggle">
                                <input
                                  type="checkbox"
                                  checked={included}
                                  disabled={saving}
                                  onChange={(event) =>
                                    void setInvestmentIncluded(
                                      investment,
                                      event.target.checked,
                                      inferred,
                                    )
                                  }
                                />
                                <strong>{investment.name}</strong>
                              </label>
                              <span>
                                {investment.connectionName ?? 'Pluggy'} ·{' '}
                                {investment.type}
                                {investment.subtype
                                  ? `/${investment.subtype}`
                                  : ''}{' '}
                                ·{' '}
                                {(investment.balanceCents / 100).toLocaleString(
                                  'pt-BR',
                                  { style: 'currency', currency: 'BRL' },
                                )}
                              </span>
                            </div>
                            <span
                              className={`badge ${included ? 'kind-bank' : 'kind-invoice'}`}
                            >
                              {included ? 'Na soma' : 'Ignorado'}
                            </span>
                          </div>
                          <div className="map-controls">
                              <select
                                value={targetId}
                                disabled={saving || !included}
                                onChange={(event) => {
                                  const value = event.target.value
                                  void saveBalanceMap(
                                    investment.id,
                                    value ? Number(value) : '',
                                    undefined,
                                    true,
                                  )
                                }}
                              >
                                <option value="">
                                  Auto (conta da conexão)
                                </option>
                                {organizzeAccounts
                                  .filter((item) => !item.archived)
                                  .map((item) => (
                                    <option key={item.id} value={item.id}>
                                      {item.name}
                                    </option>
                                  ))}
                              </select>
                              {targetId ? (
                                <input
                                  className="map-nickname"
                                  type="text"
                                  maxLength={40}
                                  disabled={saving || !included}
                                  defaultValue={current?.nickname ?? ''}
                                  key={`${investment.id}-nick-${current?.nickname ?? ''}`}
                                  placeholder="Apelido"
                                  aria-label={`Apelido para ${investment.name}`}
                                  onBlur={(event) =>
                                    void saveBalanceMap(
                                      investment.id,
                                      Number(targetId),
                                      event.target.value,
                                      true,
                                    )
                                  }
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                      event.currentTarget.blur()
                                    }
                                  }}
                                />
                              ) : null}
                            </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </article>
            ) : null}
            </div>
          </section>
          </PullToRefresh>
          </div>
        ) : null}
      </main>
    </div>
  )
}

export default App
