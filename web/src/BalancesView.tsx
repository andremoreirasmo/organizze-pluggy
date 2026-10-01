import { useCallback, useEffect, useState } from 'react'
import { CategoryPicker, type CategoryOption } from './CategoryPicker'

export type BalanceSnapshotSource = {
  sourceKey: string
  sourceKind: 'account' | 'investment' | 'reserved'
  pluggySourceId: string
  label: string
  balanceCents: number
  connectionName: string | null
  included: boolean
}

export type BalanceSnapshotRow = {
  organizzeAccountId: number
  organizzeAccountName: string
  organizzeBalanceCents: number
  openFinanceBalanceCents: number
  diffCents: number
  status: 'ok' | 'diverged'
  sources: BalanceSnapshotSource[]
}

export type UnmappedInvestment = {
  id: string
  name: string
  balanceCents: number
  type: string
  subtype: string | null
  connectionName: string | null
  itemId: string
}

export type BalanceSnapshotResponse = {
  generatedAt: string
  toleranceCents: number
  investmentsFound: number
  rows: BalanceSnapshotRow[]
  unmappedInvestments: UnmappedInvestment[]
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
  accountMaps: unknown[]
  balanceMaps: BalanceMap[]
}

type ApiFetch = <T>(path: string, init?: RequestInit) => Promise<T>

type Props = {
  apiFetch: ApiFetch
  onError: (message: string | null) => void
}

function formatBRL(amountCents: number): string {
  return (amountCents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function parseBRLInput(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  if (trimmed.includes(',')) {
    const normalized = Number(trimmed.replace(/\./g, '').replace(',', '.'))
    return Number.isFinite(normalized) ? normalized : null
  }
  const normalized = Number(trimmed)
  return Number.isFinite(normalized) ? normalized : null
}

function applySourceIncludedLocally(
  current: BalanceSnapshotResponse,
  organizzeAccountId: number,
  sourceKey: string,
  included: boolean,
): BalanceSnapshotResponse {
  return {
    ...current,
    rows: current.rows.map((row) => {
      if (row.organizzeAccountId !== organizzeAccountId) {
        return row
      }
      const sources = row.sources.map((source) =>
        source.sourceKey === sourceKey ? { ...source, included } : source,
      )
      const openFinanceBalanceCents = sources
        .filter((source) => source.included)
        .reduce((sum, source) => sum + source.balanceCents, 0)
      const diffCents = openFinanceBalanceCents - row.organizzeBalanceCents
      return {
        ...row,
        sources,
        openFinanceBalanceCents,
        diffCents,
        status: diffCents === 0 ? 'ok' : 'diverged',
      }
    }),
  }
}

export function BalancesView({ apiFetch, onError }: Props) {
  const [snapshot, setSnapshot] = useState<BalanceSnapshotResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [categories, setCategories] = useState<CategoryOption[]>([])
  const [adjustRow, setAdjustRow] = useState<BalanceSnapshotRow | null>(null)
  const [adjustAmount, setAdjustAmount] = useState('')
  const [adjustDate, setAdjustDate] = useState(todayISO)
  const [adjustDescription, setAdjustDescription] = useState('')
  const [adjustCategoryId, setAdjustCategoryId] = useState('')
  const [saving, setSaving] = useState(false)
  const [togglingKey, setTogglingKey] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const loadSnapshot = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) {
        onError(null)
        setLoading(true)
        setStatusMessage('Carregando saldos…')
      }
      try {
        const [data, cats] = await Promise.all([
          apiFetch<BalanceSnapshotResponse>('/api/balances/snapshot'),
          apiFetch<CategoryOption[]>('/api/organizze/categories'),
        ])
        setSnapshot(data)
        setCategories(cats)
        if (!options?.silent) {
          const diverged = data.rows.filter((row) => row.status === 'diverged')
            .length
          const investmentSources = data.rows.reduce(
            (sum, row) =>
              sum +
              row.sources.filter(
                (source) =>
                  source.sourceKind === 'investment' && source.included,
              ).length,
            0,
          )
          const parts: string[] = []
          if (data.rows.length === 0) {
            parts.push(
              'Nenhuma fonte de saldo mapeada. Mapeie contas em Configurações.',
            )
          } else if (diverged > 0) {
            parts.push(`${diverged} conta(s) com diferença de saldo.`)
          } else {
            parts.push(
              `${data.rows.length} conta(s) alinhadas com o Open Finance.`,
            )
          }
          if (data.investmentsFound > 0) {
            parts.push(
              `${data.investmentsFound} investment(s) Pluggy · ${investmentSources} na soma.`,
            )
          } else {
            parts.push(
              'Nenhum investment retornado pelo Pluggy nesta sincronização.',
            )
          }
          setStatusMessage(parts.join(' '))
        }
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Erro ao carregar saldos')
        if (!options?.silent) {
          setStatusMessage(null)
        }
        throw err
      } finally {
        if (!options?.silent) {
          setLoading(false)
        }
      }
    },
    [apiFetch, onError],
  )

  useEffect(() => {
    void loadSnapshot().catch(() => undefined)
  }, [loadSnapshot])

  const toggleOptionalSourceIncluded = async (
    row: BalanceSnapshotRow,
    source: BalanceSnapshotSource,
    included: boolean,
  ) => {
    if (source.sourceKind !== 'investment' && source.sourceKind !== 'reserved') {
      return
    }
    if (!snapshot || source.included === included) {
      return
    }

    const previous = snapshot
    const nextLocal = applySourceIncludedLocally(
      snapshot,
      row.organizzeAccountId,
      source.sourceKey,
      included,
    )
    setSnapshot(nextLocal)
    setTogglingKey(source.sourceKey)
    onError(null)

    try {
      const settings = await apiFetch<AppSettings>('/api/settings')
      const existing = settings.balanceMaps.find(
        (map) => map.sourceKey === source.sourceKey,
      )
      const nextMaps = settings.balanceMaps.filter(
        (map) => map.sourceKey !== source.sourceKey,
      )
      if (!included) {
        nextMaps.push({
          sourceKey: source.sourceKey,
          sourceKind: source.sourceKind,
          pluggySourceId: source.pluggySourceId,
          organizzeAccountId: row.organizzeAccountId,
          nickname: existing?.nickname ?? null,
          enabled: false,
        })
      } else if (existing && existing.enabled === false) {
        nextMaps.push({
          ...existing,
          sourceKind: source.sourceKind,
          organizzeAccountId:
            existing.organizzeAccountId || row.organizzeAccountId,
          enabled: true,
        })
      }
      await apiFetch<AppSettings>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ balanceMaps: nextMaps }),
      })
    } catch (err) {
      setSnapshot(previous)
      onError(
        err instanceof Error
          ? err.message
          : 'Erro ao atualizar fonte na soma',
      )
    } finally {
      setTogglingKey(null)
    }
  }

  const openAdjust = (row: BalanceSnapshotRow) => {
    setAdjustRow(row)
    setAdjustAmount((row.diffCents / 100).toFixed(2))
    setAdjustDate(todayISO())
    setAdjustDescription(
      row.diffCents > 0
        ? 'Ajuste de saldo (rendimento)'
        : 'Ajuste de saldo (perda)',
    )
    setAdjustCategoryId('')
    onError(null)
  }

  const closeAdjust = () => {
    if (saving) {
      return
    }
    setAdjustRow(null)
  }

  const submitAdjust = async () => {
    if (!adjustRow) {
      return
    }
    const parsed = parseBRLInput(adjustAmount)
    if (parsed === null || parsed === 0) {
      onError('Informe um valor diferente de zero')
      return
    }
    const amountCents = Math.round(parsed * 100)
    setSaving(true)
    onError(null)
    try {
      const result = await apiFetch<{
        snapshot: BalanceSnapshotResponse
      }>('/api/balances/adjust', {
        method: 'POST',
        body: JSON.stringify({
          organizzeAccountId: adjustRow.organizzeAccountId,
          amountCents,
          date: adjustDate,
          description: adjustDescription.trim() || undefined,
          ...(adjustCategoryId
            ? { categoryId: Number(adjustCategoryId) }
            : {}),
        }),
      })
      setSnapshot(result.snapshot)
      setAdjustRow(null)
      setStatusMessage(
        `Ajuste de ${formatBRL(amountCents)} criado em “${adjustRow.organizzeAccountName}”.`,
      )
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Erro ao criar ajuste')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="balances">
      <div className="hero-panel">
        <div>
          <h1>
            Conciliação de <em>saldos</em>
          </h1>
          <p>
            Compara o Open Finance (contas e investments) com o saldo no
            Organizze e cria lançamentos de ajuste quando divergirem.
          </p>
        </div>
        <button
          type="button"
          className="btn"
          disabled={loading || saving}
          onClick={() => void loadSnapshot()}
        >
          {loading ? 'Atualizando…' : 'Atualizar'}
        </button>
      </div>

      {statusMessage || loading ? (
        <div
          className={`status-banner ${loading ? 'busy' : ''}`}
          role="status"
          aria-live="polite"
        >
          {loading ? <span className="spinner" aria-hidden /> : null}
          <span>
            {statusMessage}
          </span>
        </div>
      ) : null}

      {snapshot && snapshot.unmappedInvestments.length > 0 ? (
        <div className="warning-banner">
          <span>
            {snapshot.unmappedInvestments.length} investment(s) sem conta
            Organizze única na mesma conexão (ex.:{' '}
            {snapshot.unmappedInvestments
              .slice(0, 3)
              .map((item) => item.name)
              .join(', ')}
            ). Mapeie em Configurações → Fontes de saldo.
          </span>
        </div>
      ) : null}

      {loading && !snapshot ? (
        <div className="empty loading-empty">
          <span className="spinner lg" aria-hidden />
          <strong>Carregando saldos…</strong>
        </div>
      ) : !snapshot || snapshot.rows.length === 0 ? (
        <div className="empty">
          <strong>Nada para comparar</strong>
          <p>
            Contas bancárias mapeadas entram automaticamente. Investments
            (XP, cofrinho) precisam de mapeamento em Configurações → Fontes de
            saldo.
          </p>
        </div>
      ) : (
        <ul className={`balance-list ${saving ? 'is-busy' : ''}`}>
          {snapshot.rows.map((row) => (
            <li
              key={row.organizzeAccountId}
              className={`balance-card ${row.status === 'diverged' ? 'is-diverged' : 'is-ok'}`}
            >
              <div className="balance-card-head">
                <div>
                  <span
                    className={`badge ${row.status === 'ok' ? 'kind-bank' : 'kind-invoice'}`}
                  >
                    {row.status === 'ok' ? 'OK' : 'Divergente'}
                  </span>
                  <strong>{row.organizzeAccountName}</strong>
                </div>
                {row.status === 'diverged' ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={saving}
                    onClick={() => openAdjust(row)}
                  >
                    Ajustar
                  </button>
                ) : null}
              </div>

              <div className="balance-grid">
                <div>
                  <span>Open Finance</span>
                  <strong>{formatBRL(row.openFinanceBalanceCents)}</strong>
                </div>
                <div>
                  <span>Organizze</span>
                  <strong>{formatBRL(row.organizzeBalanceCents)}</strong>
                </div>
                <div>
                  <span>Diferença</span>
                  <strong
                    className={
                      row.diffCents === 0
                        ? ''
                        : row.diffCents > 0
                          ? 'pos'
                          : 'neg'
                    }
                  >
                    {row.diffCents > 0 ? '+' : ''}
                    {formatBRL(row.diffCents)}
                  </strong>
                </div>
              </div>

              <div className="balance-sources">
                <span className="balance-sources-label">
                  Fontes OF · desmarque investments/reservados para ignorar
                </span>
                <ul>
                  {row.sources.map((source) => {
                    const canToggle =
                      source.sourceKind === 'investment' ||
                      source.sourceKind === 'reserved'
                    const busyToggle = togglingKey === source.sourceKey
                    const kindLabel =
                      source.sourceKind === 'investment'
                        ? 'investment'
                        : source.sourceKind === 'reserved'
                          ? 'reservado'
                          : 'conta'
                    return (
                      <li
                        key={source.sourceKey}
                        className={
                          source.included ? undefined : 'is-excluded'
                        }
                      >
                        {canToggle ? (
                          <label className="balance-source-toggle">
                            <input
                              type="checkbox"
                              checked={source.included}
                              disabled={saving || busyToggle}
                              onChange={(event) =>
                                void toggleOptionalSourceIncluded(
                                  row,
                                  source,
                                  event.target.checked,
                                )
                              }
                            />
                            <span>
                              {source.label}
                              {source.connectionName
                                ? ` · ${source.connectionName}`
                                : ''}
                              {` · ${kindLabel}`}
                              {!source.included ? ' · ignorado' : ''}
                            </span>
                          </label>
                        ) : (
                          <span>
                            {source.label}
                            {source.connectionName
                              ? ` · ${source.connectionName}`
                              : ''}
                            {` · ${kindLabel}`}
                          </span>
                        )}
                        <strong
                          className={source.included ? undefined : 'muted'}
                        >
                          {formatBRL(source.balanceCents)}
                        </strong>
                      </li>
                    )
                  })}
                </ul>
              </div>
            </li>
          ))}
        </ul>
      )}

      {adjustRow ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={closeAdjust}
        >
          <div
            className="modal-card create-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="adjust-balance-title"
            onClick={(event) => event.stopPropagation()}
          >
            {saving ? (
              <div className="modal-loading" role="status">
                <span className="spinner lg" aria-hidden />
                <strong>Criando ajuste…</strong>
                <p>Lançamento no Organizze para alinhar o saldo.</p>
              </div>
            ) : null}

            <div className="modal-head">
              <div>
                <h2 id="adjust-balance-title">Ajustar saldo</h2>
                <p>
                  Cria um lançamento pago em “{adjustRow.organizzeAccountName}”
                  para aproximar o saldo do Open Finance.
                </p>
              </div>
              <button
                type="button"
                className="modal-close"
                disabled={saving}
                onClick={closeAdjust}
                aria-label="Fechar"
              >
                ×
              </button>
            </div>

            <div className="settings-form modal-body">
              <div className="create-destination">
                <div className="create-destination-row">
                  <span>Open Finance</span>
                  <strong>
                    {formatBRL(adjustRow.openFinanceBalanceCents)}
                  </strong>
                </div>
                <div className="create-destination-row">
                  <span>Organizze</span>
                  <strong>
                    {formatBRL(adjustRow.organizzeBalanceCents)}
                  </strong>
                </div>
                <div className="create-destination-row">
                  <span>Diff sugerido</span>
                  <strong
                    className={adjustRow.diffCents >= 0 ? 'pos' : 'neg'}
                  >
                    {adjustRow.diffCents > 0 ? '+' : ''}
                    {formatBRL(adjustRow.diffCents)}
                  </strong>
                </div>
              </div>

              <label>
                Valor do ajuste (R$)
                <input
                  value={adjustAmount}
                  disabled={saving}
                  inputMode="decimal"
                  onChange={(event) => setAdjustAmount(event.target.value)}
                />
              </label>

              <label>
                Data
                <input
                  type="date"
                  value={adjustDate}
                  disabled={saving}
                  onChange={(event) => setAdjustDate(event.target.value)}
                />
              </label>

              <label>
                Descrição
                <input
                  value={adjustDescription}
                  disabled={saving}
                  onChange={(event) =>
                    setAdjustDescription(event.target.value)
                  }
                />
              </label>

              <label>
                Categoria
                <CategoryPicker
                  categories={categories}
                  value={adjustCategoryId}
                  amountCents={Math.round(
                    (parseBRLInput(adjustAmount) ?? 0) * 100,
                  )}
                  disabled={saving}
                  onChange={setAdjustCategoryId}
                />
              </label>

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn ghost"
                  disabled={saving}
                  onClick={closeAdjust}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={saving}
                  onClick={() => void submitAdjust()}
                >
                  Criar ajuste
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
