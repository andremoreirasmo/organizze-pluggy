import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import { BalancesView } from './BalancesView'
import { DashboardView } from './DashboardView'
import { ReconciliationView } from './ReconciliationView'

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

type View = 'reconcile' | 'balances' | 'dashboard' | 'settings'

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
  const [sessionEmail, setSessionEmail] = useState<string | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [googleClientId, setGoogleClientId] = useState<string | null>(null)
  const [googleButtonHost, setGoogleButtonHost] =
    useState<HTMLDivElement | null>(null)
  const [authenticated, setAuthenticated] = useState(false)
  const [view, setView] = useState<View>('reconcile')
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
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null)
  const [organizzeCreditCards, setOrganizzeCreditCards] = useState<
    OrganizzeCreditCard[]
  >([])
  const [pluggyInvestments, setPluggyInvestments] = useState<
    PluggyInvestment[]
  >([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

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
      setView('reconcile')
    })
    return () => setUnauthorizedHandler(null)
  }, [])

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
      setView('reconcile')
    },
    [loadHomeData],
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

  const openSettings = useCallback(async () => {
    setError(null)
    setView('settings')
    setAppSettings(null)
    setLoading(true)
    try {
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar config')
    } finally {
      setLoading(false)
    }
  }, [loadConfig, loadInstitutions, loadHomeData])

  const openBalances = useCallback(() => {
    setError(null)
    setView('balances')
  }, [])

  const openDashboard = useCallback(() => {
    setError(null)
    setView('dashboard')
  }, [])

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

  const openReconcile = useCallback(() => {
    setError(null)
    setView('reconcile')
  }, [])

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
      try {
        await apiFetch(`/api/pluggy/connections/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ customName: customName.trim() || null }),
        })
        await loadConfig()
        await loadHomeData()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Erro ao renomear')
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
    setView('reconcile')
    setError(null)
    window.setTimeout(() => {
      suppressUnauthorizedHandler = false
    }, 1000)
  }, [])

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
        <div className="topbar-actions">
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
          <button type="button" className="btn ghost" onClick={() => void logout()}>
            Sair{sessionEmail ? ` · ${sessionEmail.split('@')[0]}` : ''}
          </button>
        </div>
      </header>

      <main className="content">
        {error ? <p className="error-banner">{error}</p> : null}

        {view === 'reconcile' ? (
          <ReconciliationView
            apiFetch={authenticatedFetch}
            onError={setError}
          />
        ) : view === 'balances' ? (
          <BalancesView apiFetch={authenticatedFetch} onError={setError} />
        ) : view === 'dashboard' ? (
          <DashboardView apiFetch={authenticatedFetch} onError={setError} />
        ) : (
          <section className="settings">
            <div className="hero-panel">
              <div>
                <h1>
                  Configurações de <em>bancos</em>
                </h1>
                <p>
                  Gerencie conexões Pluggy, ícones e o mapeamento para o
                  Organizze.
                </p>
              </div>
            </div>

            <article className="panel settings-panel">
              <div className="panel-head">
                <div>
                  <h2>Bancos salvos</h2>
                  <p>{configConnections.length} conexão(ões) salva(s)</p>
                </div>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setError(null)
                    setNewItemId('')
                    setNewCustomName('')
                    setSelectedInstitution(null)
                    setInstitutionQuery('')
                    setAddConnectionOpen(true)
                  }}
                >
                  Adicionar conexão
                </button>
              </div>
              <div className="panel-body">
                {configConnections.length === 0 ? (
                  <div className="empty">
                    <strong>Lista vazia</strong>
                    <p>Clique em Adicionar conexão para cadastrar o primeiro banco.</p>
                  </div>
                ) : (
                  <ul className="account-list">
                    {configConnections.map((connection) => (
                      <li key={connection.id} className="config-item">
                        <div className="config-row">
                          <BankAvatar
                            name={connection.displayName}
                            imageUrl={bankImage(connection)}
                            color={bankColor(connection)}
                          />
                          <div className="account-meta">
                            <strong>{connection.displayName}</strong>
                            <span className="mono">{connection.itemId}</span>
                            {connection.institutionName ? (
                              <span>Banco: {connection.institutionName}</span>
                            ) : (
                              <span>Sem ícone selecionado</span>
                            )}
                          </div>
                          <div className="config-actions">
                            <button
                              type="button"
                              className="btn ghost"
                              onClick={() =>
                                setIconPickerForId((current) =>
                                  current === connection.id
                                    ? null
                                    : connection.id,
                                )
                              }
                            >
                              {iconPickerForId === connection.id
                                ? 'Fechar'
                                : 'Trocar ícone'}
                            </button>
                            <button
                              type="button"
                              className="btn ghost"
                              onClick={() => {
                                const next = window.prompt(
                                  'Apelido do banco (vazio remove o apelido)',
                                  connection.customName ?? '',
                                )
                                if (next === null) return
                                void renameConnection(connection.id, next)
                              }}
                            >
                              Renomear
                            </button>
                            <button
                              type="button"
                              className="btn danger"
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
                        </div>

                        {iconPickerForId === connection.id ? (
                          <div className="icon-picker nested-picker">
                            <div className="icon-picker-head">
                              <strong>Escolha o novo ícone</strong>
                            </div>
                            <input
                              className="icon-search"
                              value={institutionQuery}
                              onChange={(event) =>
                                setInstitutionQuery(event.target.value)
                              }
                              placeholder="Buscar banco…"
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
                                      connection.id,
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
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </article>

            {addConnectionOpen ? (
              <div
                className="modal-backdrop"
                role="presentation"
                onClick={() => {
                  if (!saving) {
                    setAddConnectionOpen(false)
                  }
                }}
              >
                <div
                  className="modal-card"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="add-connection-title"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="modal-head">
                    <div>
                      <h2 id="add-connection-title">Adicionar conexão</h2>
                      <p>
                        Cole o itemId do dashboard Pluggy e selecione o ícone
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={saving}
                      onClick={() => setAddConnectionOpen(false)}
                    >
                      Fechar
                    </button>
                  </div>
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
                </div>
              </div>
            ) : null}

            <article className="panel settings-panel">
              <div className="panel-head">
                <div>
                  <h2>Mapeamento de contas</h2>
                  <p>
                    Mapeie a conta/cartão pai no Organizze. Cartões físicos
                    vinculados aparecem abaixo só para apelido.
                    Use Ignorar para ocultar contas fora da conciliação.
                  </p>
                </div>
              </div>
              <div className="panel-body">
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
                  <ul className="account-list">
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
                      return (
                        <li key={account.id} className="config-row map-row">
                          <div className="map-parent">
                            <div className="account-meta">
                              <strong>{formatPluggyMapLabel(account)}</strong>
                              <span>
                                {account.connectionName} · {account.type}
                                {account.subtype ? `/${account.subtype}` : ''}
                                {hasChildCards
                                  ? ` · ${childCards.length} cartões`
                                  : ''}
                              </span>
                            </div>
                            <div className="map-controls">
                              <select
                                value={targetType}
                                disabled={saving}
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
                              {targetType === 'ignored' ? (
                                <span className="map-ignored-hint">
                                  Fora da fila e do alerta
                                </span>
                              ) : null}
                              {targetType === 'account' ? (
                                <select
                                  value={targetId}
                                  disabled={saving}
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
                              {targetType && !hasChildCards ? (
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
                          </div>
                          {hasChildCards ? (
                            <ul className="map-children">
                              {childCards.map((card) => {
                                const nick =
                                  current?.cardNicknames?.[card.number] ?? ''
                                return (
                                  <li
                                    key={`${account.id}-${card.number}`}
                                    className="map-child-row"
                                  >
                                    <div className="account-meta">
                                      <strong>
                                        Cartão · final {card.number}
                                      </strong>
                                      <span>
                                        Vinculado ao cartão pai no Organizze
                                      </span>
                                    </div>
                                    <div className="map-controls">
                                      <input
                                        className="map-nickname"
                                        type="text"
                                        maxLength={40}
                                        disabled={saving || !targetType}
                                        defaultValue={nick}
                                        key={`${account.id}-${card.number}-nick-${nick}`}
                                        placeholder={
                                          targetType
                                            ? 'Apelido'
                                            : 'Mapeie o pai primeiro'
                                        }
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
                                    </div>
                                  </li>
                                )
                              })}
                            </ul>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </article>

            <article className="panel settings-panel">
              <div className="panel-head">
                <div>
                  <h2>Fontes de saldo (investments)</h2>
                  <p>
                    Investments da mesma conexão Pluggy que uma conta corrente
                    mapeada entram automaticamente na soma. Desmarque o
                    checkbox para ignorar um investment específico.
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
                  <ul className="account-list">
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
                          className="config-row map-row"
                        >
                          <div className="map-parent">
                            <div className="account-meta">
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
                                {!included ? ' · ignorado na soma' : ''}
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
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </article>
          </section>
        )}
      </main>
    </div>
  )
}

export default App
