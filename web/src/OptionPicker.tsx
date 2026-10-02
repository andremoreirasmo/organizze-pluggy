import { useMemo, useRef, useState } from 'react'
import { PickerPortal } from './PickerPortal'

export type OptionPickerItem = {
  value: string
  label: string
  hint?: string
}

type Props = {
  value: string
  options: OptionPickerItem[]
  onChange: (value: string) => void
  disabled?: boolean
  placeholder?: string
  searchable?: boolean
  minWidth?: number
}

export function OptionPicker({
  value,
  options,
  onChange,
  disabled = false,
  placeholder = 'Escolher…',
  searchable = false,
  minWidth,
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const selected = options.find((option) => option.value === value)

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
    <div className={`picker ${open ? 'open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="picker-trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {selected ? (
          <span className="picker-value">
            <span className="picker-value-text">
              <strong>{selected.label}</strong>
            </span>
          </span>
        ) : (
          <span className="picker-placeholder">{placeholder}</span>
        )}
        <span className="picker-caret" aria-hidden>
          ▾
        </span>
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
        {searchable ? (
          <input
            className="picker-search"
            value={query}
            autoFocus
            placeholder="Buscar…"
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : null}
        <div className="picker-list">
          {filtered.length === 0 ? (
            <p className="picker-empty">Nenhuma opção</p>
          ) : (
            filtered.map((option) => {
              const selectedRow = option.value === value
              return (
                <button
                  key={option.value || '__empty'}
                  type="button"
                  className={`picker-option ${selectedRow ? 'selected' : ''}`}
                  onClick={() => {
                    onChange(option.value)
                    setOpen(false)
                    setQuery('')
                  }}
                >
                  <span className="picker-option-text">
                    <strong>{option.label}</strong>
                    {option.hint ? <small>{option.hint}</small> : null}
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
