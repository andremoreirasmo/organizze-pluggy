export type MoneyMaskOptions = {
  /** Allow a leading minus for signed amounts (default false). */
  allowNegative?: boolean
  /** Max digits (as integer cents). Default 12 → up to R$ 9.999.999.999,99 */
  maxDigits?: number
}

/**
 * Format integer cents as pt-BR money text (without currency symbol).
 * Example: 4300 → "43,00"; -150 → "-1,50"
 */
export function formatBrlFromCents(
  cents: number,
  allowNegative = false,
): string {
  const negative = allowNegative && cents < 0
  const abs = Math.abs(Math.trunc(cents))
  const formatted = (abs / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return negative ? `-${formatted}` : formatted
}

/**
 * Digits-as-cents mask used while typing. "4300" → display "43,00", cents 4300.
 */
export function maskBrlInput(
  raw: string,
  options: MoneyMaskOptions = {},
): string {
  return maskBrlInputDetailed(raw, options).display
}

export function maskBrlInputDetailed(
  raw: string,
  options: MoneyMaskOptions = {},
): { display: string; cents: number | null } {
  const allowNegative = options.allowNegative === true
  const maxDigits = options.maxDigits ?? 12
  const trimmed = raw.trim()
  const negative = allowNegative && /^-/.test(trimmed)
  const digits = trimmed.replace(/\D/g, '').replace(/^0+(?=\d)/, '')
  if (!digits) {
    return { display: negative ? '-' : '', cents: null }
  }
  const clipped = digits.slice(0, maxDigits)
  const magnitude = Number(clipped)
  if (!Number.isFinite(magnitude)) {
    return { display: negative ? '-' : '', cents: null }
  }
  const cents = negative ? -magnitude : magnitude
  return {
    display: formatBrlFromCents(cents, allowNegative),
    cents,
  }
}

/** Parse a masked (or free) BRL field into integer cents. */
export function parseMaskedBrlToCents(
  value: string,
  options: MoneyMaskOptions = {},
): number | null {
  return maskBrlInputDetailed(value, options).cents
}
