import { useMemo, useState } from 'react'
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'

export type InvestmentAllocationSlice = {
  bucket: string
  label: string
  balanceCents: number
  percent: number
}

export type InvestmentConnectionFilter = {
  id: string
  name: string
  imageUrl: string | null
  primaryColor: string | null
  balanceCents: number
}

export type InvestmentMaturityItem = {
  id: string
  name: string
  subtype: string | null
  dueDate: string
  balanceCents: number
  connectionName: string | null
}

export type InvestmentsOverviewResponse = {
  generatedAt: string
  totalBalanceCents: number
  totalProfitCents: number | null
  allocation: InvestmentAllocationSlice[]
  connections: InvestmentConnectionFilter[]
  maturities: InvestmentMaturityItem[]
  nextMaturityDate: string | null
  items: Array<{
    id: string
    connectionId: string | null
    balanceCents: number
    bucket: string
    amountProfitCents: number | null
  }>
}

type Props = {
  data: InvestmentsOverviewResponse
}

const SLICE_COLORS = [
  '#2f9e44',
  '#4c6ef5',
  '#f59f00',
  '#9c36b5',
  '#15aabf',
  '#868e96',
]

function formatBRL(amountCents: number): string {
  return (amountCents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
}

function formatDatePt(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('pt-BR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function formatMonthYearPt(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('pt-BR', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
  return label.replace('.', '')
}

type ChartSlice = InvestmentAllocationSlice & {
  value: number
  color: string
}

function AllocationTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload: ChartSlice }>
}) {
  if (!active || !payload?.[0]) {
    return null
  }
  const slice = payload[0].payload
  return (
    <div className="chart-tooltip">
      <strong>{slice.label}</strong>
      <span>
        {formatBRL(slice.balanceCents)} ·{' '}
        {slice.percent.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%
      </span>
    </div>
  )
}

export function InvestmentsPanel({ data }: Props) {
  const [connectionId, setConnectionId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    if (!connectionId) {
      return data
    }
    const items = data.items.filter((item) => item.connectionId === connectionId)
    const totalBalanceCents = items.reduce(
      (sum, item) => sum + item.balanceCents,
      0,
    )
    const byBucket = new Map<string, number>()
    for (const item of items) {
      byBucket.set(
        item.bucket,
        (byBucket.get(item.bucket) ?? 0) + item.balanceCents,
      )
    }
    const allocation = data.allocation
      .map((slice) => {
        const balanceCents = byBucket.get(slice.bucket) ?? 0
        return {
          ...slice,
          balanceCents,
          percent:
            totalBalanceCents > 0
              ? Math.round((balanceCents / totalBalanceCents) * 1000) / 10
              : 0,
        }
      })
      .filter((slice) => slice.balanceCents > 0)

    const maturities = data.maturities.filter((item) => {
      const match = data.items.find((entry) => entry.id === item.id)
      return match?.connectionId === connectionId
    })

    let profitSum = 0
    let profitCount = 0
    for (const item of items) {
      if (item.amountProfitCents != null) {
        profitSum += item.amountProfitCents
        profitCount += 1
      }
    }

    return {
      ...data,
      totalBalanceCents,
      totalProfitCents: profitCount > 0 ? profitSum : null,
      allocation:
        allocation.length > 0
          ? allocation
          : [{ bucket: 'other', label: 'Outros', balanceCents: 0, percent: 0 }],
      maturities,
      nextMaturityDate: maturities[0]?.dueDate ?? null,
    }
  }, [connectionId, data])

  const chartData: ChartSlice[] = useMemo(
    () =>
      filtered.allocation.map((slice, index) => ({
        ...slice,
        value: Math.max(slice.balanceCents, 0),
        color: SLICE_COLORS[index % SLICE_COLORS.length],
      })),
    [filtered.allocation],
  )

  const hasSlices = chartData.some((slice) => slice.value > 0)

  return (
    <div className="dash-section">
      <div className="dash-pills" role="tablist" aria-label="Instituições">
        <button
          type="button"
          className={`dash-pill ${connectionId === null ? 'active' : ''}`}
          onClick={() => setConnectionId(null)}
        >
          Todos
        </button>
        {data.connections.map((connection) => (
          <button
            key={connection.id}
            type="button"
            className={`dash-pill ${connectionId === connection.id ? 'active' : ''}`}
            onClick={() => setConnectionId(connection.id)}
          >
            {connection.imageUrl ? (
              <img src={connection.imageUrl} alt="" width={18} height={18} />
            ) : null}
            <span>{connection.name}</span>
          </button>
        ))}
      </div>

      <section className="dash-card">
        <div className="invest-hero">
          <div className="invest-donut-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={
                    hasSlices
                      ? chartData
                      : [{ label: 'Vazio', value: 1, color: '#dee2e6' }]
                  }
                  dataKey="value"
                  nameKey="label"
                  innerRadius="62%"
                  outerRadius="88%"
                  paddingAngle={hasSlices ? 2 : 0}
                  stroke="none"
                  isAnimationActive
                >
                  {(hasSlices
                    ? chartData
                    : [{ color: '#dee2e6' }]
                  ).map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                {hasSlices ? <Tooltip content={<AllocationTooltip />} /> : null}
              </PieChart>
            </ResponsiveContainer>
            <div className="invest-donut-center">
              <span>Patrimônio</span>
              <strong>{formatBRL(filtered.totalBalanceCents)}</strong>
              {filtered.totalProfitCents != null ? (
                <em
                  className={
                    filtered.totalProfitCents >= 0 ? 'positive' : 'negative'
                  }
                >
                  {filtered.totalProfitCents >= 0 ? '+' : ''}
                  {formatBRL(filtered.totalProfitCents)} resultado
                </em>
              ) : null}
            </div>
          </div>
        </div>

        <ul className="invest-allocation">
          {filtered.allocation.map((slice, index) => (
            <li key={slice.bucket}>
              <span
                className="alloc-dot"
                style={{
                  background: SLICE_COLORS[index % SLICE_COLORS.length],
                }}
              />
              <span className="alloc-label">{slice.label}</span>
              <span className="alloc-pct">
                {slice.percent.toLocaleString('pt-BR', {
                  maximumFractionDigits: 1,
                })}
                %
              </span>
              <span className="alloc-value">
                {formatBRL(slice.balanceCents)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="dash-card">
        <div className="dash-card-head">
          <h2>Vencimentos</h2>
          {filtered.nextMaturityDate ? (
            <span className="dash-chip warn">
              próximo: {formatMonthYearPt(filtered.nextMaturityDate)}
            </span>
          ) : null}
        </div>
        {filtered.maturities.length === 0 ? (
          <p className="dash-empty">Nenhum vencimento de renda fixa.</p>
        ) : (
          <ul className="maturity-list">
            {filtered.maturities.map((item) => (
              <li key={item.id}>
                <span className="maturity-icon" aria-hidden />
                <div>
                  <strong>
                    {item.subtype?.replace(/_/g, ' ') || item.name}
                  </strong>
                  <span>{formatDatePt(item.dueDate)}</span>
                </div>
                <em>{formatBRL(item.balanceCents)}</em>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
