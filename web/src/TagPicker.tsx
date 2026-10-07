import { useEffect, useMemo, useRef, useState } from 'react'

export type TagOption = {
  name: string
}

type Props = {
  suggestions: TagOption[]
  value: string[]
  onChange: (tags: string[]) => void
  disabled?: boolean
  placeholder?: string
  maxTags?: number
  maxLength?: number
}

const DEFAULT_MAX_TAGS = 20
const DEFAULT_MAX_LENGTH = 40

function normalizeKey(name: string): string {
  return name.trim().toLowerCase()
}

function sanitizeName(raw: string, maxLength: number): string {
  return raw.trim().slice(0, maxLength)
}

export function TagPicker({
  suggestions,
  value,
  onChange,
  disabled = false,
  placeholder = 'Digite e Enter para adicionar…',
  maxTags = DEFAULT_MAX_TAGS,
  maxLength = DEFAULT_MAX_LENGTH,
}: Props) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const selectedKeys = useMemo(
    () => new Set(value.map((tag) => normalizeKey(tag))),
    [value],
  )

  const filtered = useMemo(() => {
    const q = normalizeKey(query)
    return suggestions
      .filter((tag) => {
        const key = normalizeKey(tag.name)
        if (!key || selectedKeys.has(key)) {
          return false
        }
        if (!q) {
          return true
        }
        return key.includes(q)
      })
      .slice(0, 12)
  }, [suggestions, selectedKeys, query])

  const canCreate = useMemo(() => {
    const name = sanitizeName(query, maxLength)
    if (!name || value.length >= maxTags) {
      return false
    }
    return !selectedKeys.has(normalizeKey(name))
  }, [query, maxLength, maxTags, value.length, selectedKeys])

  useEffect(() => {
    if (!open) {
      return
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) {
        return
      }
      if (rootRef.current && !rootRef.current.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const addTag = (raw: string) => {
    if (disabled || value.length >= maxTags) {
      return
    }
    const name = sanitizeName(raw, maxLength)
    if (!name || selectedKeys.has(normalizeKey(name))) {
      return
    }
    onChange([...value, name])
    setQuery('')
    setOpen(false)
    inputRef.current?.focus()
  }

  const removeTag = (name: string) => {
    if (disabled) {
      return
    }
    const key = normalizeKey(name)
    onChange(value.filter((tag) => normalizeKey(tag) !== key))
  }

  return (
    <div
      ref={rootRef}
      className={`tag-picker${disabled ? ' is-disabled' : ''}${open ? ' is-open' : ''}`}
    >
      <div
        className="tag-picker-box"
        onClick={() => {
          if (!disabled) {
            inputRef.current?.focus()
            setOpen(true)
          }
        }}
      >
        {value.map((tag) => (
          <button
            key={tag}
            type="button"
            className="tag-picker-chip"
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation()
              removeTag(tag)
            }}
            title={`Remover “${tag}”`}
          >
            <span>{tag}</span>
            <span aria-hidden className="tag-picker-chip-x">
              ×
            </span>
          </button>
        ))}
        <input
          ref={inputRef}
          className="tag-picker-input"
          value={query}
          disabled={disabled || value.length >= maxTags}
          placeholder={value.length === 0 ? placeholder : 'Mais tags…'}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault()
              if (canCreate) {
                addTag(query)
              } else if (filtered[0]) {
                addTag(filtered[0].name)
              }
              return
            }
            if (event.key === 'Backspace' && !query && value.length > 0) {
              removeTag(value[value.length - 1]!)
              return
            }
            if (event.key === 'Escape') {
              setOpen(false)
            }
          }}
        />
      </div>

      {open && !disabled && (filtered.length > 0 || canCreate) ? (
        <ul className="tag-picker-suggestions" role="listbox">
          {filtered.map((tag) => (
            <li key={tag.name}>
              <button
                type="button"
                role="option"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => addTag(tag.name)}
              >
                {tag.name}
              </button>
            </li>
          ))}
          {canCreate ? (
            <li>
              <button
                type="button"
                className="tag-picker-create"
                role="option"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => addTag(query)}
              >
                Criar “{sanitizeName(query, maxLength)}”
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}
