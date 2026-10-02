import { BottomSheet } from './BottomSheet'

type ConfirmDialogProps = {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  busyLabel?: string
  busy?: boolean
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  busyLabel,
  busy = false,
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <BottomSheet
      onClose={onCancel}
      busy={busy}
      title={title}
      labelledBy="confirm-dialog-title"
      className="confirm-dialog"
    >
      <p className="confirm-dialog-message">{message}</p>
      <div className="modal-actions">
        <button
          type="button"
          className="btn ghost"
          disabled={busy}
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          className={danger ? 'btn danger' : 'btn'}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? busyLabel ?? `${confirmLabel}…` : confirmLabel}
        </button>
      </div>
    </BottomSheet>
  )
}
