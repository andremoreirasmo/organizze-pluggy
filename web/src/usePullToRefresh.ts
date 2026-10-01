import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

const PULL_THRESHOLD_PX = 78
const MAX_PULL_PX = 96
const RESISTANCE = 0.55

type PullToRefreshOptions = {
  onRefresh: () => Promise<void> | void
  disabled?: boolean
}

export type PullToRefreshState = {
  containerRef: RefObject<HTMLDivElement | null>
  pullDistance: number
  refreshing: boolean
  pulling: boolean
}

function scrollTop(): number {
  return (
    window.scrollY ||
    document.documentElement.scrollTop ||
    document.body.scrollTop ||
    0
  )
}

function isInsideOverlay(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest('.sheet-backdrop, .sheet-card, .modal-backdrop, .modal-card'))
  )
}

/**
 * Pull-down refresh for document-scrolling screens.
 * Starts only when the page is at the top and the gesture is vertical.
 */
export function usePullToRefresh({
  onRefresh,
  disabled = false,
}: PullToRefreshOptions): PullToRefreshState {
  const containerRef = useRef<HTMLDivElement>(null)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh

  const startYRef = useRef(0)
  const startXRef = useRef(0)
  const pullingRef = useRef(false)
  const lockedRef = useRef(false)
  const rawDyRef = useRef(0)

  const [pullDistance, setPullDistance] = useState(0)
  const [pulling, setPulling] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const resetPull = useCallback(() => {
    pullingRef.current = false
    lockedRef.current = false
    rawDyRef.current = 0
    setPulling(false)
    setPullDistance(0)
  }, [])

  const runRefresh = useCallback(async () => {
    if (refreshing) {
      return
    }
    setRefreshing(true)
    setPullDistance(52)
    try {
      await onRefreshRef.current()
    } finally {
      setRefreshing(false)
      resetPull()
    }
  }, [refreshing, resetPull])

  useEffect(() => {
    const node = containerRef.current
    if (!node || disabled) {
      resetPull()
      return
    }

    const onTouchStart = (event: TouchEvent) => {
      if (
        refreshing ||
        event.touches.length !== 1 ||
        scrollTop() > 1 ||
        isInsideOverlay(event.target)
      ) {
        lockedRef.current = true
        return
      }
      const touch = event.touches[0]
      startYRef.current = touch.clientY
      startXRef.current = touch.clientX
      pullingRef.current = false
      lockedRef.current = false
      rawDyRef.current = 0
    }

    const onTouchMove = (event: TouchEvent) => {
      if (refreshing || event.touches.length !== 1 || lockedRef.current) {
        return
      }
      const touch = event.touches[0]
      const dy = touch.clientY - startYRef.current
      const dx = touch.clientX - startXRef.current

      if (!pullingRef.current) {
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) {
          lockedRef.current = true
          return
        }
        if (dy < 10 || scrollTop() > 1) {
          return
        }
        pullingRef.current = true
        setPulling(true)
      }

      if (!pullingRef.current) {
        return
      }

      event.preventDefault()
      rawDyRef.current = Math.max(0, dy)
      setPullDistance(Math.min(MAX_PULL_PX, rawDyRef.current * RESISTANCE))
    }

    const onTouchEnd = () => {
      if (!pullingRef.current) {
        resetPull()
        return
      }
      if (rawDyRef.current >= PULL_THRESHOLD_PX) {
        void runRefresh()
        return
      }
      resetPull()
    }

    node.addEventListener('touchstart', onTouchStart, { passive: true })
    node.addEventListener('touchmove', onTouchMove, { passive: false })
    node.addEventListener('touchend', onTouchEnd)
    node.addEventListener('touchcancel', onTouchEnd)
    return () => {
      node.removeEventListener('touchstart', onTouchStart)
      node.removeEventListener('touchmove', onTouchMove)
      node.removeEventListener('touchend', onTouchEnd)
      node.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [disabled, refreshing, resetPull, runRefresh])

  return {
    containerRef,
    pullDistance,
    refreshing,
    pulling,
  }
}
