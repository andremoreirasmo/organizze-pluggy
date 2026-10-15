import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { BottomSheet } from './BottomSheet'
import { ConfirmDialog } from './ConfirmDialog'
import { PullToRefresh } from './PullToRefresh'
import {
  monthParamForUrl,
  patchSearchParams,
  readMonthParam,
  resolveYearMonth,
  ROUTES,
} from './routes'
import { useTheme } from './useTheme'

type ApiFetch = <T>(path: string, init?: RequestInit) => Promise<T>

type Props = {
  apiFetch: ApiFetch
  onError: (message: string | null) => void
}

type PeriodSavings = {
  incomePaidCents: number
  incomePlannedCents: number
  consumptionPaidCents: number
  investmentContribPaidCents: number
  savedCents: number
  savedPct: number | null
  targetMinCents: number
  targetPrimaryCents: number
  targetIdealCents: number
  gapPrimaryCents: number
}

type GoalProgress = {
  id: string
  name: string
  targetCents: number
  allocatedCents: number
  remainingCents: number
  progressPct: number
  targetDate: string | null
  priority: number
  monthlyContributionCents: number | null
  monthlyContributionPct: number | null
  status: 'ACTIVE' | 'COMPLETED' | 'PAUSED'
  pace: 'ahead' | 'on_track' | 'behind' | 'no_date' | 'done'
  estimatedMonth: string | null
  monthsRemaining: number | null
  requiredMonthlyCents: number | null
}

type ProjectionPoint = {
  monthKey: string
  netCents: number
  wealthCents: number
  allocatedCents: number
  availableCents: number
}

type GoalsSettings = {
  minPct: number
  primaryPct: number
  idealPct: number
  investmentCategoryIds: number[]
  estimatedUsdBrl: number | null
}

type GoalsOverview = {
  monthKey: string
  year: number
  settings: GoalsSettings
  month: PeriodSavings
  yearToDate: PeriodSavings
  netWorthCents: number
  bankBalanceCents: number
  totalAllocatedCents: number
  availableCents: number
  goals: GoalProgress[]
  projection: ProjectionPoint[]
  alerts: string[]
  averageMonthlySpareCents: number
  avgMonthlyIncomeCents: number
  plannedMonthlySaveCents: number
  weeklySaveTargetCents: number
  spendableCents: number
  paceBufferCents: number
  paceBufferSavedPct: number | null
  paceBufferWindowMonths: number
  projectionNote: string
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

const GOALS_HIDE_AMOUNTS_KEY = 'goals.hideAmounts'
const HIDDEN_MONEY = 'R$ •••'

function formatBRL(amountCents: number): string {
  return (amountCents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
}

/** Display money, or a mask when privacy mode is on. */
function money(amountCents: number, hideAmounts: boolean): string {
  return hideAmounts ? HIDDEN_MONEY : formatBRL(amountCents)
}

function readHideAmounts(): boolean {
  try {
    return localStorage.getItem(GOALS_HIDE_AMOUNTS_KEY) === '1'
  } catch {
    return false
  }
}

function writeHideAmounts(hide: boolean): void {
  try {
    localStorage.setItem(GOALS_HIDE_AMOUNTS_KEY, hide ? '1' : '0')
  } catch {
    // ignore
  }
}

function formatMonthTitle(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function shiftMonth(yearMonth: string, delta: number): string {
  const [y, m] = yearMonth.split('-').map(Number)
  const abs = y * 12 + (m - 1) + delta
  const ny = Math.floor(abs / 12)
  const nm = (abs % 12) + 1
  return `${ny}-${String(nm).padStart(2, '0')}`
}

function parseUnsignedBRLInputToCents(value: string): number | null {
  const digits = value.replace(/\D/g, '')
  if (!digits) {
    return null
  }
  const cents = Number(digits)
  if (!Number.isFinite(cents) || cents < 0) {
    return null
  }
  return cents
}

function parseSignedBRLInputToCents(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  const negative = trimmed.startsWith('-')
  const digits = trimmed.replace(/\D/g, '')
  if (!digits) {
    return null
  }
  const cents = Number(digits)
  if (!Number.isFinite(cents)) {
    return null
  }
  return negative ? -cents : cents
}

/** Digits-as-cents mask: 5000000 → "50.000,00". */
function formatBrlInputFromDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '')
  if (!digits) {
    return ''
  }
  const cents = Number(digits)
  if (!Number.isFinite(cents)) {
    return ''
  }
  return (cents / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function centsToBrlInput(cents: number): string {
  return formatBrlInputFromDigits(String(Math.max(0, Math.round(cents))))
}

function formatSignedBrlInputFromDigits(raw: string): string {
  const trimmed = raw.trim()
  const negative =
    trimmed.startsWith('-') || (trimmed.includes('-') && !trimmed.endsWith('-'))
  const formatted = formatBrlInputFromDigits(raw)
  if (!formatted) {
    return trimmed === '-' ? '-' : ''
  }
  return negative ? `-${formatted}` : formatted
}

function paceLabel(pace: GoalProgress['pace']): string {
  switch (pace) {
    case 'ahead':
      return 'Ritmo folgado'
    case 'on_track':
      return 'No ritmo'
    case 'behind':
      return 'Abaixo do ritmo'
    case 'done':
      return 'Concluído'
    default:
      return 'Sem data-alvo'
  }
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

function formatMonthShort(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number)
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('pt-BR', {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  })
  return label.replace(' de ', '/').replace('.', '')
}

function paceReason(
  goal: GoalProgress,
  plannedMonthlySaveCents: number,
  hideAmounts: boolean,
): string {
  if (goal.pace === 'done') {
    return 'Meta concluída'
  }
  if (goal.requiredMonthlyCents == null) {
    return goal.estimatedMonth
      ? `Previsão ${formatMonthShort(goal.estimatedMonth)}`
      : 'Sem data-alvo'
  }
  const req = goal.requiredMonthlyCents
  if (hideAmounts) {
    return goal.estimatedMonth
      ? `Previsão ${formatMonthShort(goal.estimatedMonth)}`
      : plannedMonthlySaveCents >= req
        ? 'No ritmo do necessário/mês'
        : 'Abaixo do necessário/mês'
  }
  if (plannedMonthlySaveCents >= req) {
    return `Planejado ${formatBRL(plannedMonthlySaveCents)}/mês ≥ ${formatBRL(req)} necessários`
  }
  if (goal.estimatedMonth) {
    return `Previsão ${formatMonthShort(goal.estimatedMonth)} com ${formatBRL(plannedMonthlySaveCents)}/mês`
  }
  return `Precisa ${formatBRL(req)}/mês · planejado ${formatBRL(plannedMonthlySaveCents)}`
}

type ProjectionChartRow = {
  monthKey: string
  label: string
  wealth: number
  wealthCents: number
  netCents: number
  availableCents: number
}

function ProjectionTooltip({
  active,
  payload,
  hideAmounts = false,
}: {
  active?: boolean
  payload?: Array<{ payload: ProjectionChartRow }>
  hideAmounts?: boolean
}) {
  if (!active || !payload?.[0]) {
    return null
  }
  const row = payload[0].payload
  return (
    <div className="chart-tooltip">
      <strong>{row.label}</strong>
      <span>Patrimônio {money(row.wealthCents, hideAmounts)}</span>
      {row.netCents !== 0 ? (
        <span className={row.netCents >= 0 ? 'pos' : 'neg'}>
          {row.netCents >= 0 ? '+' : ''}
          {money(row.netCents, hideAmounts)} no mês
        </span>
      ) : (
        <span>Ponto de partida</span>
      )}
      <span>Livre {money(row.availableCents, hideAmounts)}</span>
    </div>
  )
}

function ProjectionChart({
  points,
  targetMonthKey,
  hideAmounts,
}: {
  points: ProjectionPoint[]
  targetMonthKey?: string | null
  hideAmounts: boolean
}) {
  const { resolved: theme } = useTheme()
  const isDark = theme === 'dark'
  const colors = isDark
    ? {
        line: '#69db7c',
        fill: 'rgba(105, 219, 124, 0.18)',
        tick: '#9aa19a',
        grid: 'rgba(255, 255, 255, 0.08)',
        target: '#ff6b6b',
      }
    : {
        line: '#2f9e44',
        fill: 'rgba(47, 158, 68, 0.12)',
        tick: '#868e96',
        grid: 'rgba(0, 0, 0, 0.08)',
        target: '#e03131',
      }

  const data = useMemo<ProjectionChartRow[]>(
    () =>
      points.map((p) => ({
        monthKey: p.monthKey,
        label: formatMonthShort(p.monthKey),
        wealth: p.wealthCents / 100,
        wealthCents: p.wealthCents,
        netCents: p.netCents,
        availableCents: p.availableCents,
      })),
    [points],
  )

  if (points.length === 0) {
    return (
      <p className="field-hint">Sem pontos de projeção para exibir.</p>
    )
  }

  const first = points[0]
  const last = points[points.length - 1]
  const delta = last.wealthCents - first.wealthCents
  const wealths = points.map((p) => p.wealthCents / 100)
  const rawMin = Math.min(...wealths)
  const rawMax = Math.max(...wealths)
  const pad =
    rawMax === rawMin
      ? Math.max(1_000, Math.abs(rawMax) * 0.08)
      : Math.max(1, (rawMax - rawMin) * 0.08)
  const yDomain: [number, number] = [rawMin - pad, rawMax + pad]
  const hasTarget =
    targetMonthKey != null &&
    points.some((p) => p.monthKey === targetMonthKey)

  return (
    <div className="goals-chart-wrap">
      <div className="goals-chart-legend">
        <span>
          {formatMonthShort(first.monthKey)}{' '}
          <strong>{money(first.wealthCents, hideAmounts)}</strong>
        </span>
        <span>
          {formatMonthShort(last.monthKey)}{' '}
          <strong>{money(last.wealthCents, hideAmounts)}</strong>
        </span>
        <span className={delta >= 0 ? 'pos' : 'neg'}>
          {delta >= 0 ? '+' : ''}
          {money(delta, hideAmounts)}
        </span>
      </div>
      <div
        className="goals-chart-canvas"
        role="img"
        aria-label="Projeção de patrimônio"
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data}
            margin={{ top: 10, right: 8, left: 0, bottom: 0 }}
          >
            <CartesianGrid
              stroke={colors.grid}
              vertical={false}
              strokeDasharray="3 3"
            />
            <XAxis
              dataKey="monthKey"
              tickFormatter={(value: string) => formatMonthShort(value)}
              axisLine={false}
              tickLine={false}
              minTickGap={28}
              tick={{ fill: colors.tick, fontSize: 11 }}
            />
            <YAxis
              domain={yDomain}
              width={58}
              axisLine={false}
              tickLine={false}
              tick={{ fill: colors.tick, fontSize: 11 }}
              tickFormatter={(value: number) =>
                hideAmounts
                  ? '•••'
                  : formatCompactBRL(Math.round(value * 100))
              }
            />
            <Tooltip
              cursor={{ stroke: colors.line, strokeOpacity: 0.35 }}
              content={<ProjectionTooltip hideAmounts={hideAmounts} />}
              wrapperStyle={{ outline: 'none', zIndex: 8 }}
            />
            {hasTarget && targetMonthKey ? (
              <ReferenceLine
                x={targetMonthKey}
                stroke={colors.target}
                strokeOpacity={0.55}
                strokeDasharray="4 3"
              />
            ) : null}
            <Area
              type="monotone"
              dataKey="wealth"
              stroke={colors.line}
              fill={colors.fill}
              strokeWidth={2.4}
              dot={{ r: 2.6, fill: colors.line, strokeWidth: 0 }}
              activeDot={{ r: 5.5, fill: colors.line, strokeWidth: 0 }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="goals-chart-hint">Passe o mouse para ver cada mês</p>
    </div>
  )
}

function TargetBars({
  period,
  settings,
  hideAmounts,
}: {
  period: PeriodSavings
  settings: GoalsSettings
  hideAmounts: boolean
}) {
  // Each row = progress toward that tier (saved / target), not a shared income axis.
  const saved = Math.max(0, period.savedCents)
  const rows = [
    { label: `Mín. ${settings.minPct}%`, cents: period.targetMinCents },
    {
      label: `Principal ${settings.primaryPct}%`,
      cents: period.targetPrimaryCents,
    },
    { label: `Ideal ${settings.idealPct}%`, cents: period.targetIdealCents },
  ]
  return (
    <div className="goals-bars">
      {rows.map((row) => {
        const target = Math.max(1, row.cents)
        const progressPct = Math.min(100, (saved / target) * 100)
        const met = period.savedCents >= row.cents
        return (
          <div key={row.label} className="goals-bar-row">
            <span>{row.label}</span>
            <div
              className="goals-bar-track"
              title={
                hideAmounts
                  ? `${progressPct.toFixed(0)}% da meta`
                  : `Sobra ${formatBRL(period.savedCents)} · ${progressPct.toFixed(0)}% da meta ${formatBRL(row.cents)}`
              }
            >
              <div
                className={`goals-bar-saved${met ? ' is-met' : ''}`}
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <strong>
              {met ? 'ok' : `${progressPct.toFixed(0)}%`}
              {hideAmounts ? null : ` · ${formatBRL(row.cents)}`}
            </strong>
          </div>
        )
      })}
    </div>
  )
}

function CashflowSummary({
  title,
  period,
  settings,
  showBars,
  onAdjustPct,
  embedded,
  hideAmounts,
}: {
  title: string
  period: PeriodSavings
  settings: GoalsSettings
  showBars?: boolean
  onAdjustPct?: () => void
  embedded?: boolean
  hideAmounts: boolean
}) {
  const hasIncome = period.incomePaidCents > 0
  const isSurplus = period.savedCents >= 0
  const Tag = embedded ? 'div' : 'section'
  return (
    <Tag className={embedded ? 'goals-embedded' : 'goals-card'}>
      <div className="goals-card-head">
        <h2>{title}</h2>
        {onAdjustPct ? (
          <button type="button" className="btn ghost" onClick={onAdjustPct}>
            Ajustar %
          </button>
        ) : null}
      </div>
      {!hasIncome ? (
        <p className="field-hint">
          Ainda não há renda neste período no Organizze.
        </p>
      ) : null}
      <div className="goals-stat-grid">
        <div>
          <span>Renda</span>
          <strong>{money(period.incomePaidCents, hideAmounts)}</strong>
          <small>Receita prevista do Organizze</small>
        </div>
        <div>
          <span>Gastos</span>
          <strong className="neg">
            {money(period.consumptionPaidCents, hideAmounts)}
          </strong>
          <small>Despesa prevista do Organizze</small>
        </div>
        <div>
          <span>{isSurplus ? 'Sobra' : 'Déficit'}</span>
          <strong className={isSurplus ? 'pos' : 'neg'}>
            {money(period.savedCents, hideAmounts)}
          </strong>
          <small>
            {!hasIncome
              ? '—'
              : isSurplus
                ? hideAmounts
                  ? `${period.savedPct?.toFixed(1) ?? '0'}% da renda · meta ${settings.primaryPct}%`
                  : `${period.savedPct?.toFixed(1) ?? '0'}% da renda · meta ${settings.primaryPct}% = ${formatBRL(period.targetPrimaryCents)}`
                : hideAmounts
                  ? 'Gastou mais que a renda'
                  : `Gastou mais que a renda · meta era ${formatBRL(period.targetPrimaryCents)}`}
          </small>
        </div>
      </div>
      {showBars && hasIncome ? (
        <TargetBars
          period={period}
          settings={settings}
          hideAmounts={hideAmounts}
        />
      ) : null}
    </Tag>
  )
}

export function GoalsView({ apiFetch, onError }: Props) {
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const isActive = location.pathname === ROUTES.goals
  const wasActiveRef = useRef(false)

  const [month, setMonth] = useState(
    () =>
      readMonthParam(new URLSearchParams(window.location.search)) ??
      currentMonthKeySaoPaulo(),
  )
  const [overview, setOverview] = useState<GoalsOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [hideAmounts, setHideAmounts] = useState(readHideAmounts)

  const toggleHideAmounts = () => {
    setHideAmounts((current) => {
      const next = !current
      writeHideAmounts(next)
      return next
    })
  }

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [minPct, setMinPct] = useState('30')
  const [primaryPct, setPrimaryPct] = useState('35')
  const [idealPct, setIdealPct] = useState('40')
  const [savingSettings, setSavingSettings] = useState(false)

  const [goalFormOpen, setGoalFormOpen] = useState(false)
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null)
  const [goalName, setGoalName] = useState('')
  const [goalTarget, setGoalTarget] = useState('')
  const [goalAllocated, setGoalAllocated] = useState('')
  const [goalDate, setGoalDate] = useState('')
  const [goalPriority, setGoalPriority] = useState('100')
  const [savingGoal, setSavingGoal] = useState(false)

  const [allocateGoal, setAllocateGoal] = useState<GoalProgress | null>(null)
  const [allocateAmount, setAllocateAmount] = useState('')
  const [allocating, setAllocating] = useState(false)

  const [deleteGoal, setDeleteGoal] = useState<GoalProgress | null>(null)
  const [deleting, setDeleting] = useState(false)

  const syncUrl = useCallback(
    (nextMonth: string, mode: 'push' | 'replace') => {
      if (!isActive) {
        return
      }
      const currentYm = currentMonthKeySaoPaulo()
      setSearchParams(
        (current) =>
          patchSearchParams(current, {
            month: monthParamForUrl(nextMonth, currentYm),
            section: null,
            account: null,
            kind: null,
            q: null,
            tab: null,
          }),
        { replace: mode === 'replace' },
      )
    },
    [isActive, setSearchParams],
  )

  const load = useCallback(
    async (yearMonth: string, options?: { silent?: boolean }) => {
      if (!options?.silent) {
        onError(null)
        setLoading(true)
      }
      try {
        const data = await apiFetch<GoalsOverview>(
          `/api/goals/overview?month=${encodeURIComponent(yearMonth)}`,
        )
        setOverview({
          ...data,
          avgMonthlyIncomeCents: data.avgMonthlyIncomeCents ?? 0,
          plannedMonthlySaveCents:
            data.plannedMonthlySaveCents ?? data.averageMonthlySpareCents ?? 0,
          weeklySaveTargetCents: data.weeklySaveTargetCents ?? 0,
          spendableCents: data.spendableCents ?? 0,
          paceBufferCents: data.paceBufferCents ?? 0,
          paceBufferSavedPct:
            typeof data.paceBufferSavedPct === 'number'
              ? data.paceBufferSavedPct
              : null,
          paceBufferWindowMonths: data.paceBufferWindowMonths ?? 12,
          projection: Array.isArray(data.projection) ? data.projection : [],
          projectionNote:
            data.projectionNote ??
            'Projeção com base nos lançamentos do Organizze.',
        })
        setMinPct(String(data.settings.minPct))
        setPrimaryPct(String(data.settings.primaryPct))
        setIdealPct(String(data.settings.idealPct))
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Erro ao carregar metas')
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
    if (isActive && !wasActiveRef.current) {
      syncUrl(month, 'replace')
    }
    wasActiveRef.current = isActive
  }, [isActive, month, syncUrl])

  useEffect(() => {
    if (!isActive) {
      return
    }
    const next = resolveYearMonth(searchParams, currentMonthKeySaoPaulo())
    setMonth((current) => (current === next ? current : next))
  }, [searchParams, isActive])

  useEffect(() => {
    if (!isActive) {
      return
    }
    void load(month).catch(() => undefined)
  }, [isActive, month, load])

  const openSettings = () => {
    if (overview) {
      setMinPct(String(overview.settings.minPct))
      setPrimaryPct(String(overview.settings.primaryPct))
      setIdealPct(String(overview.settings.idealPct))
    }
    setSettingsOpen(true)
  }

  const saveSettings = async () => {
    const min = Number(minPct)
    const primary = Number(primaryPct)
    const ideal = Number(idealPct)
    if (![min, primary, ideal].every((n) => Number.isFinite(n) && n >= 0 && n <= 100)) {
      onError('Percentuais devem estar entre 0 e 100')
      return
    }
    setSavingSettings(true)
    onError(null)
    try {
      await apiFetch<GoalsSettings>('/api/goals/settings', {
        method: 'PUT',
        body: JSON.stringify({ minPct: min, primaryPct: primary, idealPct: ideal }),
      })
      setSettingsOpen(false)
      await load(month, { silent: true })
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Erro ao salvar metas %')
    } finally {
      setSavingSettings(false)
    }
  }

  const openCreateGoal = () => {
    setEditingGoalId(null)
    setGoalName('')
    setGoalTarget('')
    setGoalAllocated('')
    setGoalDate('')
    setGoalPriority('100')
    setGoalFormOpen(true)
  }

  const openEditGoal = (goal: GoalProgress) => {
    setEditingGoalId(goal.id)
    setGoalName(goal.name)
    setGoalTarget(centsToBrlInput(goal.targetCents))
    setGoalAllocated(centsToBrlInput(goal.allocatedCents))
    setGoalDate(goal.targetDate?.slice(0, 10) ?? '')
    setGoalPriority(String(goal.priority))
    setGoalFormOpen(true)
  }

  const closeGoalForm = () => {
    if (savingGoal) {
      return
    }
    setGoalFormOpen(false)
    setEditingGoalId(null)
  }

  const submitGoal = async () => {
    const name = goalName.trim()
    if (!name) {
      onError('Informe o nome do objetivo')
      return
    }
    const targetCents = parseUnsignedBRLInputToCents(goalTarget)
    if (targetCents === null || targetCents <= 0) {
      onError('Informe o valor da meta')
      return
    }
    setSavingGoal(true)
    onError(null)
    try {
      if (editingGoalId) {
        await apiFetch(`/api/goals/${editingGoalId}`, {
          method: 'PUT',
          body: JSON.stringify({
            name,
            targetCents,
            targetDate: goalDate || null,
            priority: Number(goalPriority) || 100,
          }),
        })
        setGoalFormOpen(false)
        setEditingGoalId(null)
        await load(month, { silent: true })
      } else {
        const allocatedCents = parseUnsignedBRLInputToCents(goalAllocated) ?? 0
        await apiFetch('/api/goals', {
          method: 'POST',
          body: JSON.stringify({
            name,
            targetCents,
            allocatedCents,
            targetDate: goalDate || null,
            priority: Number(goalPriority) || 100,
          }),
        })
        setGoalFormOpen(false)
        await load(month, { silent: true })
      }
    } catch (err) {
      onError(
        err instanceof Error
          ? err.message
          : editingGoalId
            ? 'Erro ao atualizar objetivo'
            : 'Erro ao criar objetivo',
      )
    } finally {
      setSavingGoal(false)
    }
  }

  const submitAllocate = async () => {
    if (!allocateGoal) {
      return
    }
    const amountCents = parseSignedBRLInputToCents(allocateAmount)
    if (amountCents === null || amountCents === 0) {
      onError('Informe um valor para alocar')
      return
    }
    setAllocating(true)
    onError(null)
    try {
      await apiFetch(`/api/goals/${allocateGoal.id}/allocate`, {
        method: 'POST',
        body: JSON.stringify({ amountCents }),
      })
      setAllocateGoal(null)
      await load(month, { silent: true })
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Erro ao alocar')
    } finally {
      setAllocating(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleteGoal) {
      return
    }
    setDeleting(true)
    onError(null)
    try {
      await apiFetch(`/api/goals/${deleteGoal.id}`, { method: 'DELETE' })
      setDeleteGoal(null)
      await load(month, { silent: true })
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Erro ao apagar objetivo')
    } finally {
      setDeleting(false)
    }
  }

  const monthTitle = formatMonthTitle(month)

  return (
    <>
      <PullToRefresh
        onRefresh={() => load(month)}
        disabled={loading || !isActive}
      >
        <section className="reports-shell goals-shell">
          <header className="reports-header">
            <div className="reports-header-top">
              <h1>Metas</h1>
              <div className="reports-month" aria-label="Mês de referência">
                <button
                  type="button"
                  className="reports-month-arrow"
                  aria-label="Mês anterior"
                  onClick={() => {
                    const next = shiftMonth(month, -1)
                    setMonth(next)
                    syncUrl(next, 'push')
                  }}
                >
                  ‹
                </button>
                <span className="reports-month-label">{monthTitle}</span>
                <button
                  type="button"
                  className="reports-month-arrow"
                  aria-label="Próximo mês"
                  onClick={() => {
                    const next = shiftMonth(month, 1)
                    setMonth(next)
                    syncUrl(next, 'push')
                  }}
                >
                  ›
                </button>
              </div>
              <div className="goals-header-actions">
                <button
                  type="button"
                  className="goals-privacy-btn"
                  title={hideAmounts ? 'Mostrar valores' : 'Ocultar valores'}
                  aria-label={
                    hideAmounts ? 'Mostrar valores' : 'Ocultar valores'
                  }
                  aria-pressed={hideAmounts}
                  onClick={toggleHideAmounts}
                >
                  {hideAmounts ? (
                    <svg
                      viewBox="0 0 24 24"
                      width="20"
                      height="20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg
                      viewBox="0 0 24 24"
                      width="20"
                      height="20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
                <button
                  type="button"
                  className="reports-refresh"
                  disabled={loading}
                  onClick={() => void load(month)}
                >
                  {loading ? 'Atualizando…' : 'Atualizar'}
                </button>
              </div>
            </div>
            <p className="settings-header-copy">
              Quanto da renda você está guardando e se está no ritmo dos
              objetivos — com base nos lançamentos do Organizze.
            </p>
          </header>

          <div className="reports-body goals-body">
            <div
              className={`goals-content${loading ? ' is-loading' : ''}`}
              aria-busy={loading}
            >
              {loading ? (
                <div className="goals-loading-overlay" role="status">
                  <span className="spinner lg" aria-hidden />
                  <p>Carregando…</p>
                </div>
              ) : null}
              {overview ? (
              <>
                <section className="goals-card goals-hero">
                  <div className="goals-card-head">
                    <h2>Economia do mês</h2>
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={openSettings}
                    >
                      Ajustar %
                    </button>
                  </div>
                  {overview.month.incomePaidCents <= 0 ? (
                    <p className="field-hint">
                      Ainda não há renda neste mês no Organizze.
                    </p>
                  ) : (
                    <>
                      <div className="goals-hero-metric">
                        <strong
                          className={
                            (overview.month.savedPct ?? 0) >=
                            overview.settings.primaryPct
                              ? 'pos'
                              : undefined
                          }
                        >
                          {overview.month.savedPct != null
                            ? `${overview.month.savedPct.toFixed(0)}%`
                            : '—'}
                        </strong>
                        <span>meta principal {overview.settings.primaryPct}%</span>
                      </div>
                      <div className="goals-progress-track goals-hero-track">
                        <div
                          className="goals-progress-fill"
                          style={{
                            width: `${Math.min(
                              100,
                              overview.month.targetPrimaryCents > 0
                                ? (Math.max(0, overview.month.savedCents) /
                                    overview.month.targetPrimaryCents) *
                                  100
                                : 0,
                            )}%`,
                          }}
                        />
                      </div>
                      <div className="goals-hero-row">
                        <span>
                          Economizado:{' '}
                          <strong
                            className={
                              overview.month.savedCents >= 0 ? 'pos' : 'neg'
                            }
                          >
                            {money(overview.month.savedCents, hideAmounts)}
                          </strong>
                        </span>
                        <span>
                          Meta:{' '}
                          <strong>
                            {money(
                              overview.month.targetPrimaryCents,
                              hideAmounts,
                            )}
                          </strong>
                        </span>
                      </div>
                      <p className="goals-hero-foot">
                        {overview.month.gapPrimaryCents > 0
                          ? hideAmounts
                            ? 'Ainda falta para a meta deste mês'
                            : `Faltam ${formatBRL(overview.month.gapPrimaryCents)} para a meta deste mês`
                          : 'Meta principal do mês alcançada'}
                      </p>
                    </>
                  )}
                  <div className="goals-chip-row">
                    <div className="goals-chip">
                      <span>Disponível no mês</span>
                      <strong className="pos">
                        {money(overview.spendableCents, hideAmounts)}
                      </strong>
                      <small>sem furar a meta {overview.settings.primaryPct}%</small>
                    </div>
                    <div className="goals-chip">
                      <span>
                        {overview.paceBufferCents >= 0
                          ? `Folga meta % (${overview.paceBufferWindowMonths}m)`
                          : `Falta meta % (${overview.paceBufferWindowMonths}m)`}
                      </span>
                      <strong
                        className={
                          overview.paceBufferCents >= 0 ? 'pos' : 'neg'
                        }
                      >
                        {overview.paceBufferSavedPct != null
                          ? `${overview.paceBufferSavedPct.toFixed(1)}%`
                          : '—'}
                      </strong>
                      <small>
                        meta {overview.settings.primaryPct}%
                        {hideAmounts
                          ? ''
                          : ` · ${
                              overview.paceBufferCents >= 0 ? 'folga' : 'falta'
                            } ${formatBRL(Math.abs(overview.paceBufferCents))}`}
                      </small>
                    </div>
                    <div className="goals-chip">
                      <span>Renda / despesa do mês</span>
                      <strong>
                        {money(
                          overview.month.incomePaidCents,
                          hideAmounts,
                        )}
                      </strong>
                      <strong className="neg goals-chip-secondary">
                        {money(
                          overview.month.consumptionPaidCents,
                          hideAmounts,
                        )}
                      </strong>
                    </div>
                  </div>
                  <details className="goals-details">
                    <summary>Detalhes do mês e do ano</summary>
                    <CashflowSummary
                      title={`Mês · ${formatMonthTitle(overview.monthKey)}`}
                      period={overview.month}
                      settings={overview.settings}
                      showBars
                      embedded
                      hideAmounts={hideAmounts}
                    />
                    <CashflowSummary
                      title={`Ano ${overview.year} · jan–dez/${String(overview.year).slice(2)}`}
                      period={overview.yearToDate}
                      settings={overview.settings}
                      embedded
                      hideAmounts={hideAmounts}
                    />
                    <p className="field-hint">
                      Renda e gastos vêm do resumo do Organizze no período (não
                      somamos lançamentos — evita duplicar fatura).
                      {overview.yearToDate.savedCents < 0 &&
                      overview.month.savedCents >= 0
                        ? hideAmounts
                          ? ` Resultado negativo no ano não apaga a capacidade atual (meta ${overview.settings.primaryPct}%).`
                          : ` Resultado negativo no ano não apaga a capacidade atual (~${formatBRL(overview.plannedMonthlySaveCents)}/mês com ${overview.settings.primaryPct}%).`
                        : ''}
                    </p>
                  </details>
                </section>

                <section className="goals-card">
                  <div className="goals-card-head">
                    <h2>Seus objetivos</h2>
                    <button
                      type="button"
                      className="btn"
                      onClick={openCreateGoal}
                    >
                      Novo objetivo
                    </button>
                  </div>
                  <p className="field-hint goals-inline-hint">
                    {hideAmounts
                      ? 'Economia planejada oculta · alocações não se misturam entre metas.'
                      : `Livre para alocar: ${formatBRL(overview.availableCents)} · economia planejada ${formatBRL(overview.plannedMonthlySaveCents)}/mês (sem tocar no que já está alocado).`}
                  </p>
                  {overview.goals.length === 0 ? (
                    <div className="empty">
                      <p>
                        Nenhum objetivo ainda. Crie reserva, entrada de imóvel,
                        etc. — o dinheiro alocado não é contado em duas metas.
                      </p>
                    </div>
                  ) : (
                    <ul className="goals-list">
                      {overview.goals.map((goal) => (
                        <li key={goal.id} className="goals-goal">
                          <div className="goals-goal-head">
                            <div>
                              <strong>{goal.name}</strong>
                              <span className={`goals-pace is-${goal.pace}`}>
                                {paceLabel(goal.pace)}
                              </span>
                            </div>
                            <span className="goals-goal-date">
                              {goal.targetDate
                                ? formatMonthShort(goal.targetDate.slice(0, 7))
                                : 'Sem data'}
                            </span>
                          </div>
                          <div className="goals-hero-row">
                            <span>
                              {hideAmounts ? (
                                'Progresso da meta'
                              ) : (
                                <>
                                  <strong>
                                    {formatBRL(goal.allocatedCents)}
                                  </strong>
                                  {' de '}
                                  {formatBRL(goal.targetCents)}
                                </>
                              )}
                            </span>
                            <span>{goal.progressPct.toFixed(0)}%</span>
                          </div>
                          <div className="goals-progress-track">
                            <div
                              className="goals-progress-fill"
                              style={{
                                width: `${Math.min(100, goal.progressPct)}%`,
                              }}
                            />
                          </div>
                          <div className="goals-goal-meta">
                            <span>
                              {paceReason(
                                goal,
                                overview.plannedMonthlySaveCents,
                                hideAmounts,
                              )}
                            </span>
                            {goal.estimatedMonth && goal.pace !== 'done' ? (
                              <span className="goals-required-monthly">
                                Chega em{' '}
                                <strong>
                                  {formatMonthShort(goal.estimatedMonth)}
                                </strong>
                                {' '}sem usar saldos já alocados
                              </span>
                            ) : null}
                            {goal.requiredMonthlyCents != null &&
                            goal.monthsRemaining != null &&
                            goal.monthsRemaining > 0 &&
                            goal.pace !== 'done' ? (
                              <span>
                                {hideAmounts
                                  ? `${goal.monthsRemaining} ${goal.monthsRemaining === 1 ? 'mês' : 'meses'} restantes`
                                  : `Guardar ${formatBRL(goal.requiredMonthlyCents)}/mês · ${goal.monthsRemaining} ${goal.monthsRemaining === 1 ? 'mês' : 'meses'}`}
                              </span>
                            ) : null}
                          </div>
                          <div className="goals-goal-actions">
                            <button
                              type="button"
                              className="goals-icon-btn"
                              title="Alocar"
                              aria-label={`Alocar em ${goal.name}`}
                              onClick={() => {
                                setAllocateAmount('')
                                setAllocateGoal(goal)
                              }}
                            >
                              <svg
                                viewBox="0 0 24 24"
                                width="18"
                                height="18"
                                aria-hidden
                              >
                                <path
                                  fill="currentColor"
                                  d="M12 3v10.2l3.6-3.6L17 11l-5 5-5-5 1.4-1.4L11 13.2V3h1zm-7 16h14v2H5v-2z"
                                />
                              </svg>
                            </button>
                            <button
                              type="button"
                              className="goals-icon-btn"
                              title="Editar"
                              aria-label={`Editar ${goal.name}`}
                              onClick={() => openEditGoal(goal)}
                            >
                              <svg
                                viewBox="0 0 24 24"
                                width="18"
                                height="18"
                                aria-hidden
                              >
                                <path
                                  fill="currentColor"
                                  d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
                                />
                              </svg>
                            </button>
                            <button
                              type="button"
                              className="goals-icon-btn is-danger"
                              title="Apagar"
                              aria-label={`Apagar ${goal.name}`}
                              onClick={() => setDeleteGoal(goal)}
                            >
                              <svg
                                viewBox="0 0 24 24"
                                width="18"
                                height="18"
                                aria-hidden
                              >
                                <path
                                  fill="currentColor"
                                  d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
                                />
                              </svg>
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="goals-card">
                  <div className="goals-card-head">
                    <h2>Projeção de patrimônio</h2>
                  </div>
                  <div className="goals-stat-grid goals-stat-grid-compact">
                    <div>
                      <span>Patrimônio hoje</span>
                      <strong>
                        {money(overview.netWorthCents, hideAmounts)}
                      </strong>
                    </div>
                    <div>
                      <span>Alocado</span>
                      <strong>
                        {money(overview.totalAllocatedCents, hideAmounts)}
                      </strong>
                    </div>
                    <div>
                      <span>Livre</span>
                      <strong className="pos">
                        {money(overview.availableCents, hideAmounts)}
                      </strong>
                    </div>
                  </div>
                  <ProjectionChart
                    points={overview.projection}
                    hideAmounts={hideAmounts}
                    targetMonthKey={
                      overview.goals.find(
                        (g) =>
                          g.pace !== 'done' &&
                          g.targetDate != null &&
                          g.remainingCents > 0,
                      )?.targetDate?.slice(0, 7) ?? null
                    }
                  />
                  <p className="field-hint">{overview.projectionNote}</p>
                </section>
              </>
              ) : (
                <div
                  className="goals-loading-spacer"
                  aria-hidden={!loading}
                />
              )}
            </div>
          </div>
        </section>
      </PullToRefresh>

      {settingsOpen ? (
        <BottomSheet
          onClose={() => setSettingsOpen(false)}
          busy={savingSettings}
          title="Percentuais de economia"
          subtitle="Metas mín., principal e ideal sobre a renda do período."
        >
          <div className="settings-form modal-body">
            <label>
              Mínima (%)
              <input
                value={minPct}
                inputMode="decimal"
                disabled={savingSettings}
                onChange={(e) => setMinPct(e.target.value)}
              />
            </label>
            <label>
              Principal (%)
              <input
                value={primaryPct}
                inputMode="decimal"
                disabled={savingSettings}
                onChange={(e) => setPrimaryPct(e.target.value)}
              />
            </label>
            <label>
              Ideal (%)
              <input
                value={idealPct}
                inputMode="decimal"
                disabled={savingSettings}
                onChange={(e) => setIdealPct(e.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="btn ghost"
                disabled={savingSettings}
                onClick={() => setSettingsOpen(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn"
                disabled={savingSettings}
                onClick={() => void saveSettings()}
              >
                Salvar
              </button>
            </div>
          </div>
        </BottomSheet>
      ) : null}

      {goalFormOpen ? (
        <BottomSheet
          onClose={closeGoalForm}
          busy={savingGoal}
          title={editingGoalId ? 'Editar objetivo' : 'Novo objetivo'}
          subtitle={
            editingGoalId
              ? 'Para mudar o valor já alocado, use o botão de alocar.'
              : 'Alocação é virtual — não move dinheiro entre contas.'
          }
        >
          <div className="settings-form modal-body">
            <label>
              Nome
              <input
                value={goalName}
                disabled={savingGoal}
                maxLength={120}
                onChange={(e) => setGoalName(e.target.value)}
              />
            </label>
            <label>
              Valor da meta (R$)
              <input
                value={goalTarget}
                disabled={savingGoal}
                inputMode="numeric"
                placeholder="0,00"
                onChange={(e) =>
                  setGoalTarget(formatBrlInputFromDigits(e.target.value))
                }
              />
            </label>
            {editingGoalId ? (
              <p className="field-hint">
                Já alocado:{' '}
                {formatBRL(parseUnsignedBRLInputToCents(goalAllocated) ?? 0)}{' '}
                (ajuste pelo ícone de alocar)
              </p>
            ) : (
              <label>
                Já alocado (R$)
                <input
                  value={goalAllocated}
                  disabled={savingGoal}
                  inputMode="numeric"
                  placeholder="0,00"
                  onChange={(e) =>
                    setGoalAllocated(formatBrlInputFromDigits(e.target.value))
                  }
                />
              </label>
            )}
            <label>
              Data-alvo (opcional)
              <input
                type="date"
                value={goalDate}
                disabled={savingGoal}
                onChange={(e) => setGoalDate(e.target.value)}
              />
            </label>
            <label>
              Prioridade (menor = mais importante)
              <input
                type="number"
                min={1}
                value={goalPriority}
                disabled={savingGoal}
                onChange={(e) => setGoalPriority(e.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="btn ghost"
                disabled={savingGoal}
                onClick={closeGoalForm}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn"
                disabled={savingGoal}
                onClick={() => void submitGoal()}
              >
                {editingGoalId ? 'Salvar' : 'Criar'}
              </button>
            </div>
          </div>
        </BottomSheet>
      ) : null}

      {allocateGoal ? (
        <BottomSheet
          onClose={() => setAllocateGoal(null)}
          busy={allocating}
          title={`Alocar · ${allocateGoal.name}`}
          subtitle="Use valor positivo para alocar, negativo para liberar."
        >
          <div className="settings-form modal-body">
            <label>
              Valor (R$)
              <input
                value={allocateAmount}
                disabled={allocating}
                inputMode="numeric"
                placeholder="0,00 ou -0,00"
                onChange={(e) =>
                  setAllocateAmount(
                    formatSignedBrlInputFromDigits(e.target.value),
                  )
                }
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="btn ghost"
                disabled={allocating}
                onClick={() => setAllocateGoal(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn"
                disabled={allocating}
                onClick={() => void submitAllocate()}
              >
                Confirmar
              </button>
            </div>
          </div>
        </BottomSheet>
      ) : null}

      {deleteGoal ? (
        <ConfirmDialog
          title="Apagar objetivo?"
          message={`Remove “${deleteGoal.name}” e o histórico de alocações. Os saldos reais no Organizze não mudam.`}
          confirmLabel="Apagar"
          busyLabel="Apagando…"
          busy={deleting}
          danger
          onCancel={() => {
            if (!deleting) {
              setDeleteGoal(null)
            }
          }}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </>
  )
}
