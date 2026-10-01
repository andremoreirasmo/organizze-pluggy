import { useMemo, useRef, useState } from 'react'
import { PickerPortal } from './PickerPortal'

export type CreditCardOption = {
  id: number
  name: string
}

type Props = {
  cards: CreditCardOption[]
  value: string
  onChange: (cardId: string) => void
  disabled?: boolean
}

export function CreditCardPicker({
  cards,
  value,
  onChange,
  disabled = false,
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const selected = cards.find((card) => String(card.id) === value)

  const filtered = useMemo(() => {
    const q = query
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .trim()
    if (!q) {
      return cards
    }
    return cards.filter((card) =>
      card.name
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .includes(q),
    )
  }, [cards, query])

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
            <span className="cat-icon">💳</span>
            <span className="picker-value-text">
              <strong>{selected.name}</strong>
              <small>Cartão Organizze</small>
            </span>
          </span>
        ) : (
          <span className="picker-placeholder">Escolher cartão…</span>
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
          placeholder="Buscar cartão…"
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="picker-list">
          <button
            type="button"
            className={`picker-option ${value === '' ? 'selected' : ''}`}
            onClick={() => {
              onChange('')
              setOpen(false)
              setQuery('')
            }}
          >
            <span className="cat-icon muted">—</span>
            <span>Nenhum</span>
          </button>
          {filtered.map((card) => (
            <button
              key={card.id}
              type="button"
              className={`picker-option ${
                String(card.id) === value ? 'selected' : ''
              }`}
              onClick={() => {
                onChange(String(card.id))
                setOpen(false)
                setQuery('')
              }}
            >
              <span className="cat-icon">💳</span>
              <span className="picker-option-text">
                <strong>{card.name}</strong>
              </span>
            </button>
          ))}
        </div>
      </PickerPortal>
    </div>
  )
}
