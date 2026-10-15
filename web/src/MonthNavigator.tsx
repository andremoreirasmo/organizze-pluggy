import { useEffect, useId, useRef, useState } from 'react'

type Props = {
  value: string
  onChange: (yearMonth: string) => void
  disabled?: boolean
  /** Inclusive YYYY-MM bounds. */
  min?: string
  max?: string
  className?: string
  arrowClassName?: string
  labelClassName?: string
  ariaLabel?: string
  /** Disable prev/next independently (e.g. chart window edges). */
  disablePrev?: boolean
  disableNext?: boolean
}

const MONTH_RE = /^\d{4}-\d{2}$/

const MONTH_LABELS = [
  'jan',
  'fev',
  'mar',
  'abr',
  'mai',
  'jun',
  'jul',
  'ago',
  'set',
  'out',
  'nov',
  'dez',
] as const

function formatMonthTitle(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m)) {
    return monthKey
  }
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

function clampMonth(yearMonth: string, min?: string, max?: string): string {
  if (min && yearMonth < min) {
    return min
  }
  if (max && yearMonth > max) {
    return max
  }
  return yearMonth
}

function parseYearMonth(yearMonth: string): { year: number; month: number } {
  const [y, m] = yearMonth.split('-').map(Number)
  return { year: y, month: m }
}

function toYearMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`
}

export function MonthNavigator({
  value,
  onChange,
  disabled = false,
  min,
  max,
  className = 'reports-month',
  arrowClassName = 'reports-month-arrow',
  labelClassName = 'reports-month-label',
  ariaLabel = 'Mês de referência',
  disablePrev = false,
  disableNext = false,
}: Props) {
  const title = formatMonthTitle(value)
  const pickerId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const selected = parseYearMonth(value)
  const [viewYear, setViewYear] = useState(selected.year)

  const selectMonth = (next: string) => {
    if (!MONTH_RE.test(next)) {
      return
    }
    const clamped = clampMonth(next, min, max)
    if (clamped !== value) {
      onChange(clamped)
    }
  }

  const close = () => setOpen(false)

  const toggleOpen = () => {
    if (disabled) {
      return
    }
    setOpen((current) => {
      if (!current) {
        setViewYear(selected.year)
      }
      return !current
    })
  }

  useEffect(() => {
    if (!open) {
      return
    }
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current
      if (!root || root.contains(event.target as Node)) {
        return
      }
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }
    setViewYear(selected.year)
  }, [open, selected.year])

  const minYear = min ? parseYearMonth(min).year : undefined
  const maxYear = max ? parseYearMonth(max).year : undefined
  const canPrevYear = minYear === undefined || viewYear > minYear
  const canNextYear = maxYear === undefined || viewYear < maxYear

  return (
    <div ref={rootRef} className={className} aria-label={ariaLabel}>
      <button
        type="button"
        className={arrowClassName}
        disabled={disabled || disablePrev}
        aria-label="Mês anterior"
        onClick={() => selectMonth(shiftMonth(value, -1))}
      >
        ‹
      </button>
      <div className="month-nav-center">
        <button
          type="button"
          className={`${labelClassName}${disabled ? ' is-disabled' : ''}`}
          disabled={disabled}
          title="Escolher mês"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? pickerId : undefined}
          onClick={toggleOpen}
        >
          <span className="month-nav-title">{title}</span>
        </button>
        {open ? (
          <div
            id={pickerId}
            className="month-nav-popover"
            role="dialog"
            aria-label="Escolher mês e ano"
          >
            <div className="month-nav-popover-year">
              <button
                type="button"
                className="month-nav-year-arrow"
                disabled={!canPrevYear}
                aria-label="Ano anterior"
                onClick={() => setViewYear((y) => y - 1)}
              >
                ‹
              </button>
              <span className="month-nav-year-label">{viewYear}</span>
              <button
                type="button"
                className="month-nav-year-arrow"
                disabled={!canNextYear}
                aria-label="Próximo ano"
                onClick={() => setViewYear((y) => y + 1)}
              >
                ›
              </button>
            </div>
            <div className="month-nav-months" role="listbox" aria-label="Meses">
              {MONTH_LABELS.map((label, index) => {
                const month = index + 1
                const key = toYearMonth(viewYear, month)
                const isSelected = key === value
                const outOfRange = Boolean(
                  (min && key < min) || (max && key > max),
                )
                return (
                  <button
                    key={key}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`month-nav-month${isSelected ? ' is-selected' : ''}`}
                    disabled={outOfRange}
                    onClick={() => {
                      selectMonth(key)
                      close()
                    }}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className={arrowClassName}
        disabled={disabled || disableNext}
        aria-label="Próximo mês"
        onClick={() => selectMonth(shiftMonth(value, 1))}
      >
        ›
      </button>
    </div>
  )
}
