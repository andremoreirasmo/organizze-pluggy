import { useEffect, useMemo, useRef, useState } from 'react'
import { PickerPortal } from './PickerPortal'

export type InvoiceOption = {
  id: number
  date: string
  starting_date?: string
  closing_date?: string
  amount_cents: number
  balance_cents: number
}

type Props = {
  invoices: InvoiceOption[]
  value: string
  onChange: (invoiceId: string) => void
  onOpen?: () => void
  disabled?: boolean
  emptyLabel?: string
}

function sortInvoicesDesc(invoices: InvoiceOption[]): InvoiceOption[] {
  return [...invoices].sort((a, b) => b.date.localeCompare(a.date))
}

export function formatInvoiceDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  if (!year || !month || !day) {
    return isoDate
  }
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`
}

export function formatInvoiceMonthTitle(isoDate: string): string {
  const [year, month] = isoDate.split('-').map(Number)
  if (!year || !month) {
    return isoDate
  }
  const label = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(
    'pt-BR',
    {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    },
  )
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export function invoiceOptionLabel(invoice: InvoiceOption): {
  title: string
  subtitle: string | null
} {
  return {
    title: formatInvoiceMonthTitle(invoice.date),
    subtitle: null,
  }
}

export function InvoicePicker({
  invoices,
  value,
  onChange,
  onOpen,
  disabled = false,
  emptyLabel = 'Escolher fatura…',
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const ordered = useMemo(() => sortInvoicesDesc(invoices), [invoices])
  const selected = ordered.find((invoice) => String(invoice.id) === value)
  const selectedLabel = selected ? invoiceOptionLabel(selected) : null

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      return ordered
    }
    return ordered.filter((invoice) => {
      const label = invoiceOptionLabel(invoice)
      return `${invoice.date} ${label.title} ${label.subtitle ?? ''} ${invoice.id}`
        .toLowerCase()
        .includes(q)
    })
  }, [ordered, query])

  useEffect(() => {
    if (open) {
      onOpen?.()
    }
  }, [open, onOpen])

  return (
    <div className={`picker ${open ? 'open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="picker-trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {selectedLabel ? (
          <span className="picker-value">
            <span className="cat-icon">🗓️</span>
            <span className="picker-value-text">
              <strong>{selectedLabel.title}</strong>
              {selectedLabel.subtitle ? (
                <small>{selectedLabel.subtitle}</small>
              ) : null}
            </span>
          </span>
        ) : (
          <span className="picker-placeholder">{emptyLabel}</span>
        )}
        <span className="picker-caret" aria-hidden>
          ▾
        </span>
      </button>

      <PickerPortal
        open={open}
        triggerRef={triggerRef}
        panelRef={panelRef}
        onClose={() => {
          setOpen(false)
          setQuery('')
        }}
      >
        <input
          className="picker-search"
          value={query}
          autoFocus
          placeholder="Buscar fatura por data…"
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="picker-list">
          {filtered.length === 0 ? (
            <p className="picker-empty">Nenhuma fatura encontrada</p>
          ) : (
            filtered.map((invoice) => {
              const label = invoiceOptionLabel(invoice)
              return (
                <button
                  key={invoice.id}
                  type="button"
                  className={`picker-option ${
                    String(invoice.id) === value ? 'selected' : ''
                  }`}
                  onClick={() => {
                    onChange(String(invoice.id))
                    setOpen(false)
                    setQuery('')
                  }}
                >
                  <span className="cat-icon">🗓️</span>
                  <span className="picker-option-text">
                    <strong>{label.title}</strong>
                    {label.subtitle ? <small>{label.subtitle}</small> : null}
                  </span>
                </button>
              )
            })
          )}
        </div>
      </PickerPortal>
    </div>
  )
}
