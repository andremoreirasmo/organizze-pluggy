import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
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
  nickname: string | null
}

type AppSettings = {
  amountTolerancePercent: number
  dateToleranceDays: number
  accountMaps: AccountMap[]
}

type OrganizzeCreditCard = {
  id: number
  name: string
  archived: boolean
}

type View = 'reconcile' | 'settings'

function authHeader(user: string, password: string): string {
  return `Basic ${btoa(`${user}:${password}`)}`
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

function formatPluggyMapLabel(
  account: PluggyAccount,
  nickname?: string | null,
): string {
  const base = nickname?.trim() || account.name
  const last4 = pluggyAccountLast4(account)
  if (last4) {
    return `${base} · final ${last4}`
  }
  if (!nickname?.trim()) {
    const ownerFirst = account.owner?.trim().split(/\s+/)[0]
    if (ownerFirst && account.type.toUpperCase() === 'CREDIT') {
      return `${base} · ${ownerFirst}`
    }
  }
  return base
}

/** Move legacy parent-card maps onto `accountId::last4` after additionalCards expansion. */
function migrateAccountMapsForAdditionalCards(
  maps: AccountMap[],
  accounts: Array<PluggyAccount & { connectionName?: string }>,
): { maps: AccountMap[]; changed: boolean } {
  const childrenBySource = new Map<string, PluggyAccount[]>()
  for (const account of accounts) {
    const source = account.sourceAccountId ?? account.id
    if (!account.id.includes('::')) {
      continue
    }
    const list = childrenBySource.get(source) ?? []
    list.push(account)
    childrenBySource.set(source, list)
  }

  let changed = false
  const usedChildIds = new Set(
    maps.filter((map) => map.pluggyAccountId.includes('::')).map((map) => map.pluggyAccountId),
  )
  const nextMaps: AccountMap[] = []

  for (const map of maps) {
    if (map.pluggyAccountId.includes('::')) {
      nextMaps.push(map)
      continue
    }
    const children = childrenBySource.get(map.pluggyAccountId) ?? []
    if (children.length <= 1) {
      nextMaps.push(map)
      continue
    }
    const primary =
      children.find((child) => child.cardNumber && child.id.endsWith(`::${child.cardNumber}`)) ??
      children[0]
    if (!primary || usedChildIds.has(primary.id)) {
      nextMaps.push(map)
      continue
    }
    nextMaps.push({
      ...map,
      pluggyAccountId: primary.id,
    })
    usedChildIds.add(primary.id)
    changed = true
  }

  return { maps: nextMaps, changed }
}

async function apiFetch<T>(
  path: string,
  user: string,
  password: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: authHeader(user, password),
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`${response.status}: ${text}`)
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
  const [user, setUser] = useState(() => sessionStorage.getItem('appUser') ?? '')
  const [password, setPassword] = useState(
    () => sessionStorage.getItem('appPassword') ?? '',
  )
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
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const canLoad = useMemo(
    () => user.trim().length > 0 && password.length > 0,
    [user, password],
  )

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

  const loadHomeData = useCallback(
    async (authUser: string, authPassword: string) => {
      const [accounts, pluggy] = await Promise.all([
        apiFetch<OrganizzeAccount[]>(
          '/api/organizze/accounts',
          authUser,
          authPassword,
        ),
        apiFetch<{ connections: PluggyConnection[] }>(
          '/api/pluggy/connections',
          authUser,
          authPassword,
        ),
      ])
      setOrganizzeAccounts(accounts)
      setPluggyConnections(pluggy.connections)
    },
    [],
  )

  const loadConfig = useCallback(async () => {
    const rows = await apiFetch<StoredConnection[]>(
      '/api/pluggy/connections/config',
      user,
      password,
    )
    setConfigConnections(rows)
  }, [user, password])

  const loadInstitutions = useCallback(
    async (query?: string) => {
      const path = query?.trim()
        ? `/api/pluggy/institutions?q=${encodeURIComponent(query.trim())}`
        : '/api/pluggy/institutions'
      const rows = await apiFetch<InstitutionOption[]>(path, user, password)
      setInstitutions(rows)
    },
    [user, password],
  )

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

  const login = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      await loadHomeData(user, password)
      sessionStorage.setItem('appUser', user)
      sessionStorage.setItem('appPassword', password)
      setAuthenticated(true)
      setView('reconcile')
    } catch (err) {
      setAuthenticated(false)
      setError(err instanceof Error ? err.message : 'Falha no login')
    } finally {
      setLoading(false)
    }
  }, [user, password, loadHomeData])

  const openSettings = useCallback(async () => {
    setError(null)
    setView('settings')
    setAppSettings(null)
    setLoading(true)
    try {
      const [, , settings, cards] = await Promise.all([
        loadConfig(),
        loadInstitutions(),
        apiFetch<AppSettings>('/api/settings', user, password),
        apiFetch<OrganizzeCreditCard[]>(
          '/api/organizze/credit-cards',
          user,
          password,
        ),
        loadHomeData(user, password),
      ])
      setOrganizzeCreditCards(cards)

      // loadHomeData updates pluggyConnections asynchronously via setState;
      // re-fetch connections here for migration with the latest payload.
      const pluggy = await apiFetch<{ connections: PluggyConnection[] }>(
        '/api/pluggy/connections',
        user,
        password,
      )
      setPluggyConnections(pluggy.connections)
      const flatAccounts = pluggy.connections.flatMap((connection) =>
        connection.accounts.map((account) => ({
          ...account,
          connectionName: connection.displayName,
        })),
      )
      const migrated = migrateAccountMapsForAdditionalCards(
        settings.accountMaps,
        flatAccounts,
      )
      if (migrated.changed) {
        const updated = await apiFetch<AppSettings>('/api/settings', user, password, {
          method: 'PUT',
          body: JSON.stringify({ accountMaps: migrated.maps }),
        })
        setAppSettings(updated)
      } else {
        setAppSettings(settings)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar config')
    } finally {
      setLoading(false)
    }
  }, [loadConfig, loadInstitutions, loadHomeData, user, password])

  const authenticatedFetch = useCallback(
    <T,>(path: string, init?: RequestInit) =>
      apiFetch<T>(path, user, password, init),
    [user, password],
  )

  const saveAccountMap = useCallback(
    async (
      pluggyAccountId: string,
      targetType: 'account' | 'credit_card' | 'ignored' | '',
      organizzeTargetId: number | '',
      nickname?: string | null,
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
        const nextMaps = appSettings.accountMaps.filter(
          (map) => map.pluggyAccountId !== pluggyAccountId,
        )
        if (targetType === 'ignored') {
          nextMaps.push({
            pluggyAccountId,
            targetType: 'ignored',
            organizzeTargetId: 0,
            nickname: nextNickname,
          })
        } else if (targetType && organizzeTargetId !== '') {
          nextMaps.push({
            pluggyAccountId,
            targetType,
            organizzeTargetId: Number(organizzeTargetId),
            nickname: nextNickname,
          })
        }
        const updated = await apiFetch<AppSettings>('/api/settings', user, password, {
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
    [appSettings, user, password],
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
      await apiFetch('/api/pluggy/connections', user, password, {
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
      await loadHomeData(user, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao adicionar banco')
    } finally {
      setSaving(false)
    }
  }, [
    newItemId,
    newCustomName,
    selectedInstitution,
    user,
    password,
    loadConfig,
    loadHomeData,
  ])

  const renameConnection = useCallback(
    async (id: string, customName: string) => {
      setError(null)
      try {
        await apiFetch(`/api/pluggy/connections/${id}`, user, password, {
          method: 'PATCH',
          body: JSON.stringify({ customName: customName.trim() || null }),
        })
        await loadConfig()
        await loadHomeData(user, password)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Erro ao renomear')
      }
    },
    [user, password, loadConfig, loadHomeData],
  )

  const updateConnectionIcon = useCallback(
    async (id: string, institution: InstitutionOption) => {
      setError(null)
      setSaving(true)
      try {
        await apiFetch(`/api/pluggy/connections/${id}`, user, password, {
          method: 'PATCH',
          body: JSON.stringify({
            institutionName: institution.name,
            institutionImageUrl: institution.imageUrl,
            institutionPrimaryColor: institution.primaryColor,
          }),
        })
        setIconPickerForId(null)
        await loadConfig()
        await loadHomeData(user, password)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Erro ao trocar ícone')
      } finally {
        setSaving(false)
      }
    },
    [user, password, loadConfig, loadHomeData],
  )

  const deleteConnection = useCallback(
    async (id: string, name: string) => {
      if (!window.confirm(`Remover a conexão “${name}”?`)) {
        return
      }
      setError(null)
      try {
        await apiFetch(`/api/pluggy/connections/${id}`, user, password, {
          method: 'DELETE',
        })
        await loadConfig()
        await loadHomeData(user, password)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Erro ao remover')
      }
    },
    [user, password, loadConfig, loadHomeData],
  )

  const logout = () => {
    sessionStorage.removeItem('appUser')
    sessionStorage.removeItem('appPassword')
    setAuthenticated(false)
    setOrganizzeAccounts([])
    setPluggyConnections([])
    setConfigConnections([])
    setView('reconcile')
    setError(null)
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
            Use o usuário e senha do app para conciliar Open Finance com o
            Organizze.
          </p>
          <form
            className="login-form"
            onSubmit={(event) => {
              event.preventDefault()
              void login()
            }}
          >
            <label>
              Usuário
              <input
                value={user}
                onChange={(event) => setUser(event.target.value)}
                autoComplete="username"
                placeholder="seu usuário"
              />
            </label>
            <label>
              Senha
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                placeholder="••••••••"
              />
            </label>
            {error ? <p className="error">{error}</p> : null}
            <button className="btn block" type="submit" disabled={!canLoad || loading}>
              {loading ? 'Entrando…' : 'Entrar'}
            </button>
          </form>
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
            Conciliação
          </button>
          <button
            type="button"
            className={`btn ghost ${view === 'settings' ? 'active-nav' : ''}`}
            onClick={() => void openSettings()}
          >
            Configurações
          </button>
          <button type="button" className="btn ghost" onClick={logout}>
            Sair
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
                  <p>{configConnections.length} conexão(ões) no Neon</p>
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
                    Associe cada conta/cartão Pluggy ao Organizze. Use um
                    apelido para diferenciar cartões iguais, e Ignorar para
                    ocultar contas fora da conciliação.
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
                      return (
                        <li key={account.id} className="config-row map-row">
                          <div className="account-meta">
                            <strong>
                              {formatPluggyMapLabel(account, current?.nickname)}
                            </strong>
                            <span>
                              {account.connectionName} · {account.type}
                              {account.subtype ? `/${account.subtype}` : ''}
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
                                  void saveAccountMap(account.id, 'ignored', 0)
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
                              <option value="account">Conta Organizze</option>
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
                            {targetType ? (
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
