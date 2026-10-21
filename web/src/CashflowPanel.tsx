import { useMemo } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useTheme } from './useTheme'

export type CashflowMonthPoint = {
  monthKey: string
  label: string
  incomeCents: number
  expenseCents: number
  leftoverCents: number
}

export type ReportsCashflowOverviewResponse = {
  generatedAt: string
  selectedMonth: string
  year: number
  months: CashflowMonthPoint[]
  yearTotals: {
    incomeCents: number
    expenseCents: number
    leftoverCents: number
  }
  note: string
}

type Props = {
  data: ReportsCashflowOverviewResponse
  selectedMonth: string
  onSelectMonth: (monthKey: string) => void
}

function formatBRL(amountCents: number): string {
  return (amountCents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
}

function formatCompactBRL(amountCents: number): string {
  const reais = amountCents / 100
  if (Math.abs(reais) >= 1_000_000) {
    return `R$ ${(reais / 1_000_000).toLocaleString('pt-BR', {
      maximumFractionDigits: 1,
    })} mi`
  }
  if (Math.abs(reais) >= 1_000) {
    return `R$ ${(reais / 1_000).toLocaleString('pt-BR', {
      maximumFractionDigits: 1,
    })} mil`
  }
  return formatBRL(amountCents)
}

type ChartRow = {
  monthKey: string
  label: string
  income: number
  expense: number
  leftover: number
  incomeCents: number
  expenseCents: number
  leftoverCents: number
  selected: boolean
}

function MonthTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload: ChartRow }>
}) {
  if (!active || !payload?.[0]) {
    return null
  }
  const row = payload[0].payload
  return (
    <div className="chart-tooltip">
      <strong>{row.label}</strong>
      <span className="pos">Receita {formatBRL(row.incomeCents)}</span>
      <span className="neg">Despesa {formatBRL(row.expenseCents)}</span>
      <span className={row.leftoverCents >= 0 ? 'pos' : 'neg'}>
        Sobra {row.leftoverCents >= 0 ? '+' : ''}
        {formatBRL(row.leftoverCents)}
      </span>
    </div>
  )
}

export function CashflowPanel({
  data,
  selectedMonth,
  onSelectMonth,
}: Props) {
  const { resolved: theme } = useTheme()
  const isDark = theme === 'dark'
  const colors = isDark
    ? {
        income: '#69db7c',
        expense: '#ff8787',
        leftover: '#74c0fc',
        tick: '#9aa19a',
        grid: 'rgba(255, 255, 255, 0.08)',
      }
    : {
        income: '#2f9e44',
        expense: '#e03131',
        leftover: '#1971c2',
        tick: '#868e96',
        grid: 'rgba(0, 0, 0, 0.08)',
      }

  const chartRows = useMemo<ChartRow[]>(
    () =>
      data.months.map((m) => ({
        monthKey: m.monthKey,
        label: m.label,
        income: m.incomeCents / 100,
        expense: m.expenseCents / 100,
        leftover: m.leftoverCents / 100,
        incomeCents: m.incomeCents,
        expenseCents: m.expenseCents,
        leftoverCents: m.leftoverCents,
        selected: m.monthKey === selectedMonth,
      })),
    [data.months, selectedMonth],
  )

  const selected = data.months.find((m) => m.monthKey === selectedMonth)
  const totals = data.yearTotals
  const yearSurplus = totals.leftoverCents >= 0
  const maxBar = Math.max(
    1,
    ...chartRows.flatMap((r) => [r.income, r.expense, Math.abs(r.leftover)]),
  )

  return (
    <div className="cashflow-panel">
      <section className="goals-card">
        <div className="goals-card-head">
          <h2>Ano {data.year}</h2>
        </div>
        <div className="goals-stat-grid">
          <div>
            <span>Recebido</span>
            <strong className="pos">{formatBRL(totals.incomeCents)}</strong>
            <small>Receita no ano</small>
          </div>
          <div>
            <span>Gasto</span>
            <strong className="neg">{formatBRL(totals.expenseCents)}</strong>
            <small>Despesa no ano</small>
          </div>
          <div>
            <span>{yearSurplus ? 'Sobra' : 'Déficit'}</span>
            <strong className={yearSurplus ? 'pos' : 'neg'}>
              {yearSurplus ? '+' : ''}
              {formatBRL(totals.leftoverCents)}
            </strong>
            <small>Diferença no ano</small>
          </div>
        </div>
      </section>

      {selected ? (
        <section className="goals-card">
          <div className="goals-card-head">
            <h2>{selected.label}/{String(data.year).slice(2)}</h2>
          </div>
          <div className="goals-stat-grid goals-stat-grid-compact">
            <div>
              <span>Receita</span>
              <strong className="pos">{formatBRL(selected.incomeCents)}</strong>
            </div>
            <div>
              <span>Despesa</span>
              <strong className="neg">
                {formatBRL(selected.expenseCents)}
              </strong>
            </div>
            <div>
              <span>Sobra</span>
              <strong
                className={selected.leftoverCents >= 0 ? 'pos' : 'neg'}
              >
                {selected.leftoverCents >= 0 ? '+' : ''}
                {formatBRL(selected.leftoverCents)}
              </strong>
            </div>
          </div>
        </section>
      ) : null}

      <section className="goals-card cashflow-chart-card">
        <div className="goals-card-head">
          <h2>Receita × despesa</h2>
        </div>
        <p className="field-hint">Cada mês do ano {data.year}</p>
        <div
          className="cashflow-chart-canvas"
          role="img"
          aria-label={`Receita e despesa de ${data.year}`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartRows}
              margin={{ top: 10, right: 8, left: 0, bottom: 0 }}
              onClick={(state) => {
                const key = state?.activeLabel
                if (typeof key === 'string') {
                  onSelectMonth(key)
                }
              }}
            >
              <CartesianGrid
                stroke={colors.grid}
                vertical={false}
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey="monthKey"
                tickFormatter={(_value: string, index: number) =>
                  chartRows[index]?.label ?? ''
                }
                axisLine={false}
                tickLine={false}
                interval={0}
                tick={{ fill: colors.tick, fontSize: 11 }}
              />
              <YAxis
                domain={[0, maxBar * 1.12]}
                width={58}
                axisLine={false}
                tickLine={false}
                tick={{ fill: colors.tick, fontSize: 11 }}
                tickFormatter={(value: number) =>
                  formatCompactBRL(Math.round(value * 100))
                }
              />
              <Tooltip
                cursor={{ fill: 'rgba(0,0,0,0.04)' }}
                content={<MonthTooltip />}
                wrapperStyle={{ outline: 'none', zIndex: 8 }}
              />
              <Legend
                wrapperStyle={{ fontSize: '0.8rem', paddingTop: 4 }}
                formatter={(value) =>
                  value === 'income' ? 'Receita' : 'Despesa'
                }
              />
              <Bar
                dataKey="income"
                name="income"
                fill={colors.income}
                radius={[4, 4, 0, 0]}
                maxBarSize={22}
              >
                {chartRows.map((row) => (
                  <Cell
                    key={`in-${row.monthKey}`}
                    fill={colors.income}
                    fillOpacity={row.selected ? 1 : 0.72}
                    cursor="pointer"
                  />
                ))}
              </Bar>
              <Bar
                dataKey="expense"
                name="expense"
                fill={colors.expense}
                radius={[4, 4, 0, 0]}
                maxBarSize={22}
              >
                {chartRows.map((row) => (
                  <Cell
                    key={`ex-${row.monthKey}`}
                    fill={colors.expense}
                    fillOpacity={row.selected ? 1 : 0.72}
                    cursor="pointer"
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="goals-card cashflow-chart-card">
        <div className="goals-card-head">
          <h2>Sobra por mês</h2>
        </div>
        <p className="field-hint">Receita − despesa em cada mês</p>
        <div
          className="cashflow-chart-canvas"
          role="img"
          aria-label={`Sobra mensal de ${data.year}`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chartRows}
              margin={{ top: 10, right: 8, left: 0, bottom: 0 }}
              onClick={(state) => {
                const key = state?.activeLabel
                if (typeof key === 'string') {
                  onSelectMonth(key)
                }
              }}
            >
              <CartesianGrid
                stroke={colors.grid}
                vertical={false}
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey="monthKey"
                tickFormatter={(_value: string, index: number) =>
                  chartRows[index]?.label ?? ''
                }
                axisLine={false}
                tickLine={false}
                interval={0}
                tick={{ fill: colors.tick, fontSize: 11 }}
              />
              <YAxis
                width={58}
                axisLine={false}
                tickLine={false}
                tick={{ fill: colors.tick, fontSize: 11 }}
                tickFormatter={(value: number) =>
                  formatCompactBRL(Math.round(value * 100))
                }
              />
              <Tooltip
                cursor={{ stroke: colors.leftover, strokeOpacity: 0.35 }}
                content={<MonthTooltip />}
                wrapperStyle={{ outline: 'none', zIndex: 8 }}
              />
              <Bar dataKey="leftover" maxBarSize={28} radius={[4, 4, 0, 0]}>
                {chartRows.map((row) => (
                  <Cell
                    key={`lf-${row.monthKey}`}
                    fill={
                      row.leftoverCents >= 0 ? colors.income : colors.expense
                    }
                    fillOpacity={row.selected ? 1 : 0.75}
                    cursor="pointer"
                  />
                ))}
              </Bar>
              <Line
                type="monotone"
                dataKey="leftover"
                stroke={colors.leftover}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </section>

      <p className="field-hint">{data.note}</p>
    </div>
  )
}
