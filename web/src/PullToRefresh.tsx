import type { ReactNode } from 'react'
import { usePullToRefresh } from './usePullToRefresh'

type PullToRefreshProps = {
  onRefresh: () => Promise<void> | void
  disabled?: boolean
  className?: string
  children: ReactNode
}

export function PullToRefresh({
  onRefresh,
  disabled = false,
  className,
  children,
}: PullToRefreshProps) {
  const { containerRef, pullDistance, refreshing, pulling } = usePullToRefresh({
    onRefresh,
    disabled,
  })

  const visible = pulling || refreshing || pullDistance > 0
  const armed = pullDistance >= 42 || refreshing

  return (
    <div
      ref={containerRef}
      className={`ptr-root${className ? ` ${className}` : ''}`}
    >
      <div
        className={`ptr-indicator${visible ? ' is-visible' : ''}${armed ? ' is-armed' : ''}${refreshing ? ' is-refreshing' : ''}`}
        style={{
          height: visible ? Math.max(pullDistance, refreshing ? 48 : 0) : 0,
        }}
        aria-hidden={!visible}
      >
        <span className="ptr-spinner" aria-hidden />
        <span className="ptr-label">
          {refreshing
            ? 'Atualizando…'
            : armed
              ? 'Solte para atualizar'
              : 'Puxe para atualizar'}
        </span>
      </div>
      {children}
    </div>
  )
}
