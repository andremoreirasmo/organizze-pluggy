import { useMemo, useRef, useState } from 'react'
import { PickerPortal } from './PickerPortal'

export type FilterDropdownOption = {
  value: string
  label: string
}

type Props = {
  label: string
  value: string
  options: FilterDropdownOption[]
  onChange: (value: string) => void
  disabled?: boolean
  /** Show search when there are many options */
  searchable?: boolean
  searchPlaceholder?: string
  minWidth?: number
}

export function FilterDropdown({
  label,
  value,
  options,
  onChange,
  disabled = false,
  searchable = false,
  searchPlaceholder = 'Buscar…',
  minWidth = 168,
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const selected = options.find((option) => option.value === value)
  const triggerText = selected?.label ?? label

  const filtered = useMemo(() => {
    if (!searchable) {
      return options
    }
    const q = query
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .trim()
    if (!q) {
      return options
    }
    return options.filter((option) =>
      option.label
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .includes(q),
    )
  }, [options, query, searchable])

  return (
    <div className={`recon-filter-dropdown${open ? ' is-open' : ''}${value ? ' has-value' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="recon-filter-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="recon-filter-trigger-text">{triggerText}</span>
        <span className="recon-filter-caret" aria-hidden />
      </button>

      <PickerPortal
        open={open}
        triggerRef={triggerRef}
        panelRef={panelRef}
        minWidth={minWidth}
        onClose={() => {
          setOpen(false)
          setQuery('')
        }}
      >
        <div className="recon-filter-menu" role="listbox" aria-label={label}>
          {searchable ? (
            <input
              className="picker-search"
              value={query}
              autoFocus
              placeholder={searchPlaceholder}
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : null}
          <div className="picker-list">
            <button
              type="button"
              role="option"
              aria-selected={value === ''}
              className={`picker-option${value === '' ? ' selected' : ''}`}
              onClick={() => {
                onChange('')
                setOpen(false)
                setQuery('')
              }}
            >
              <span className="picker-option-text">
                <strong>Todas</strong>
              </span>
            </button>
            {filtered.length === 0 ? (
              <p className="picker-empty">Nenhuma opção</p>
            ) : (
              filtered.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={value === option.value}
                  className={`picker-option${value === option.value ? ' selected' : ''}`}
                  onClick={() => {
                    onChange(option.value)
                    setOpen(false)
                    setQuery('')
                  }}
                >
                  <span className="picker-option-text">
                    <strong>{option.label}</strong>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </PickerPortal>
    </div>
  )
}
