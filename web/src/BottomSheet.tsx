import { useEffect, type ReactNode } from 'react'
import { useSwipeDismiss } from './useSwipeDismiss'

type BottomSheetProps = {
  onClose: () => void
  title?: string
  subtitle?: string
  labelledBy?: string
  className?: string
  busy?: boolean
  /** Shown in the fixed overlay while `busy` (stays visible over scroll). */
  busyLabel?: string
  busyHint?: string
  children: ReactNode
  /** Optional custom header content (replaces title/subtitle). Close button still shown. */
  header?: ReactNode
}

export function BottomSheet({
  onClose,
  title,
  subtitle,
  labelledBy,
  className,
  busy = false,
  busyLabel = 'Carregando…',
  busyHint,
  children,
  header,
}: BottomSheetProps) {
  const { sheetRef, offsetY, dragging, backdropOpacity } = useSwipeDismiss(
    onClose,
    { enabled: !busy },
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previous
    }
  }, [busy, onClose])

  return (
    <div
      className="sheet-backdrop"
      role="presentation"
      style={{ opacity: backdropOpacity }}
    >
      <div
        ref={sheetRef}
        className={`sheet-card${className ? ` ${className}` : ''}${dragging ? ' is-dragging' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        style={{ transform: `translate3d(0, ${offsetY}px, 0)` }}
      >
        <div className="sheet-grab" aria-hidden />
        <header className="sheet-head">
          <div className="sheet-head-text">
            {header ? (
              header
            ) : (
              <>
                {title ? <h2 id={labelledBy}>{title}</h2> : null}
                {subtitle ? <p>{subtitle}</p> : null}
              </>
            )}
          </div>
          <button
            type="button"
            className="sheet-close"
            aria-label="Fechar"
            disabled={busy}
            onClick={onClose}
          >
            <span aria-hidden>×</span>
          </button>
        </header>
        <div className="sheet-body">{children}</div>
        {busy ? (
          <div className="sheet-busy-overlay" role="status">
            <span className="spinner lg" aria-hidden />
            <strong>{busyLabel}</strong>
            {busyHint ? <p>{busyHint}</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
