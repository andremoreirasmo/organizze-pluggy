import { useEffect, useMemo, useRef, useState } from 'react'
import { PickerPortal } from './PickerPortal'

export type CategoryOption = {
  id: number
  name: string
  color: string | number | null
  parent_id: number | null
  group_id: string | number | null
  kind?: string | null
  archived?: boolean
}

type Props = {
  categories: CategoryOption[]
  value: string
  onChange: (categoryId: string) => void
  /** When amount is negative, only expenses; when positive, only earnings */
  amountCents: number
  disabled?: boolean
  placeholder?: string
}

const GROUP_ICONS: Record<string, string> = {
  // Organizze group_ids (expenses)
  food: '🍽️',
  exp_groceries: '🛒',
  exp_bars_and_restaurants: '🍻',
  transportation: '🚌',
  transport: '🚌',
  car: '🚗',
  fuel: '⛽',
  exp_education: '📚',
  exp_book: '📖',
  exp_health: '🩺',
  exp_home: '🏠',
  exp_apartment: '🏢',
  housing: '🏡',
  entertainment: '🎮',
  leisure: '🎮',
  exp_shopping: '🛍️',
  exp_clothing: '👕',
  clothes: '👕',
  exp_personal_care: '💅',
  personal_care: '💅',
  exp_pets: '🐾',
  pets: '🐾',
  travel: '✈️',
  exp_subscriptions_and_services: '🔁',
  subscriptions: '🔁',
  services: '🧰',
  bills: '🧾',
  exp_taxes: '🏛️',
  taxes: '🏛️',
  exp_investments: '📈',
  investments: '📈',
  exp_family_and_children: '👨‍👩‍👧‍👦',
  exp_people: '👥',
  exp_gifts_and_donations: '🎁',
  exp_debts_and_loans: '💳',
  exp_loans: '💳',
  loans: '💳',
  exp_work: '💼',
  exp_favorite: '⭐',
  invoice_payment: '💳',
  other: '🏷️',
  others: '🏷️',
  // earnings
  salary: '💼',
  ear_group: '💰',
  ear_currency: '💵',
  earning_investments: '📈',
  other_earnings: '💰',
  earnings: '💰',
  income: '💰',
  // transfers / misc
  transference: '↔️',
  transfer: '↔️',
  // legacy/fallback keys
  groceries: '🛒',
  bars_and_restaurants: '🍻',
  education: '📚',
  health: '🩺',
  home: '🏠',
  shopping: '🛍️',
  family: '👨‍👩‍👧‍👦',
  people: '👥',
  gifts: '🎁',
}

function categoryColor(color: string | number | null | undefined): string {
  if (color == null || color === '') {
    return '#6b7168'
  }
  const raw = String(color).replace(/^#/, '')
  if (/^[0-9a-fA-F]{6}$/.test(raw)) {
    return `#${raw}`
  }
  if (typeof color === 'number') {
    return `#${color.toString(16).padStart(6, '0')}`
  }
  return '#6b7168'
}

function groupIcon(groupId: string | number | null | undefined): string {
  if (groupId == null) {
    return '🏷️'
  }
  const key = String(groupId).toLowerCase()
  if (GROUP_ICONS[key]) {
    return GROUP_ICONS[key]
  }
  // Prefer longer/more specific keys first (exp_family_and_children before family)
  const matches = Object.entries(GROUP_ICONS)
    .filter(([group]) => key.includes(group) || group.includes(key))
    .sort((a, b) => b[0].length - a[0].length)
  if (matches[0]) {
    return matches[0][1]
  }
  return '🏷️'
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
}

export function CategoryPicker({
  categories,
  value,
  onChange,
  amountCents,
  disabled = false,
  placeholder = 'Buscar categoria…',
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const wantedKind = amountCents < 0 ? 'expenses' : 'earnings'

  const usable = useMemo(() => {
    const isArchived = (value: unknown): boolean =>
      value === true || value === 1 || value === '1' || value === 'true'

    const active = categories.filter((category) => !isArchived(category.archived))
    const activeIds = new Set(active.map((category) => category.id))

    return active.filter((category) => {
      // Hide orphaned children whose parent was archived/removed
      if (
        category.parent_id != null &&
        !activeIds.has(category.parent_id) &&
        categories.some(
          (candidate) =>
            candidate.id === category.parent_id && isArchived(candidate.archived),
        )
      ) {
        return false
      }

      const kind = (category.kind ?? 'none').toLowerCase()
      if (kind === 'none') {
        return true
      }
      return kind === wantedKind
    })
  }, [categories, wantedKind])

  const byId = useMemo(() => {
    const map = new Map<number, CategoryOption>()
    for (const category of usable) {
      map.set(category.id, category)
    }
    return map
  }, [usable])

  const selected = value ? (byId.get(Number(value)) ?? null) : null

  const selectedLabel = useMemo(() => {
    if (!selected) {
      return null
    }
    if (selected.parent_id) {
      const parent = byId.get(selected.parent_id)
      return parent ? `${parent.name} › ${selected.name}` : selected.name
    }
    return selected.name
  }, [selected, byId])

  const rows = useMemo(() => {
    const q = normalize(query)
    const parents = usable
      .filter((category) => category.parent_id == null)
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))

    const childrenByParent = new Map<number, CategoryOption[]>()
    for (const category of usable) {
      if (category.parent_id == null) {
        continue
      }
      const list = childrenByParent.get(category.parent_id) ?? []
      list.push(category)
      childrenByParent.set(category.parent_id, list)
    }
    for (const list of childrenByParent.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
    }

    const result: Array<{
      category: CategoryOption
      parentName: string | null
      depth: 0 | 1
    }> = []

    for (const parent of parents) {
      const children = childrenByParent.get(parent.id) ?? []
      const parentMatch = !q || normalize(parent.name).includes(q)
      const matchedChildren = q
        ? children.filter((child) => normalize(child.name).includes(q))
        : children

      if (parentMatch || matchedChildren.length > 0) {
        if (parentMatch || !q) {
          result.push({ category: parent, parentName: null, depth: 0 })
        }
        for (const child of q ? matchedChildren : children) {
          result.push({
            category: child,
            parentName: parent.name,
            depth: 1,
          })
        }
      }
    }

    for (const category of usable) {
      if (category.parent_id == null) {
        continue
      }
      if (byId.has(category.parent_id)) {
        continue
      }
      if (q && !normalize(category.name).includes(q)) {
        continue
      }
      result.push({ category, parentName: null, depth: 0 })
    }

    return result
  }, [usable, query, byId])

  useEffect(() => {
    if (selected && !usable.some((category) => category.id === selected.id)) {
      onChange('')
    }
  }, [selected, usable, onChange])

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
            <span
              className="cat-icon"
              style={{ background: `${categoryColor(selected.color)}22` }}
            >
              {groupIcon(selected.group_id)}
            </span>
            <span className="picker-value-text">
              <strong>{selectedLabel}</strong>
              <small>
                {wantedKind === 'expenses' ? 'Despesa' : 'Receita'}
              </small>
            </span>
          </span>
        ) : (
          <span className="picker-placeholder">
            Escolher categoria ({wantedKind === 'expenses' ? 'despesa' : 'receita'})
          </span>
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
          placeholder={placeholder}
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
            <span>Sem categoria</span>
          </button>
          {rows.length === 0 ? (
            <p className="picker-empty">Nenhuma categoria encontrada</p>
          ) : (
            rows.map(({ category, parentName, depth }) => {
              const selectedRow = String(category.id) === value
              return (
                <button
                  key={category.id}
                  type="button"
                  className={`picker-option ${depth === 1 ? 'child' : ''} ${
                    selectedRow ? 'selected' : ''
                  }`}
                  onClick={() => {
                    onChange(String(category.id))
                    setOpen(false)
                    setQuery('')
                  }}
                >
                  <span
                    className="cat-icon"
                    style={{
                      background: `${categoryColor(category.color)}22`,
                    }}
                  >
                    {groupIcon(category.group_id)}
                  </span>
                  <span className="picker-option-text">
                    <strong>{category.name}</strong>
                    {parentName ? <small>{parentName}</small> : null}
                  </span>
                  <span
                    className="cat-dot"
                    style={{ background: categoryColor(category.color) }}
                  />
                </button>
              )
            })
          )}
        </div>
      </PickerPortal>
    </div>
  )
}
