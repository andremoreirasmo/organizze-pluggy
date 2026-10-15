import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
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

function formatBRL(amountCents: number): string {
  return (amountCents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
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

function paceReason(goal: GoalProgress, plannedMonthlySaveCents: number): string {
  if (goal.pace === 'done') {
    return 'Meta concluída'
  }
  if (goal.requiredMonthlyCents == null) {
    return goal.estimatedMonth
      ? `Previsão ${formatMonthShort(goal.estimatedMonth)}`
      : 'Sem data-alvo'
  }
  const req = goal.requiredMonthlyCents
  if (plannedMonthlySaveCents >= req) {
    return `Planejado ${formatBRL(plannedMonthlySaveCents)}/mês ≥ ${formatBRL(req)} necessários`
  }
  if (goal.estimatedMonth) {
    return `Previsão ${formatMonthShort(goal.estimatedMonth)} com ${formatBRL(plannedMonthlySaveCents)}/mês`
  }
  return `Precisa ${formatBRL(req)}/mês · planejado ${formatBRL(plannedMonthlySaveCents)}`
}

function ProjectionChart({
  points,
  targetMonthKey,
}: {
  points: ProjectionPoint[]
  targetMonthKey?: string | null
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  if (points.length === 0) {
    return null
  }
  const width = 640
  const height = 168
  const padL = 44
  const padR = 12
  const padT = 12
  const padB = 28
  const wealths = points.map((p) => p.wealthCents)
  const minW = Math.min(...wealths)
  const maxW = Math.max(...wealths)
  const span = Math.max(1, maxW - minW)
  const innerW = width - padL - padR
  const innerH = height - padT - padB
  const coords = points.map((p, i) => {
    const x =
      padL + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW)
    const y = padT + innerH - ((p.wealthCents - minW) / span) * innerH
    return { x, y, p }
  })
  const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x},${c.y}`).join(' ')
  const labelIdx = new Set<number>()
  const step = Math.max(1, Math.floor((points.length - 1) / 5))
  for (let i = 0; i < points.length; i += step) {
    labelIdx.add(i)
  }
  labelIdx.add(points.length - 1)
  if (targetMonthKey) {
    const ti = points.findIndex((p) => p.monthKey === targetMonthKey)
    if (ti >= 0) {
      labelIdx.add(ti)
    }
  }
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => minW + span * t)
  const hover = hoverIdx != null ? coords[hoverIdx] : null
  const tipLeftPct = hover ? (hover.x / width) * 100 : 0

  const nearestIndex = (clientX: number, rect: DOMRect): number => {
    const x = ((clientX - rect.left) / rect.width) * width
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < coords.length; i += 1) {
      const dist = Math.abs(coords[i].x - x)
      if (dist < bestDist) {
        bestDist = dist
        best = i
      }
    }
    return best
  }

  return (
    <div className="goals-chart-wrap">
      <div
        className="goals-chart-hit"
        onMouseLeave={() => setHoverIdx(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          setHoverIdx(nearestIndex(e.clientX, rect))
        }}
      >
        <svg
          className="goals-chart"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Projeção de patrimônio"
        >
          {yTicks.map((tick) => {
            const y = padT + innerH - ((tick - minW) / span) * innerH
            return (
              <g key={tick}>
                <line
                  x1={padL}
                  x2={width - padR}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeOpacity={0.12}
                />
                <text
                  className="goals-chart-axis"
                  x={padL - 6}
                  y={y + 3}
                  textAnchor="end"
                >
                  {formatCompactBRL(tick)}
                </text>
              </g>
            )
          })}
          <path
            d={line}
            fill="none"
            stroke="currentColor"
            strokeWidth={2.2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {hover ? (
            <line
              x1={hover.x}
              x2={hover.x}
              y1={padT}
              y2={padT + innerH}
              stroke="currentColor"
              strokeOpacity={0.35}
              strokeDasharray="3 3"
            />
          ) : null}
          {coords.map(({ x, y, p }, i) => {
            const isTarget =
              targetMonthKey != null && p.monthKey === targetMonthKey
            const isHover = hoverIdx === i
            return (
              <circle
                key={p.monthKey}
                cx={x}
                cy={y}
                r={isHover ? 5 : isTarget ? 4.5 : 2.5}
                fill={
                  isTarget
                    ? 'var(--oz-danger)'
                    : isHover
                      ? 'var(--oz-ink)'
                      : 'currentColor'
                }
              />
            )
          })}
          {[...labelIdx].map((i) => {
            const { x, p } = coords[i]
            return (
              <text
                key={`lbl-${p.monthKey}`}
                className="goals-chart-axis"
                x={x}
                y={height - 8}
                textAnchor="middle"
              >
                {formatMonthShort(p.monthKey)}
              </text>
            )
          })}
          {targetMonthKey
            ? (() => {
                const c = coords.find((c) => c.p.monthKey === targetMonthKey)
                if (!c) {
                  return null
                }
                return (
                  <line
                    x1={c.x}
                    x2={c.x}
                    y1={padT}
                    y2={padT + innerH}
                    stroke="var(--oz-danger)"
                    strokeOpacity={0.45}
                    strokeDasharray="4 3"
                  />
                )
              })()
            : null}
        </svg>
        {hover ? (
          <div
            className="goals-chart-tooltip"
            style={{
              left: `${tipLeftPct}%`,
              transform:
                tipLeftPct > 78
                  ? 'translate(-100%, -100%)'
                  : tipLeftPct < 22
                    ? 'translate(0, -100%)'
                    : 'translate(-50%, -100%)',
            }}
          >
            <strong>{formatMonthShort(hover.p.monthKey)}</strong>
            <span>Patrimônio {formatBRL(hover.p.wealthCents)}</span>
            {hover.p.netCents !== 0 ? (
              <span className={hover.p.netCents >= 0 ? 'pos' : 'neg'}>
                {hover.p.netCents >= 0 ? '+' : ''}
                {formatBRL(hover.p.netCents)} no mês
              </span>
            ) : (
              <span>Ponto de partida</span>
            )}
            <span>Livre {formatBRL(hover.p.availableCents)}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function TargetBars({
  period,
  settings,
}: {
  period: PeriodSavings
  settings: GoalsSettings
}) {
  const max = Math.max(
    period.targetIdealCents,
    period.savedCents,
    period.incomePaidCents > 0 ? 1 : 0,
    1,
  )
  const rows = [
    { label: `Mín. ${settings.minPct}%`, cents: period.targetMinCents },
    { label: `Principal ${settings.primaryPct}%`, cents: period.targetPrimaryCents },
    { label: `Ideal ${settings.idealPct}%`, cents: period.targetIdealCents },
  ]
  return (
    <div className="goals-bars">
      {rows.map((row) => (
        <div key={row.label} className="goals-bar-row">
          <span>{row.label}</span>
          <div className="goals-bar-track">
            <div
              className="goals-bar-target"
              style={{ width: `${Math.min(100, (row.cents / max) * 100)}%` }}
            />
            <div
              className={`goals-bar-saved ${period.savedCents >= row.cents ? 'is-met' : ''}`}
              style={{
                width: `${Math.min(100, (Math.max(0, period.savedCents) / max) * 100)}%`,
              }}
            />
          </div>
          <strong>{formatBRL(row.cents)}</strong>
        </div>
      ))}
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
}: {
  title: string
  period: PeriodSavings
  settings: GoalsSettings
  showBars?: boolean
  onAdjustPct?: () => void
  embedded?: boolean
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
          Ainda não há renda neste período no Organizze. As metas % aparecem
          quando há salário/receita lançada (pago ou não).
        </p>
      ) : null}
      <div className="goals-stat-grid">
        <div>
          <span>Renda</span>
          <strong>{formatBRL(period.incomePaidCents)}</strong>
          <small>Todos os lançamentos do período</small>
        </div>
        <div>
          <span>Gastos</span>
          <strong className="neg">
            {formatBRL(period.consumptionPaidCents)}
          </strong>
          <small>
            {period.investmentContribPaidCents > 0
              ? `+ ${formatBRL(period.investmentContribPaidCents)} em aportes (contam como economia)`
              : 'Sem transferências internas'}
          </small>
        </div>
        <div>
          <span>{isSurplus ? 'Sobra' : 'Déficit'}</span>
          <strong className={isSurplus ? 'pos' : 'neg'}>
            {formatBRL(period.savedCents)}
          </strong>
          <small>
            {!hasIncome
              ? '—'
              : isSurplus
                ? `${period.savedPct?.toFixed(1) ?? '0'}% da renda · meta ${settings.primaryPct}% = ${formatBRL(period.targetPrimaryCents)}`
                : `Gastou mais que a renda · meta era ${formatBRL(period.targetPrimaryCents)}`}
          </small>
        </div>
      </div>
      {showBars && hasIncome ? (
        <TargetBars period={period} settings={settings} />
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
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [minPct, setMinPct] = useState('30')
  const [primaryPct, setPrimaryPct] = useState('35')
  const [idealPct, setIdealPct] = useState('40')
  const [savingSettings, setSavingSettings] = useState(false)

  const [goalFormOpen, setGoalFormOpen] = useState(false)
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
        setStatusMessage('Carregando metas…')
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
          projectionNote:
            data.projectionNote ??
            'Projeção com base na economia planejada e nos lançamentos previstos.',
        })
        setMinPct(String(data.settings.minPct))
        setPrimaryPct(String(data.settings.primaryPct))
        setIdealPct(String(data.settings.idealPct))
        if (!options?.silent) {
          setStatusMessage(
            data.month.incomePaidCents === 0
              ? 'Sem renda lançada neste mês ainda.'
              : `Economia do mês: ${data.month.savedPct?.toFixed(1) ?? '—'}%.`,
          )
        }
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Erro ao carregar metas')
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
      setStatusMessage('Metas percentuais atualizadas.')
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Erro ao salvar metas %')
    } finally {
      setSavingSettings(false)
    }
  }

  const openCreateGoal = () => {
    setGoalName('')
    setGoalTarget('')
    setGoalAllocated('')
    setGoalDate('')
    setGoalPriority('100')
    setGoalFormOpen(true)
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
    const allocatedCents = parseUnsignedBRLInputToCents(goalAllocated) ?? 0
    setSavingGoal(true)
    onError(null)
    try {
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
      setStatusMessage(`Objetivo “${name}” criado.`)
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Erro ao criar objetivo')
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
      setStatusMessage(`Alocação em “${allocateGoal.name}” atualizada.`)
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
      setStatusMessage(`Objetivo “${deleteGoal.name}” removido.`)
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
              <button
                type="button"
                className="reports-refresh"
                disabled={loading}
                onClick={() => void load(month)}
              >
                {loading ? 'Atualizando…' : 'Atualizar'}
              </button>
            </div>
            <p className="settings-header-copy">
              Quanto da renda você está guardando e se está no ritmo dos
              objetivos — com base nos lançamentos do Organizze.
            </p>
          </header>

          <div className="reports-body goals-body">
            {statusMessage || loading ? (
              <div
                className={`status-banner ${loading ? 'busy' : ''}`}
                role="status"
              >
                {loading ? <span className="spinner" aria-hidden /> : null}
                <span>{statusMessage}</span>
              </div>
            ) : null}

            {!overview && loading ? (
              <div className="empty loading-empty">
                <span className="spinner lg" aria-hidden />
                <p>Carregando…</p>
              </div>
            ) : overview ? (
              <>
                {overview.alerts.length > 0 ? (
                  <ul className="goals-alerts">
                    {overview.alerts.map((alert) => (
                      <li key={alert}>{alert}</li>
                    ))}
                  </ul>
                ) : null}

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
                      Ainda não há renda neste mês no Organizze. As metas %
                      aparecem quando há salário/receita lançada.
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
                            {formatBRL(overview.month.savedCents)}
                          </strong>
                        </span>
                        <span>
                          Meta:{' '}
                          <strong>
                            {formatBRL(overview.month.targetPrimaryCents)}
                          </strong>
                        </span>
                      </div>
                      <p className="goals-hero-foot">
                        {overview.month.gapPrimaryCents > 0
                          ? `Faltam ${formatBRL(overview.month.gapPrimaryCents)} para a meta deste mês`
                          : overview.month.incomePaidCents > 0
                            ? 'Meta principal do mês alcançada'
                            : 'Aguardando renda lançada neste mês'}
                      </p>
                    </>
                  )}
                  <div className="goals-chip-row">
                    <div className="goals-chip">
                      <span>Por recebimento (~semanal)</span>
                      <strong>
                        {formatBRL(overview.weeklySaveTargetCents)}
                      </strong>
                    </div>
                    <div className="goals-chip">
                      <span>Disponível p/ gastar</span>
                      <strong className="pos">
                        {formatBRL(overview.spendableCents)}
                      </strong>
                    </div>
                    <div className="goals-chip">
                      <span>Renda do mês</span>
                      <strong>
                        {formatBRL(overview.month.incomePaidCents)}
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
                    />
                    <CashflowSummary
                      title={`Ano ${overview.year} · jan–${formatMonthShort(overview.monthKey)}`}
                      period={overview.yearToDate}
                      settings={overview.settings}
                      embedded
                    />
                    <p className="field-hint">
                      Fluxo do período (renda − consumo). Pagamentos de fatura
                      não entram de novo — a compra no cartão já contou.
                      {overview.yearToDate.savedCents < 0 &&
                      overview.month.savedCents >= 0
                        ? ` Resultado negativo no ano não apaga a capacidade atual (~${formatBRL(overview.plannedMonthlySaveCents)}/mês com ${overview.settings.primaryPct}%).`
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
                    Livre para alocar: {formatBRL(overview.availableCents)} ·
                    economia planejada {formatBRL(overview.plannedMonthlySaveCents)}
                    /mês (sem tocar no que já está alocado).
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
                              <strong>{formatBRL(goal.allocatedCents)}</strong>
                              {' de '}
                              {formatBRL(goal.targetCents)}
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
                                Guardar {formatBRL(goal.requiredMonthlyCents)}
                                /mês · {goal.monthsRemaining}{' '}
                                {goal.monthsRemaining === 1 ? 'mês' : 'meses'}
                              </span>
                            ) : null}
                          </div>
                          <div className="goals-goal-actions">
                            <button
                              type="button"
                              className="btn ghost"
                              onClick={() => {
                                setAllocateAmount('')
                                setAllocateGoal(goal)
                              }}
                            >
                              Alocar
                            </button>
                            <button
                              type="button"
                              className="btn ghost"
                              onClick={() => setDeleteGoal(goal)}
                            >
                              Apagar
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
                      <strong>{formatBRL(overview.netWorthCents)}</strong>
                    </div>
                    <div>
                      <span>Alocado</span>
                      <strong>{formatBRL(overview.totalAllocatedCents)}</strong>
                    </div>
                    <div>
                      <span>Livre</span>
                      <strong className="pos">
                        {formatBRL(overview.availableCents)}
                      </strong>
                    </div>
                  </div>
                  <ProjectionChart
                    points={overview.projection}
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
            ) : null}
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
          onClose={() => setGoalFormOpen(false)}
          busy={savingGoal}
          title="Novo objetivo"
          subtitle="Alocação é virtual — não move dinheiro entre contas."
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
                onClick={() => setGoalFormOpen(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn"
                disabled={savingGoal}
                onClick={() => void submitGoal()}
              >
                Criar
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
