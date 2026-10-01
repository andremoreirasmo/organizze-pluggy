import { useCallback, useEffect, useRef, useState } from 'react'

const DISMISS_DISTANCE_PX = 120
const DISMISS_VELOCITY = 0.55

type SwipeDismissOptions = {
  enabled?: boolean
}

/**
 * Drag-down dismiss for bottom sheets. Respects scroll: only starts when
 * the sheet is scrolled to the top.
 */
export function useSwipeDismiss(
  onDismiss: () => void,
  { enabled = true }: SwipeDismissOptions = {},
) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const startYRef = useRef(0)
  const startXRef = useRef(0)
  const lastYRef = useRef(0)
  const lastTsRef = useRef(0)
  const draggingRef = useRef(false)
  const lockedRef = useRef(false)
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss

  const [offsetY, setOffsetY] = useState(0)
  const [dragging, setDragging] = useState(false)

  const reset = useCallback(() => {
    draggingRef.current = false
    lockedRef.current = false
    setDragging(false)
    setOffsetY(0)
  }, [])

  useEffect(() => {
    if (!enabled) {
      reset()
    }
  }, [enabled, reset])

  useEffect(() => {
    const sheet = sheetRef.current
    if (!sheet || !enabled) {
      return
    }

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || sheet.scrollTop > 1) {
        return
      }
      const touch = event.touches[0]
      startYRef.current = touch.clientY
      startXRef.current = touch.clientX
      lastYRef.current = touch.clientY
      lastTsRef.current = performance.now()
      draggingRef.current = false
      lockedRef.current = false
    }

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        return
      }
      const touch = event.touches[0]
      const dy = touch.clientY - startYRef.current
      const dx = touch.clientX - startXRef.current

      if (!draggingRef.current) {
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) {
          lockedRef.current = true
          return
        }
        if (dy < 8 || sheet.scrollTop > 1) {
          return
        }
        draggingRef.current = true
        setDragging(true)
      }

      if (lockedRef.current || !draggingRef.current) {
        return
      }

      event.preventDefault()
      lastYRef.current = touch.clientY
      lastTsRef.current = performance.now()
      setOffsetY(Math.max(0, dy))
    }

    const onTouchEnd = () => {
      if (!draggingRef.current) {
        reset()
        return
      }
      const dy = Math.max(0, lastYRef.current - startYRef.current)
      const elapsed = Math.max(16, performance.now() - lastTsRef.current)
      const velocity = dy / elapsed
      if (dy >= DISMISS_DISTANCE_PX || velocity >= DISMISS_VELOCITY) {
        onDismissRef.current()
      }
      reset()
    }

    sheet.addEventListener('touchstart', onTouchStart, { passive: true })
    sheet.addEventListener('touchmove', onTouchMove, { passive: false })
    sheet.addEventListener('touchend', onTouchEnd)
    sheet.addEventListener('touchcancel', onTouchEnd)
    return () => {
      sheet.removeEventListener('touchstart', onTouchStart)
      sheet.removeEventListener('touchmove', onTouchMove)
      sheet.removeEventListener('touchend', onTouchEnd)
      sheet.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [enabled, reset])

  const backdropOpacity = dragging
    ? Math.max(0.25, 1 - offsetY / 420)
    : 1

  return {
    sheetRef,
    offsetY,
    dragging,
    backdropOpacity,
  }
}
