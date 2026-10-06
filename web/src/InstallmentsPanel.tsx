import { useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { BottomSheet } from './BottomSheet'
import { useTheme } from './useTheme'

export type InstallmentScheduleEntry = {
  date: string
  monthKey: string
  installment: number
  totalInstallments: number
  amountCents: number
  paid: boolean
  status: 'paga' | 'nesta_fatura' | 'pendente'
  transactionId: number
}

export type InstallmentPurchase = {
  id: string
  ignoreKey: string
  ignored: boolean
  description: string
  creditCardId: number
  creditCardName: string
  installmentAmountCents: number
  totalAmountCents: number
  remainingCents: number
  paidCount: number
  totalInstallments: number
  currentInstallment: number
  purchaseMonthKey: string | null
  endsMonthKey: string | null
  schedule: InstallmentScheduleEntry[]
}

export type InstallmentNextPayoff = {
  purchaseId: string
  description: string
  reliefCentsPerMonth: number
  endsMonthKey: string
  paymentMonthKey: string
  reliefMonthKey: string
}

export type InstallmentMonthDetail = {
  monthKey: string
  monthLabel: string
  focusPaymentMonth: string
  focusPaymentMonthLabel: string
  committedThisMonthCents: number
  activePurchaseCount: number
  ignoredPurchaseCount: number
  purchases: InstallmentPurchase[]
  ignoredPurchases: InstallmentPurchase[]
  payoffsThisMonth: InstallmentNextPayoff[]
}

export type InstallmentsOverviewResponse = {
  generatedAt: string
  chartAnchorMonth: string
  selectedMonth: string
  monthlyBars: Array<{
    monthKey: string
    label: string
    amountCents: number
  }>
  months: Record<string, InstallmentMonthDetail>
}

type Props = {
  data: InstallmentsOverviewResponse
  selectedMonth: string
  loading?: boolean
  onSelectMonth: (monthKey: string) => void
  onIgnorePurchase: (ignoreKey: string) => Promise<void>
  onUnignorePurchase: (ignoreKey: string) => Promise<void>
}

function formatBRL(amountCents: number): string {
  return (amountCents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
}

function formatBarLabel(reais: number): string {
  if (!Number.isFinite(reais) || reais <= 0) {
    return ''
  }
  if (reais >= 1000) {
    return `${(reais / 1000).toLocaleString('pt-BR', {
      maximumFractionDigits: 1,
    })} mil`
  }
  return reais.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  })
}

function formatMonthYearLong(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('pt-BR', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function truncateLabel(value: string, max = 28): string {
  const trimmed = value.trim()
  if (trimmed.length <= max) {
    return trimmed
  }
  return `${trimmed.slice(0, max - 1)}…`
}

function ProgressRing({
  paid,
  total,
  size = 44,
}: {
  paid: number
  total: number
  size?: number
}) {
  const percent = total > 0 ? Math.round((paid / total) * 100) : 0
  const chartData = [{ name: 'progress', value: percent, fill: '#2f9e44' }]
  return (
    <div className="parc-ring-wrap" style={{ width: size, height: size }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart
          cx="50%"
          cy="50%"
          innerRadius="72%"
          outerRadius="100%"
          data={chartData}
          startAngle={90}
          endAngle={-270}
        >
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          <RadialBar
            dataKey="value"
            background={{ fill: '#e9ecef' }}
            cornerRadius={8}
            isAnimationActive
          />
        </RadialBarChart>
      </ResponsiveContainer>
    </div>
  )
}

function MonthBarTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{
    payload: { label: string; amountCents: number; focus: boolean }
  }>
}) {
  if (!active || !payload?.[0]) {
    return null
  }
  const bar = payload[0].payload
  return (
    <div className="chart-tooltip">
      <strong>{bar.label}</strong>
      <span>{formatBRL(bar.amountCents)}</span>
    </div>
  )
}

export function InstallmentsPanel({
  data,
  selectedMonth,
  loading = false,
  onSelectMonth,
  onIgnorePurchase,
  onUnignorePurchase,
}: Props) {
  const { resolved: theme } = useTheme()
  const isDark = theme === 'dark'
  const chartColors = isDark
    ? {
        focus: '#5c7cfa',
        idle: '#3a4254',
        tick: '#9aa19a',
        label: '#c5cbc3',
        cursor: 'rgba(92, 124, 250, 0.12)',
      }
    : {
        focus: '#4c6ef5',
        idle: '#bac8ff',
        tick: '#868e96',
        label: '#495057',
        cursor: 'rgba(76, 110, 245, 0.08)',
      }
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showIgnored, setShowIgnored] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const month =
    data.months[selectedMonth] ?? data.months[data.chartAnchorMonth] ?? null

  const barData = useMemo(
    () =>
      data.monthlyBars.map((bar) => ({
        ...bar,
        value: bar.amountCents / 100,
        focus: bar.monthKey === selectedMonth,
      })),
    [data.monthlyBars, selectedMonth],
  )

  const purchases = useMemo(() => {
    if (!month) {
      return []
    }
    const q = query.trim().toLowerCase()
    if (!q) {
      return month.purchases
    }
    return month.purchases.filter((purchase) =>
      purchase.description.toLowerCase().includes(q),
    )
  }, [month, query])

  const ignoredPurchases = month?.ignoredPurchases ?? []
  const selected =
    month?.purchases.find((purchase) => purchase.id === selectedId) ??
    ignoredPurchases.find((purchase) => purchase.id === selectedId) ??
    null
  const payoffsThisMonth = month?.payoffsThisMonth ?? []

  async function handleIgnore(ignoreKey: string) {
    setBusyKey(ignoreKey)
    try {
      await onIgnorePurchase(ignoreKey)
      setSelectedId(null)
    } finally {
      setBusyKey(null)
    }
  }

  async function handleUnignore(ignoreKey: string) {
    setBusyKey(ignoreKey)
    try {
      await onUnignorePurchase(ignoreKey)
    } finally {
      setBusyKey(null)
    }
  }

  if (!month) {
    return (
      <div className="dash-section">
        <p className="dash-empty">Sem dados para este mês.</p>
      </div>
    )
  }

  return (
    <div className={`dash-section${loading ? ' is-loading' : ''}`}>
      <section className="dash-card parc-summary">
        <p className="parc-kicker">Comprometido em {month.monthLabel}</p>
        <p className="parc-total">
          {formatBRL(month.committedThisMonthCents)}
        </p>
        <p className="parc-sub">
          {month.activePurchaseCount} compras parceladas ativas · soma das
          parcelas que caem em {month.monthLabel}
          {month.ignoredPurchaseCount > 0
            ? ` · ${month.ignoredPurchaseCount} ignorada${month.ignoredPurchaseCount === 1 ? '' : 's'}`
            : ''}
        </p>

        <div className="parc-chart">
          <ResponsiveContainer width="100%" height={160}>
            <BarChart
              data={barData}
              margin={{ top: 24, right: 4, left: 4, bottom: 0 }}
            >
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{ fill: chartColors.tick, fontSize: 12 }}
              />
              <YAxis hide domain={[0, 'auto']} />
              <Tooltip
                cursor={{ fill: chartColors.cursor }}
                content={<MonthBarTooltip />}
              />
              <Bar dataKey="value" radius={[8, 8, 4, 4]} maxBarSize={36}>
                {barData.map((entry) => (
                  <Cell
                    key={entry.monthKey}
                    fill={entry.focus ? chartColors.focus : chartColors.idle}
                    cursor="pointer"
                    onClick={() => onSelectMonth(entry.monthKey)}
                  />
                ))}
                <LabelList
                  dataKey="value"
                  position="top"
                  formatter={(value) =>
                    formatBarLabel(
                      typeof value === 'number' ? value : Number(value),
                    )
                  }
                  style={{
                    fill: chartColors.label,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {payoffsThisMonth.length > 0 ? (
          <div className="parc-quitting">
            <div className="parc-quitting-head">
              <span>Quitando em {month.monthLabel}</span>
              <em>
                −
                {formatBRL(
                  payoffsThisMonth.reduce(
                    (sum, item) => sum + item.reliefCentsPerMonth,
                    0,
                  ),
                )}
                /mês
              </em>
            </div>
            <ul>
              {payoffsThisMonth.map((item) => (
                <li key={item.purchaseId}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(item.purchaseId)}
                  >
                    <span>{truncateLabel(item.description, 34)}</span>
                    <strong>−{formatBRL(item.reliefCentsPerMonth)}</strong>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <label className="parc-search">
        <span className="sr-only">Buscar compra</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar compra…"
        />
      </label>

      {purchases.length === 0 ? (
        <p className="dash-empty">Nenhuma compra parcelada ativa.</p>
      ) : (
        <ul className="parc-list">
          {purchases.map((purchase) => (
            <li key={purchase.id}>
              <button
                type="button"
                className="parc-row"
                onClick={() => setSelectedId(purchase.id)}
              >
                <ProgressRing
                  paid={purchase.paidCount}
                  total={purchase.totalInstallments}
                />
                <div className="parc-row-main">
                  <strong>{purchase.description}</strong>
                  <span>
                    {purchase.currentInstallment} de{' '}
                    {purchase.totalInstallments}
                  </span>
                </div>
                <div className="parc-row-money">
                  <strong>{formatBRL(purchase.installmentAmountCents)}</strong>
                  <span>total {formatBRL(purchase.totalAmountCents)}</span>
                </div>
                <span className="parc-chevron" aria-hidden>
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {month.ignoredPurchaseCount > 0 ? (
        <div className="parc-ignored-block">
          <button
            type="button"
            className="parc-ignored-toggle"
            onClick={() => setShowIgnored((value) => !value)}
          >
            {showIgnored ? 'Ocultar' : 'Mostrar'} ignoradas (
            {month.ignoredPurchaseCount})
          </button>
          {showIgnored ? (
            <ul className="parc-list parc-list-ignored">
              {ignoredPurchases.map((purchase) => (
                <li key={purchase.id}>
                  <div className="parc-row parc-row-ignored">
                    <ProgressRing
                      paid={purchase.paidCount}
                      total={purchase.totalInstallments}
                    />
                    <button
                      type="button"
                      className="parc-row-main parc-row-main-btn"
                      onClick={() => setSelectedId(purchase.id)}
                    >
                      <strong>{purchase.description}</strong>
                      <span>
                        {purchase.currentInstallment} de{' '}
                        {purchase.totalInstallments}
                      </span>
                    </button>
                    <div className="parc-row-money">
                      <strong>
                        {formatBRL(purchase.installmentAmountCents)}
                      </strong>
                      <button
                        type="button"
                        className="parc-restore-btn"
                        disabled={busyKey === purchase.ignoreKey || loading}
                        onClick={() => void handleUnignore(purchase.ignoreKey)}
                      >
                        Restaurar
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {selected ? (
        <BottomSheet
          onClose={() => setSelectedId(null)}
          labelledBy="parc-sheet-title"
          header={
            <>
              <h2 id="parc-sheet-title">{selected.description}</h2>
              <p>
                {selected.creditCardName}
                {selected.purchaseMonthKey
                  ? ` · compra de ${formatMonthYearLong(selected.purchaseMonthKey)}`
                  : ''}
              </p>
            </>
          }
        >
          <div className="parc-sheet-actions">
            {selected.ignored ? (
              <button
                type="button"
                className="parc-sheet-action"
                disabled={busyKey === selected.ignoreKey || loading}
                onClick={() => void handleUnignore(selected.ignoreKey)}
              >
                Restaurar no relatório
              </button>
            ) : (
              <button
                type="button"
                className="parc-sheet-action"
                disabled={busyKey === selected.ignoreKey || loading}
                onClick={() => void handleIgnore(selected.ignoreKey)}
              >
                Ignorar no relatório
              </button>
            )}
          </div>

          <div className="parc-sheet-progress">
            <ProgressRing
              paid={selected.paidCount}
              total={selected.totalInstallments}
              size={64}
            />
            <div>
              <strong>
                {selected.paidCount} de {selected.totalInstallments} pagas
              </strong>
              {selected.endsMonthKey ? (
                <span>
                  termina na fatura de{' '}
                  {formatMonthYearLong(selected.endsMonthKey)}
                </span>
              ) : null}
            </div>
          </div>

          <div className="parc-sheet-stats">
            <div>
              <span>por parcela</span>
              <strong>{formatBRL(selected.installmentAmountCents)}</strong>
            </div>
            <div>
              <span>restante</span>
              <strong>{formatBRL(selected.remainingCents)}</strong>
            </div>
            <div>
              <span>total da compra</span>
              <strong>{formatBRL(selected.totalAmountCents)}</strong>
            </div>
          </div>

          <h3 className="parc-sheet-section">
            Parcelas · {selected.paidCount} pagas · restam{' '}
            {selected.totalInstallments - selected.paidCount}
          </h3>
          <ul className="parc-schedule">
            {selected.schedule.map((entry) => (
              <li key={entry.transactionId} className={entry.status}>
                <span className="sched-mark" aria-hidden>
                  {entry.status === 'paga'
                    ? '✓'
                    : entry.status === 'nesta_fatura'
                      ? '◷'
                      : '○'}
                </span>
                <div>
                  <strong>{formatMonthYearLong(entry.monthKey)}</strong>
                  <span>
                    {entry.installment} de {entry.totalInstallments}
                  </span>
                </div>
                <em>
                  {entry.status === 'paga'
                    ? 'paga'
                    : entry.status === 'nesta_fatura'
                      ? 'nesta fatura'
                      : 'pendente'}
                </em>
                <strong>{formatBRL(Math.abs(entry.amountCents))}</strong>
              </li>
            ))}
          </ul>
        </BottomSheet>
      ) : null}
    </div>
  )
}
