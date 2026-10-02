import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'

export type PickerPanelStyle = {
  top: number
  left: number
  width: number
  maxHeight: number
}

export function usePickerPanel(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
) {
  const [style, setStyle] = useState<PickerPanelStyle | null>(null)

  const update = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) {
      return
    }
    const rect = trigger.getBoundingClientRect()
    const gap = 6
    const spaceBelow = window.innerHeight - rect.bottom - gap - 12
    const spaceAbove = rect.top - gap - 12
    const preferBelow = spaceBelow >= 180 || spaceBelow >= spaceAbove
    const maxHeight = Math.max(
      160,
      Math.min(360, preferBelow ? spaceBelow : spaceAbove),
    )
    const top = preferBelow
      ? rect.bottom + gap
      : Math.max(12, rect.top - gap - maxHeight)

    setStyle({
      top,
      left: rect.left,
      width: rect.width,
      maxHeight,
    })
  }, [triggerRef])

  useLayoutEffect(() => {
    if (!open) {
      setStyle(null)
      return
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, update])

  return style
}

type PortalProps = {
  open: boolean
  triggerRef: RefObject<HTMLElement | null>
  panelRef: RefObject<HTMLDivElement | null>
  onClose: () => void
  children: ReactNode
  minWidth?: number
}

export function PickerPortal({
  open,
  triggerRef,
  panelRef,
  onClose,
  children,
  minWidth,
}: PortalProps) {
  const style = usePickerPanel(open, triggerRef)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) {
      return
    }
    const onDocClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target)) {
        return
      }
      if (panelRef.current?.contains(target)) {
        return
      }
      onCloseRef.current()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCloseRef.current()
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, triggerRef, panelRef])

  useLayoutEffect(() => {
    if (!open || !style || !panelRef.current) {
      return
    }
    const panel = panelRef.current
    const rect = panel.getBoundingClientRect()
    const overflowRight = rect.right - (window.innerWidth - 12)
    if (overflowRight > 0) {
      panel.style.left = `${Math.max(12, style.left - overflowRight)}px`
    }
  }, [open, style, panelRef, children])

  if (!open || !style) {
    return null
  }

  const minPanelWidth = Math.max(style.width, minWidth ?? 0)
  const maxPanelWidth = Math.min(window.innerWidth - 24, 420)
  const left = Math.min(
    style.left,
    Math.max(12, window.innerWidth - minPanelWidth - 12),
  )

  return createPortal(
    <div
      ref={panelRef}
      className="picker-panel picker-panel-portal"
      style={{
        top: style.top,
        left,
        minWidth: minPanelWidth,
        width: 'max-content',
        maxWidth: maxPanelWidth,
        maxHeight: style.maxHeight,
      }}
    >
      {children}
    </div>,
    document.body,
  )
}
