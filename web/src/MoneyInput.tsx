import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type InputHTMLAttributes,
} from 'react'
import {
  formatBrlFromCents,
  maskBrlInputDetailed,
} from './moneyMask'

type Props = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type' | 'inputMode'
> & {
  /** Integer cents; `null` shows an empty field. */
  valueCents: number | null
  onChangeCents: (cents: number | null) => void
  allowNegative?: boolean
}

function selectAllOnFocus(event: FocusEvent<HTMLInputElement>) {
  event.currentTarget.select()
}

/**
 * BRL amount field with automatic digits-as-cents masking (type 4350 → 43,50).
 */
export function MoneyInput({
  valueCents,
  onChangeCents,
  allowNegative = false,
  onFocus,
  placeholder = '0,00',
  ...rest
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(() =>
    valueCents == null ? '' : formatBrlFromCents(valueCents, allowNegative),
  )

  useEffect(() => {
    setText(
      valueCents == null ? '' : formatBrlFromCents(valueCents, allowNegative),
    )
  }, [valueCents, allowNegative])

  return (
    <input
      {...rest}
      ref={inputRef}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      placeholder={placeholder}
      value={text}
      onFocus={(event) => {
        selectAllOnFocus(event)
        onFocus?.(event)
      }}
      onChange={(event) => {
        const masked = maskBrlInputDetailed(event.target.value, {
          allowNegative,
        })
        setText(masked.display)
        onChangeCents(masked.cents)
        // Keep caret at the end so the next digit appends (cents mask), not prepends.
        const el = inputRef.current
        const caret = masked.display.length
        requestAnimationFrame(() => {
          el?.setSelectionRange(caret, caret)
        })
      }}
    />
  )
}
