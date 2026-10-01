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

export type InstallmentsOverviewResponse = {
  generatedAt: string
  focusMonth: string
  focusMonthLabel: string
  focusPaymentMonth: string
  focusPaymentMonthLabel: string
  committedThisMonthCents: number
  activePurchaseCount: number
  monthlyBars: Array<{
    monthKey: string
    label: string
    amountCents: number
  }>
  nextPayoff: {
    purchaseId: string
    description: string
    reliefCentsPerMonth: number
    endsMonthKey: string
    paymentMonthKey: string
    reliefMonthKey: string
  } | null
  payoffsThisMonth: Array<{
    purchaseId: string
    description: string
    reliefCentsPerMonth: number
    endsMonthKey: string
    paymentMonthKey: string
    reliefMonthKey: string
  }>
  purchases: InstallmentPurchase[]
}

type Props = {
  data: InstallmentsOverviewResponse
  loading?: boolean
  onFocusMonthChange: (monthKey: string) => void
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

function formatMonthLong(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('pt-BR', {
    month: 'long',
    timeZone: 'UTC',
  })
}

function currentMonthKeySaoPaulo(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
  })
    .format(new Date())
    .slice(0, 7)
}

function shiftMonthKey(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split('-').map(Number)
  const absolute = y * 12 + (m - 1) + delta
  const ny = Math.floor(absolute / 12)
  const nm = (absolute % 12) + 1
  return `${ny}-${String(nm).padStart(2, '0')}`
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
  loading = false,
  onFocusMonthChange,
}: Props) {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hiddenIds, setHiddenIds] = useState<string[]>([])
  const [showIgnored, setShowIgnored] = useState(false)

  const hiddenSet = useMemo(() => new Set(hiddenIds), [hiddenIds])

  const visiblePurchases = useMemo(
    () => data.purchases.filter((purchase) => !hiddenSet.has(purchase.id)),
    [data.purchases, hiddenSet],
  )

  const ignoredPurchases = useMemo(
    () => data.purchases.filter((purchase) => hiddenSet.has(purchase.id)),
    [data.purchases, hiddenSet],
  )

  const committedThisMonthCents = useMemo(() => {
    let sum = 0
    for (const purchase of visiblePurchases) {
      for (const entry of purchase.schedule) {
        if (entry.monthKey === data.focusMonth) {
          sum += Math.abs(entry.amountCents)
        }
      }
    }
    return sum
  }, [visiblePurchases, data.focusMonth])

  const barData = useMemo(() => {
    return data.monthlyBars.map((bar) => {
      let amountCents = 0
      for (const purchase of visiblePurchases) {
        for (const entry of purchase.schedule) {
          if (entry.monthKey === bar.monthKey) {
            amountCents += Math.abs(entry.amountCents)
          }
        }
      }
      return {
        ...bar,
        amountCents,
        value: amountCents / 100,
        focus: bar.monthKey === data.focusMonth,
      }
    })
  }, [data.monthlyBars, data.focusMonth, visiblePurchases])

  const payoffsThisMonth = useMemo(() => {
    return visiblePurchases
      .filter((purchase) => purchase.endsMonthKey === data.focusMonth)
      .map((purchase) => {
        const endsMonthKey = purchase.endsMonthKey as string
        const paymentMonthKey = shiftMonthKey(endsMonthKey, 1)
        return {
          purchaseId: purchase.id,
          description: purchase.description,
          reliefCentsPerMonth: purchase.installmentAmountCents,
          endsMonthKey,
          paymentMonthKey,
          reliefMonthKey: shiftMonthKey(paymentMonthKey, 1),
        }
      })
      .sort((a, b) => b.reliefCentsPerMonth - a.reliefCentsPerMonth)
  }, [visiblePurchases, data.focusMonth])

  const nextPayoff = useMemo(() => {
    if (data.focusMonth !== currentMonthKeySaoPaulo()) {
      return null
    }
    const upcoming = [...visiblePurchases]
      .filter(
        (purchase) =>
          typeof purchase.endsMonthKey === 'string' &&
          purchase.endsMonthKey >= data.focusMonth,
      )
      .map((purchase) => {
        const endsMonthKey = purchase.endsMonthKey as string
        const paymentMonthKey = shiftMonthKey(endsMonthKey, 1)
        return {
          purchaseId: purchase.id,
          description: purchase.description,
          reliefCentsPerMonth: purchase.installmentAmountCents,
          endsMonthKey,
          paymentMonthKey,
          reliefMonthKey: shiftMonthKey(paymentMonthKey, 1),
        }
      })
      .sort((a, b) => {
        const byPay = a.paymentMonthKey.localeCompare(b.paymentMonthKey)
        if (byPay !== 0) {
          return byPay
        }
        return b.reliefCentsPerMonth - a.reliefCentsPerMonth
      })
    return upcoming[0] ?? null
  }, [visiblePurchases, data.focusMonth])

  const filteredVisible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      return visiblePurchases
    }
    return visiblePurchases.filter((purchase) =>
      purchase.description.toLowerCase().includes(q),
    )
  }, [visiblePurchases, query])

  const selected =
    data.purchases.find((purchase) => purchase.id === selectedId) ?? null

  function hidePurchase(id: string) {
    setHiddenIds((current) =>
      current.includes(id) ? current : [...current, id],
    )
    setSelectedId(null)
  }

  function restorePurchase(id: string) {
    setHiddenIds((current) => current.filter((item) => item !== id))
  }

  return (
    <div className={`dash-section${loading ? ' is-loading' : ''}`}>
      <section className="dash-card parc-summary">
        <p className="parc-kicker">
          Comprometido em {data.focusMonthLabel}
        </p>
        <p className="parc-total">{formatBRL(committedThisMonthCents)}</p>
        <p className="parc-sub">
          {visiblePurchases.length} compras parceladas ativas · soma das
          parcelas que caem em {data.focusMonthLabel}
          {ignoredPurchases.length > 0
            ? ` · ${ignoredPurchases.length} ignorada${ignoredPurchases.length === 1 ? '' : 's'}`
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
                tick={{ fill: '#868e96', fontSize: 12 }}
              />
              <YAxis hide domain={[0, 'auto']} />
              <Tooltip
                cursor={{ fill: 'rgba(76, 110, 245, 0.08)' }}
                content={<MonthBarTooltip />}
              />
              <Bar dataKey="value" radius={[8, 8, 4, 4]} maxBarSize={36}>
                {barData.map((entry) => (
                  <Cell
                    key={entry.monthKey}
                    fill={entry.focus ? '#4c6ef5' : '#bac8ff'}
                    cursor="pointer"
                    onClick={() => onFocusMonthChange(entry.monthKey)}
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
                    fill: '#495057',
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {nextPayoff ? (
          <div className="parc-payoff">
            <div className="parc-payoff-icon" aria-hidden>
              <span />
            </div>
            <div className="parc-payoff-body">
              <span className="parc-payoff-label">
                Próxima quitação ·{' '}
                {formatMonthLong(nextPayoff.paymentMonthKey)}
              </span>
              <strong className="parc-payoff-relief">
                −{formatBRL(nextPayoff.reliefCentsPerMonth)}
                <span> /mês</span>
              </strong>
              <p className="parc-payoff-desc">
                <button
                  type="button"
                  className="parc-payoff-link"
                  onClick={() => setSelectedId(nextPayoff.purchaseId)}
                >
                  {truncateLabel(nextPayoff.description)}
                </button>
                <span>
                  {' '}
                  · alívio a partir de{' '}
                  {formatMonthLong(nextPayoff.reliefMonthKey)}
                </span>
              </p>
            </div>
          </div>
        ) : null}

        {payoffsThisMonth.length > 0 ? (
          <div className="parc-quitting">
            <div className="parc-quitting-head">
              <span>Quitando em {data.focusMonthLabel}</span>
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

      {filteredVisible.length === 0 ? (
        <p className="dash-empty">Nenhuma compra parcelada ativa.</p>
      ) : (
        <ul className="parc-list">
          {filteredVisible.map((purchase) => (
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

      {ignoredPurchases.length > 0 ? (
        <div className="parc-ignored-block">
          <button
            type="button"
            className="parc-ignored-toggle"
            onClick={() => setShowIgnored((value) => !value)}
          >
            {showIgnored ? 'Ocultar' : 'Mostrar'} ignoradas (
            {ignoredPurchases.length})
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
                        onClick={() => restorePurchase(purchase.id)}
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
        <div
          className="parc-sheet-backdrop"
          role="presentation"
          onClick={() => setSelectedId(null)}
        >
          <div
            className="parc-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={selected.description}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="parc-sheet-grab" />
            <header className="parc-sheet-head">
              <div>
                <h2>{selected.description}</h2>
                <p>
                  {selected.creditCardName}
                  {selected.purchaseMonthKey
                    ? ` · compra de ${formatMonthYearLong(selected.purchaseMonthKey)}`
                    : ''}
                </p>
              </div>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setSelectedId(null)}
              >
                Fechar
              </button>
            </header>

            <div className="parc-sheet-actions">
              {hiddenSet.has(selected.id) ? (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => restorePurchase(selected.id)}
                >
                  Restaurar no relatório
                </button>
              ) : (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => hidePurchase(selected.id)}
                >
                  Ignorar nesta visualização
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
          </div>
        </div>
      ) : null}
    </div>
  )
}
