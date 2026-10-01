import { useCallback, useEffect, useState } from 'react'
import { BottomSheet } from './BottomSheet'
import { CategoryPicker, type CategoryOption } from './CategoryPicker'
import {
  formatInvoiceDate,
  formatInvoiceMonthTitle,
} from './InvoicePicker'
import { PullToRefresh } from './PullToRefresh'

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
  invoiceRows: InvoiceBalanceRow[]
  unmappedCreditAccounts: UnmappedCreditAccount[]
}

export type UnmappedCreditAccount = {
  id: string
  name: string
  balanceCents: number
  connectionName: string | null
}

export type InvoiceBalanceRow = {
  organizzeCreditCardId: number
  organizzeCreditCardName: string
  pluggyAccountId: string
  pluggyAccountName: string
  pluggyBillId: string | null
  pluggyBillTotalCents: number | null
  pluggyBillDueDate: string | null
  pluggyBillCloseDate: string | null
  pluggyMinimumPaymentCents: number | null
  invoiceId: number | null
  invoiceDueDate: string | null
  invoiceStartingDate: string | null
  invoiceClosingDate: string | null
  organizzeAmountCents: number | null
  organizzePaymentCents: number | null
  organizzeBalanceCents: number | null
  diffCents: number | null
  status: 'ok' | 'diverged' | 'no_invoice' | 'no_pluggy_bill'
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
  const [adjustInvoiceRow, setAdjustInvoiceRow] =
    useState<InvoiceBalanceRow | null>(null)
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
        const [raw, cats] = await Promise.all([
          apiFetch<BalanceSnapshotResponse>('/api/balances/snapshot'),
          apiFetch<CategoryOption[]>('/api/organizze/categories'),
        ])
        const data: BalanceSnapshotResponse = {
          ...raw,
          invoiceRows: raw.invoiceRows ?? [],
          unmappedCreditAccounts: raw.unmappedCreditAccounts ?? [],
        }
        setSnapshot(data)
        setCategories(cats)
        if (!options?.silent) {
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
          if (data.rows.length === 0 && data.invoiceRows.length === 0) {
            parts.push(
              'Nenhuma fonte de saldo mapeada. Mapeie contas e cartões em Configurações.',
            )
          } else if (data.rows.length === 0) {
            parts.push('Nenhuma conta bancária mapeada para saldo.')
          } else {
            const diverged = data.rows.filter(
              (row) => row.status === 'diverged',
            ).length
            if (diverged > 0) {
              parts.push(`${diverged} conta(s) com diferença de saldo.`)
            } else {
              parts.push(
                `${data.rows.length} conta(s) alinhadas com o Open Finance.`,
              )
            }
          }
          if (data.invoiceRows.length > 0) {
            const invoiceDiverged = data.invoiceRows.filter(
              (row) => row.status === 'diverged',
            ).length
            if (invoiceDiverged > 0) {
              parts.push(
                `${invoiceDiverged} fatura(s) de cartão divergente(s).`,
              )
            } else {
              parts.push(
                `${data.invoiceRows.length} fatura(s) de cartão conferida(s).`,
              )
            }
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
    setAdjustInvoiceRow(null)
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

  const openAdjustInvoice = (row: InvoiceBalanceRow) => {
    if (row.invoiceId === null || row.diffCents === null) {
      return
    }
    // OF bill > Organizze ⇒ missing expenses ⇒ negative amount on card.
    const suggestedCents = -row.diffCents
    setAdjustRow(null)
    setAdjustInvoiceRow(row)
    setAdjustAmount((suggestedCents / 100).toFixed(2))
    setAdjustDate(row.invoiceDueDate ?? todayISO())
    setAdjustDescription(
      suggestedCents < 0
        ? 'Ajuste de fatura (lançamento)'
        : 'Ajuste de fatura (crédito)',
    )
    setAdjustCategoryId('')
    onError(null)
  }

  const closeAdjust = () => {
    if (saving) {
      return
    }
    setAdjustRow(null)
    setAdjustInvoiceRow(null)
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
      setSnapshot({
        ...result.snapshot,
        invoiceRows: result.snapshot.invoiceRows ?? [],
        unmappedCreditAccounts: result.snapshot.unmappedCreditAccounts ?? [],
      })
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

  const submitAdjustInvoice = async () => {
    if (!adjustInvoiceRow || adjustInvoiceRow.invoiceId === null) {
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
      }>('/api/balances/adjust-invoice', {
        method: 'POST',
        body: JSON.stringify({
          organizzeCreditCardId: adjustInvoiceRow.organizzeCreditCardId,
          invoiceId: adjustInvoiceRow.invoiceId,
          amountCents,
          date: adjustDate,
          description: adjustDescription.trim() || undefined,
          ...(adjustCategoryId
            ? { categoryId: Number(adjustCategoryId) }
            : {}),
        }),
      })
      setSnapshot({
        ...result.snapshot,
        invoiceRows: result.snapshot.invoiceRows ?? [],
        unmappedCreditAccounts: result.snapshot.unmappedCreditAccounts ?? [],
      })
      setAdjustInvoiceRow(null)
      setStatusMessage(
        `Ajuste de ${formatBRL(amountCents)} criado na fatura de “${adjustInvoiceRow.organizzeCreditCardName}”.`,
      )
    } catch (err) {
      onError(
        err instanceof Error ? err.message : 'Erro ao criar ajuste de fatura',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="balances">
      <PullToRefresh
        onRefresh={() => loadSnapshot()}
        disabled={loading || saving}
      >
      <div className="hero-panel">
        <div>
          <h1>
            Conciliação de <em>saldos</em>
          </h1>
          <p>
            Compara Open Finance com o Organizze: contas, investments e
            faturas de cartão. Em contas divergentes, você pode criar um
            lançamento de ajuste.
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

      {snapshot && snapshot.unmappedCreditAccounts.length > 0 ? (
        <div className="warning-banner">
          <span>
            {snapshot.unmappedCreditAccounts.length} cartão(ões) Pluggy sem
            mapa Organizze (ex.:{' '}
            {snapshot.unmappedCreditAccounts
              .slice(0, 3)
              .map((item) => item.name)
              .join(', ')}
            ). Mapeie em Configurações → Contas.
          </span>
        </div>
      ) : null}

      {loading && !snapshot ? (
        <div className="empty loading-empty">
          <span className="spinner lg" aria-hidden />
          <strong>Carregando saldos…</strong>
        </div>
      ) : !snapshot ||
        (snapshot.rows.length === 0 && snapshot.invoiceRows.length === 0) ? (
        <div className="empty">
          <strong>Nada para comparar</strong>
          <p>
            Contas bancárias mapeadas entram automaticamente. Cartões e
            investments precisam de mapeamento em Configurações.
          </p>
        </div>
      ) : (
        <>
          {snapshot.rows.length > 0 ? (
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
          ) : null}

          {snapshot.invoiceRows.length > 0 ? (
            <section className="balance-invoice-section">
              <header className="balance-section-head">
                <h2>Faturas de cartão</h2>
                <p>
                  Compara a fatura fechada do Open Finance (Bills) com o total
                  da fatura no Organizze. Em divergência, crie um lançamento de
                  ajuste na fatura.
                </p>
              </header>
              <ul className={`balance-list ${saving ? 'is-busy' : ''}`}>
                {snapshot.invoiceRows.map((row) => {
                  const invoiceTitle = row.invoiceStartingDate
                    ? formatInvoiceMonthTitle(row.invoiceStartingDate)
                    : row.invoiceDueDate
                      ? formatInvoiceMonthTitle(row.invoiceDueDate)
                      : null
                  const statusLabel =
                    row.status === 'ok'
                      ? 'OK'
                      : row.status === 'no_invoice'
                        ? 'Sem fatura Oz'
                        : row.status === 'no_pluggy_bill'
                          ? 'Sem fatura OF'
                          : 'Divergente'
                  const statusClass =
                    row.status === 'ok'
                      ? 'kind-bank'
                      : row.status === 'diverged'
                        ? 'kind-invoice'
                        : 'kind-transfer'
                  return (
                    <li
                      key={`${row.organizzeCreditCardId}-${row.pluggyAccountId}`}
                      className={`balance-card ${
                        row.status === 'diverged'
                          ? 'is-diverged'
                          : row.status === 'ok'
                            ? 'is-ok'
                            : ''
                      }`}
                    >
                      <div className="balance-card-head">
                        <div>
                          <span className={`badge ${statusClass}`}>
                            {statusLabel}
                          </span>
                          <strong>{row.organizzeCreditCardName}</strong>
                          <span className="balance-card-sub">
                            {row.pluggyAccountName}
                            {invoiceTitle ? ` · ${invoiceTitle}` : ''}
                          </span>
                        </div>
                        {row.status === 'diverged' && row.invoiceId !== null ? (
                          <button
                            type="button"
                            className="btn"
                            disabled={saving}
                            onClick={() => openAdjustInvoice(row)}
                          >
                            Ajustar
                          </button>
                        ) : null}
                      </div>

                      <div className="balance-grid">
                        <div>
                          <span>Fatura OF</span>
                          <strong>
                            {row.pluggyBillTotalCents === null
                              ? '—'
                              : formatBRL(row.pluggyBillTotalCents)}
                          </strong>
                        </div>
                        <div>
                          <span>Fatura Organizze</span>
                          <strong>
                            {row.organizzeAmountCents === null
                              ? '—'
                              : formatBRL(row.organizzeAmountCents)}
                          </strong>
                        </div>
                        <div>
                          <span>Diferença</span>
                          <strong
                            className={
                              row.diffCents === null || row.diffCents === 0
                                ? ''
                                : row.diffCents > 0
                                  ? 'pos'
                                  : 'neg'
                            }
                          >
                            {row.diffCents === null
                              ? '—'
                              : `${row.diffCents > 0 ? '+' : ''}${formatBRL(row.diffCents)}`}
                          </strong>
                        </div>
                      </div>

                      <div className="balance-invoice-meta">
                        {row.organizzePaymentCents ? (
                          <span>
                            Pago Oz {formatBRL(row.organizzePaymentCents)}
                            {row.organizzeBalanceCents !== null
                              ? ` · restante ${formatBRL(row.organizzeBalanceCents)}`
                              : ''}
                          </span>
                        ) : null}
                        {row.invoiceDueDate ? (
                          <span>
                            Venc. Oz {formatInvoiceDate(row.invoiceDueDate)}
                          </span>
                        ) : null}
                        {row.pluggyBillDueDate ? (
                          <span>
                            Venc. OF {formatInvoiceDate(row.pluggyBillDueDate)}
                          </span>
                        ) : null}
                        {row.pluggyBillCloseDate ? (
                          <span>
                            Fecha OF{' '}
                            {formatInvoiceDate(row.pluggyBillCloseDate)}
                          </span>
                        ) : null}
                        {row.pluggyMinimumPaymentCents ? (
                          <span>
                            Mín. OF {formatBRL(row.pluggyMinimumPaymentCents)}
                          </span>
                        ) : null}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          ) : null}
        </>
      )}
      </PullToRefresh>

      {adjustRow ? (
        <BottomSheet
          onClose={closeAdjust}
          busy={saving}
          labelledBy="adjust-balance-title"
          title="Ajustar saldo"
          subtitle={`Cria um lançamento pago em “${adjustRow.organizzeAccountName}” para aproximar o saldo do Open Finance.`}
        >
          {saving ? (
            <div className="modal-loading" role="status">
              <span className="spinner lg" aria-hidden />
              <strong>Criando ajuste…</strong>
              <p>Lançamento no Organizze para alinhar o saldo.</p>
            </div>
          ) : null}

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
        </BottomSheet>
      ) : null}

      {adjustInvoiceRow ? (
        <BottomSheet
          onClose={closeAdjust}
          busy={saving}
          labelledBy="adjust-invoice-title"
          title="Ajustar fatura"
          subtitle={`Cria um lançamento no cartão “${adjustInvoiceRow.organizzeCreditCardName}” para alinhar o total da fatura com o Open Finance. Valor negativo = despesa; positivo = crédito.`}
        >
          {saving ? (
            <div className="modal-loading" role="status">
              <span className="spinner lg" aria-hidden />
              <strong>Criando ajuste…</strong>
              <p>Lançamento na fatura do Organizze.</p>
            </div>
          ) : null}

          <div className="settings-form modal-body">
            <div className="create-destination">
              <div className="create-destination-row">
                <span>Fatura OF</span>
                <strong>
                  {adjustInvoiceRow.pluggyBillTotalCents === null
                    ? '—'
                    : formatBRL(adjustInvoiceRow.pluggyBillTotalCents)}
                </strong>
              </div>
              <div className="create-destination-row">
                <span>Fatura Organizze</span>
                <strong>
                  {adjustInvoiceRow.organizzeAmountCents === null
                    ? '—'
                    : formatBRL(adjustInvoiceRow.organizzeAmountCents)}
                </strong>
              </div>
              <div className="create-destination-row">
                <span>Diff (OF − Oz)</span>
                <strong
                  className={
                    (adjustInvoiceRow.diffCents ?? 0) >= 0 ? 'pos' : 'neg'
                  }
                >
                  {adjustInvoiceRow.diffCents === null
                    ? '—'
                    : `${adjustInvoiceRow.diffCents > 0 ? '+' : ''}${formatBRL(adjustInvoiceRow.diffCents)}`}
                </strong>
              </div>
            </div>

            <label>
              Valor do lançamento (R$)
              <input
                value={adjustAmount}
                disabled={saving}
                inputMode="decimal"
                onChange={(event) => setAdjustAmount(event.target.value)}
              />
              <small className="field-hint">
                Prefill = −diff (despesa se a fatura OF for maior).
              </small>
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
                onClick={() => void submitAdjustInvoice()}
              >
                Criar ajuste
              </button>
            </div>
          </div>
        </BottomSheet>
      ) : null}
    </section>
  )
}
