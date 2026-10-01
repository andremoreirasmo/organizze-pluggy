import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { BottomSheet } from './BottomSheet'
import { CategoryPicker, type CategoryOption } from './CategoryPicker'
import { CreditCardPicker } from './CreditCardPicker'
import { FilterDropdown } from './FilterDropdown'
import {
  InvoicePicker,
  formatInvoiceDate,
  invoiceOptionLabel,
} from './InvoicePicker'
import { PullToRefresh } from './PullToRefresh'
import {
  patchSearchParams,
  readAccountParam,
  readKindParam,
  readMonthParam,
  readQueryParam,
  ROUTES,
  type ReconciliationKindFilter,
} from './routes'

export type ReconciliationKind =
  | 'bank'
  | 'credit_purchase'
  | 'invoice_payment_candidate'
  | 'same_person_transfer'

export type TransferCounterpartHint = {
  pluggyId: string
  accountName: string
  accountNickname: string | null
  accountNumberLast4: string | null
  mappedOrganizzeTargetId: number
  organizzeAmountCents: number
  date: string
}

export type MatchCandidate = {
  organizzeTransactionId: number
  description: string
  date: string
  amountCents: number
  paid: boolean
  recurring: boolean
  accountId: number | null
  accountName: string | null
  creditCardId: number | null
  creditCardName: string | null
  creditCardInvoiceId: number | null
  categoryId: number | null
  categoryName: string | null
  installment: number | null
  totalInstallments: number | null
  score: number
  amountDiffCents: number
  daysDiff: number
}

export type QueuePluggyTransaction = {
  id: string
  description: string
  amount: number
  amountCents: number
  organizzeAmountCents: number
  date: string
  currencyCode: string | null
  amountInAccountCurrency: number | null
  amountInAccountCurrencyCents: number | null
  kind: ReconciliationKind
  accountName: string
  accountType: string | null
  mappedTargetType: 'account' | 'credit_card'
  mappedOrganizzeTargetId: number
  accountNumberLast4: string | null
  accountOwner: string | null
  accountNickname: string | null
  category: string | null
  operationType: string | null
  installmentNumber: number | null
  totalInstallments: number | null
  purchaseDate: string | null
  totalPurchaseAmount: number | null
  transferCounterpart: TransferCounterpartHint | null
}

export type ReconciliationQueueItem = {
  pluggy: QueuePluggyTransaction
  suggestions: MatchCandidate[]
}

export type ReconciliationQueueResponse = {
  from: string
  to: string
  items: ReconciliationQueueItem[]
  unmappedPluggyAccounts: Array<{
    id: string
    name: string
    type: string | null
    subtype: string | null
  }>
}

export type IgnoredSnapshot = {
  description: string
  amountCents: number
  organizzeAmountCents: number
  date: string
  accountName: string
  kind: ReconciliationKind
  installmentNumber: number | null
  totalInstallments: number | null
}

export type IgnoredItem = {
  id: string
  pluggyTransactionId: string
  providerId: string | null
  notes: string | null
  createdAt: string
  snapshot: IgnoredSnapshot | null
}

export type OrganizzeCategory = CategoryOption

export type OrganizzeCreditCard = {
  id: number
  name: string
  archived: boolean
}

export type OrganizzeAccount = {
  id: number
  name: string
  archived: boolean
}

export type OrganizzeInvoice = {
  id: number
  date: string
  starting_date: string
  closing_date: string
  amount_cents: number
  balance_cents: number
  credit_card_id: number
}

type OrganizzeTransactionRow = {
  id: number
  description: string
  date: string
  paid: boolean
  amount_cents: number
  total_installments: number
  installment: number
  recurring: boolean
  account_id: number | null
  category_id: number | null
  notes: string | null
  credit_card_id: number | null
  credit_card_invoice_id: number | null
}

type ApiFetch = <T>(path: string, init?: RequestInit) => Promise<T>

type ActionKind = 'link' | 'import' | 'invoice' | 'ignore' | 'transfer'

type ActionState = {
  pluggyId: string
  kind: ActionKind
  candidateId: number | null
  phase: 'working' | 'refreshing'
  message: string
}

function monthBounds(yearMonth: string): { from: string; to: string } {
  const [year, month] = yearMonth.split('-').map(Number)
  const from = `${yearMonth}-01`
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const to = `${yearMonth}-${String(lastDay).padStart(2, '0')}`
  return { from, to }
}

function currentYearMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function formatBRL(amountCents: number): string {
  return (amountCents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
}

function formatSignedAmountInput(amountCents: number): string {
  const abs = Math.abs(amountCents / 100)
  const formatted = abs.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return amountCents < 0 ? `-${formatted}` : formatted
}

function formatUnsignedAmountInput(amountCents: number): string {
  return (Math.abs(amountCents) / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function parseSignedBRLInputToCents(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  let body = trimmed
  const negative = body.startsWith('-')
  if (negative) {
    body = body.slice(1).trim()
  }
  if (!body) {
    return null
  }
  let amount: number
  if (body.includes(',')) {
    amount = Number(body.replace(/\./g, '').replace(',', '.'))
  } else {
    amount = Number(body)
  }
  if (!Number.isFinite(amount)) {
    return null
  }
  const cents = Math.round(amount * 100)
  return negative ? -cents : cents
}

function parseUnsignedBRLInputToCents(value: string): number | null {
  const signed = parseSignedBRLInputToCents(value)
  if (signed === null) {
    return null
  }
  return Math.abs(signed)
}

function formatMoney(amountCents: number, currencyCode: string): string {
  const code = currencyCode.trim().toUpperCase() || 'BRL'
  try {
    return (amountCents / 100).toLocaleString('pt-BR', {
      style: 'currency',
      currency: code,
    })
  } catch {
    return `${code} ${(amountCents / 100).toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  }
}

function isForeignCurrency(currencyCode: string | null | undefined): boolean {
  return Boolean(currencyCode && currencyCode.toUpperCase() !== 'BRL')
}

function PluggyAmountDisplay({
  pluggy,
  className,
}: {
  pluggy: Pick<
    QueuePluggyTransaction,
    | 'organizzeAmountCents'
    | 'amountCents'
    | 'currencyCode'
    | 'amountInAccountCurrencyCents'
  >
  className?: string
}) {
  const foreign = isForeignCurrency(pluggy.currencyCode)
  const currency = (pluggy.currencyCode ?? 'BRL').toUpperCase()
  const signClass = pluggy.organizzeAmountCents < 0 ? 'neg' : 'pos'

  if (foreign) {
    const original = formatMoney(pluggy.amountCents, currency)
    const converted =
      pluggy.amountInAccountCurrencyCents !== null &&
      pluggy.amountInAccountCurrencyCents !== undefined
        ? formatBRL(pluggy.organizzeAmountCents)
        : null
    return (
      <div className={`recon-amount${className ? ` ${className}` : ''} ${signClass}`}>
        <strong>{original}</strong>
        {converted ? <span className="recon-amount-fx">≈ {converted}</span> : null}
      </div>
    )
  }

  return (
    <div className={`recon-amount${className ? ` ${className}` : ''} ${signClass}`}>
      {formatBRL(pluggy.organizzeAmountCents)}
    </div>
  )
}

function formatDateBR(isoDate: string): string {
  return formatInvoiceDate(isoDate)
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function shiftIsoDate(isoDate: string, days: number): string {
  const utc = new Date(`${isoDate.slice(0, 10)}T12:00:00Z`)
  utc.setUTCDate(utc.getUTCDate() + days)
  return utc.toISOString().slice(0, 10)
}

const PLUGGY_NOTE_RE = /\[pluggy:[0-9a-fA-F-]{36}\]/

function notesAlreadyLinked(notes: string | null): boolean {
  return Boolean(notes && PLUGGY_NOTE_RE.test(notes))
}

function toSearchCandidate(
  tx: OrganizzeTransactionRow,
  pluggy: QueuePluggyTransaction,
  accounts: OrganizzeAccount[],
  cards: OrganizzeCreditCard[],
  categories: OrganizzeCategory[],
): MatchCandidate {
  const date = tx.date.slice(0, 10)
  return {
    organizzeTransactionId: tx.id,
    description: tx.description,
    date,
    amountCents: tx.amount_cents,
    paid: tx.paid,
    recurring: tx.recurring,
    accountId: tx.account_id,
    accountName:
      accounts.find((account) => account.id === tx.account_id)?.name ?? null,
    creditCardId: tx.credit_card_id,
    creditCardName:
      cards.find((card) => card.id === tx.credit_card_id)?.name ?? null,
    creditCardInvoiceId: tx.credit_card_invoice_id,
    categoryId: tx.category_id,
    categoryName:
      categories.find((category) => category.id === tx.category_id)?.name ??
      null,
    installment: tx.installment > 0 ? tx.installment : null,
    totalInstallments:
      tx.total_installments > 0 ? tx.total_installments : null,
    score: 0,
    amountDiffCents: Math.abs(
      Math.abs(tx.amount_cents) - Math.abs(pluggy.organizzeAmountCents),
    ),
    daysDiff: Math.abs(signedDaysBetween(pluggy.date.slice(0, 10), date)),
  }
}

function signedDaysBetween(fromIso: string, toIso: string): number {
  const from = Date.UTC(
    Number(fromIso.slice(0, 4)),
    Number(fromIso.slice(5, 7)) - 1,
    Number(fromIso.slice(8, 10)),
  )
  const to = Date.UTC(
    Number(toIso.slice(0, 4)),
    Number(toIso.slice(5, 7)) - 1,
    Number(toIso.slice(8, 10)),
  )
  return Math.round((to - from) / 86_400_000)
}

const WEEKDAY_NAMES = [
  'domingo',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
] as const

/** Nearby dates use weekday / hoje; farther ones use a compact or full date. */
function formatSmartDate(isoDate: string, relativeTo = todayIsoDate()): string {
  const diff = signedDaysBetween(relativeTo, isoDate)
  if (diff === 0) {
    return 'hoje'
  }
  if (diff === -1) {
    return 'ontem'
  }
  if (diff === 1) {
    return 'amanhã'
  }
  if (Math.abs(diff) <= 6) {
    const weekday = new Date(
      Date.UTC(
        Number(isoDate.slice(0, 4)),
        Number(isoDate.slice(5, 7)) - 1,
        Number(isoDate.slice(8, 10)),
      ),
    ).getUTCDay()
    return WEEKDAY_NAMES[weekday] ?? formatDateBR(isoDate)
  }

  const year = Number(isoDate.slice(0, 4))
  const relativeYear = Number(relativeTo.slice(0, 4))
  if (year === relativeYear) {
    return `${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}`
  }
  return formatDateBR(isoDate)
}

function candidateDestination(candidate: MatchCandidate): string | null {
  if (candidate.creditCardName) {
    return candidate.creditCardName
  }
  if (candidate.accountName) {
    return candidate.accountName
  }
  return null
}

function formatPluggyAccountLabel(pluggy: {
  accountName: string
  accountNumberLast4?: string | null
  accountOwner?: string | null
  accountNickname?: string | null
}): string {
  const parts = [pluggy.accountNickname?.trim() || pluggy.accountName]
  if (pluggy.accountNumberLast4) {
    parts.push(`final ${pluggy.accountNumberLast4}`)
  } else if (!pluggy.accountNickname?.trim() && pluggy.accountOwner) {
    const firstName = pluggy.accountOwner.trim().split(/\s+/)[0]
    if (firstName) {
      parts.push(firstName)
    }
  }
  return parts.join(' · ')
}

/** Group filter by Organizze destination (bank/card), not physical card last4. */
function accountFilterKey(pluggy: QueuePluggyTransaction): string {
  return `${pluggy.mappedTargetType}|${pluggy.mappedOrganizzeTargetId}`
}

function organizzeDestinationLabel(
  pluggy: QueuePluggyTransaction,
  creditCards: OrganizzeCreditCard[],
  accounts: OrganizzeAccount[],
): string {
  if (pluggy.mappedTargetType === 'credit_card') {
    const card = creditCards.find(
      (entry) => entry.id === pluggy.mappedOrganizzeTargetId,
    )
    return card?.name ?? `Cartão #${pluggy.mappedOrganizzeTargetId}`
  }
  const account = accounts.find(
    (entry) => entry.id === pluggy.mappedOrganizzeTargetId,
  )
  return account?.name ?? `Conta #${pluggy.mappedOrganizzeTargetId}`
}

function formatMonthTitle(yearMonth: string): string {
  const [year, month] = yearMonth.split('-').map(Number)
  if (!year || !month) {
    return yearMonth
  }
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function sortInvoicesDesc(invoices: OrganizzeInvoice[]): OrganizzeInvoice[] {
  return [...invoices].sort((a, b) => b.date.localeCompare(a.date))
}

/** Prefer invoice covering the tx date; else today; else newest open; else newest. */
function pickCurrentInvoice(
  invoices: OrganizzeInvoice[],
  referenceDate: string,
): OrganizzeInvoice | null {
  if (invoices.length === 0) {
    return null
  }
  const sorted = sortInvoicesDesc(invoices)
  const coveringRef = sorted.find(
    (invoice) =>
      invoice.starting_date <= referenceDate &&
      referenceDate <= invoice.closing_date,
  )
  if (coveringRef) {
    return coveringRef
  }
  const today = new Date().toISOString().slice(0, 10)
  const coveringToday = sorted.find(
    (invoice) =>
      invoice.starting_date <= today && today <= invoice.closing_date,
  )
  if (coveringToday) {
    return coveringToday
  }
  const open = sorted.find((invoice) => invoice.closing_date >= today)
  if (open) {
    return open
  }
  return sorted[0] ?? null
}

function kindLabel(kind: ReconciliationKind): string {
  if (kind === 'credit_purchase') return 'Cartão'
  if (kind === 'invoice_payment_candidate') return 'Pagamento fatura'
  if (kind === 'same_person_transfer') return 'Transferência'
  return 'Conta'
}

function installmentLabel(tx: QueuePluggyTransaction): string | null {
  const total = tx.totalInstallments ?? 0
  const current = tx.installmentNumber ?? 0
  if (total > 1 && current > 0) {
    return `Parcela ${current}/${total}`
  }
  if (total > 1) {
    return `Parcelado em ${total}x`
  }
  return null
}

function kindClass(kind: ReconciliationKind): string {
  if (kind === 'credit_purchase') return 'kind-credit'
  if (kind === 'invoice_payment_candidate') return 'kind-invoice'
  if (kind === 'same_person_transfer') return 'kind-transfer'
  return 'kind-bank'
}

/** Invoice payment only for detected candidates or bank outflows (never income). */
function canOfferInvoicePayment(pluggy: QueuePluggyTransaction): boolean {
  if (pluggy.kind === 'invoice_payment_candidate') {
    return true
  }
  return pluggy.kind === 'bank' && pluggy.organizzeAmountCents < 0
}

function isSamePersonTransfer(pluggy: QueuePluggyTransaction): boolean {
  return pluggy.kind === 'same_person_transfer'
}

function formatTransferAccountHint(hint: TransferCounterpartHint): string {
  const nick = hint.accountNickname?.trim()
  if (nick) {
    return nick
  }
  const last4 = hint.accountNumberLast4
  return last4 ? `${hint.accountName} · final ${last4}` : hint.accountName
}

type Props = {
  apiFetch: ApiFetch
  onError: (message: string | null) => void
}

export function ReconciliationView({ apiFetch, onError }: Props) {
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const isActive =
    location.pathname === ROUTES.reconcile ||
    location.pathname === '/' ||
    location.pathname === ''
  const wasActiveRef = useRef(isActive)

  const [yearMonth, setYearMonth] = useState(
    () =>
      readMonthParam(new URLSearchParams(window.location.search)) ??
      currentYearMonth(),
  )
  const [queue, setQueue] = useState<ReconciliationQueueResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [filterAccountKey, setFilterAccountKey] = useState(
    () => readAccountParam(new URLSearchParams(window.location.search)) ?? '',
  )
  const [filterKind, setFilterKind] = useState<ReconciliationKindFilter>(
    () => readKindParam(new URLSearchParams(window.location.search)),
  )
  const [filterQuery, setFilterQuery] = useState(
    () => readQueryParam(new URLSearchParams(window.location.search)) ?? '',
  )
  const [searchOpen, setSearchOpen] = useState(() =>
    Boolean(readQueryParam(new URLSearchParams(window.location.search))),
  )
  const [action, setAction] = useState<ActionState | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [categories, setCategories] = useState<OrganizzeCategory[]>([])
  const [creditCards, setCreditCards] = useState<OrganizzeCreditCard[]>([])
  const [organizzeAccounts, setOrganizzeAccounts] = useState<
    OrganizzeAccount[]
  >([])
  const [invoicesByCard, setInvoicesByCard] = useState<
    Record<number, OrganizzeInvoice[]>
  >({})
  const [createItem, setCreateItem] = useState<ReconciliationQueueItem | null>(
    null,
  )
  const [searchItem, setSearchItem] = useState<ReconciliationQueueItem | null>(
    null,
  )
  const [searchQuery, setSearchQuery] = useState('')
  const [searchRows, setSearchRows] = useState<OrganizzeTransactionRow[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchLinkAmount, setSearchLinkAmount] = useState('')
  const [searchOnlyMapped, setSearchOnlyMapped] = useState(true)
  const [linkAmountInputs, setLinkAmountInputs] = useState<
    Record<string, string>
  >({})
  const [ignoredOpen, setIgnoredOpen] = useState(false)
  const [ignoredItems, setIgnoredItems] = useState<IgnoredItem[]>([])
  const [ignoredLoading, setIgnoredLoading] = useState(false)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [importDescription, setImportDescription] = useState('')
  const [importAmount, setImportAmount] = useState('')
  const [importCategoryId, setImportCategoryId] = useState('')
  const [invoiceCardId, setInvoiceCardId] = useState('')
  const [invoiceId, setInvoiceId] = useState('')
  const [transferOtherAccountId, setTransferOtherAccountId] = useState('')

  const range = useMemo(() => monthBounds(yearMonth), [yearMonth])
  const ignoredInMonth = useMemo(
    () =>
      ignoredItems.filter((item) => {
        const date = item.snapshot?.date
        if (!date) {
          return true
        }
        return date >= range.from && date <= range.to
      }),
    [ignoredItems, range.from, range.to],
  )

  const accountFilterOptions = useMemo(() => {
    if (!queue) {
      return []
    }
    const labels = new Map<string, string>()
    for (const item of queue.items) {
      const key = accountFilterKey(item.pluggy)
      if (!labels.has(key)) {
        labels.set(
          key,
          organizzeDestinationLabel(
            item.pluggy,
            creditCards,
            organizzeAccounts,
          ),
        )
      }
    }
    return [...labels.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'))
  }, [queue, creditCards, organizzeAccounts])

  const filteredItems = useMemo(() => {
    if (!queue) {
      return []
    }
    const query = filterQuery.trim().toLowerCase()
    return queue.items.filter((item) => {
      if (
        filterAccountKey &&
        accountFilterKey(item.pluggy) !== filterAccountKey
      ) {
        return false
      }
      if (filterKind && item.pluggy.kind !== filterKind) {
        return false
      }
      if (query) {
        const haystack = [
          item.pluggy.description,
          item.pluggy.category ?? '',
          formatPluggyAccountLabel(item.pluggy),
        ]
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(query)) {
          return false
        }
      }
      return true
    })
  }, [queue, filterAccountKey, filterKind, filterQuery])

  const filtersActive =
    Boolean(filterAccountKey) || Boolean(filterKind) || Boolean(filterQuery.trim())
  const anyBusy = action !== null
  const toolbarBusy = loading || anyBusy
  const modalBusy =
    action?.kind === 'import' ||
    action?.kind === 'invoice' ||
    action?.kind === 'transfer' ||
    (Boolean(searchItem) && action?.kind === 'link')

  const createSelectedInvoice = useMemo(() => {
    if (!createItem || createItem.pluggy.kind !== 'credit_purchase' || !invoiceId) {
      return null
    }
    const invoices =
      invoicesByCard[createItem.pluggy.mappedOrganizzeTargetId] ?? []
    return invoices.find((invoice) => String(invoice.id) === invoiceId) ?? null
  }, [createItem, invoiceId, invoicesByCard])

  const createOrganizzeDestination = useMemo(() => {
    if (!createItem) {
      return null
    }
    return organizzeDestinationLabel(
      createItem.pluggy,
      creditCards,
      organizzeAccounts,
    )
  }, [createItem, creditCards, organizzeAccounts])

  const transferAccountOptions = useMemo(() => {
    if (!createItem || !isSamePersonTransfer(createItem.pluggy)) {
      return []
    }
    const sourceId = createItem.pluggy.mappedOrganizzeTargetId
    return organizzeAccounts.filter(
      (account) => !account.archived && account.id !== sourceId,
    )
  }, [createItem, organizzeAccounts])

  const createIsTransfer = Boolean(
    createItem && isSamePersonTransfer(createItem.pluggy),
  )

  const loadQueue = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) {
        onError(null)
        setLoading(true)
        setStatusMessage('Carregando fila de conciliação…')
      }
      try {
        const [queueData, cats, cards, accounts, ignored] = await Promise.all([
          apiFetch<ReconciliationQueueResponse>(
            `/api/reconciliation/queue?from=${range.from}&to=${range.to}`,
          ),
          apiFetch<OrganizzeCategory[]>('/api/organizze/categories'),
          apiFetch<OrganizzeCreditCard[]>('/api/organizze/credit-cards'),
          apiFetch<OrganizzeAccount[]>('/api/organizze/accounts'),
          apiFetch<{ items: IgnoredItem[] }>('/api/reconciliation/ignored'),
        ])
        setQueue(queueData)
        setCategories(cats)
        setCreditCards(cards)
        setOrganizzeAccounts(accounts)
        setIgnoredItems(ignored.items)
        if (!options?.silent) {
          setStatusMessage(
            queueData.items.length === 0
              ? 'Nada pendente neste mês.'
              : `${queueData.items.length} item(ns) na fila.`,
          )
        }
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Erro ao carregar fila')
        if (!options?.silent) {
          setStatusMessage(null)
        }
        throw err
      } finally {
        if (!options?.silent) {
          setLoading(false)
        }
      }
    },
    [apiFetch, onError, range.from, range.to],
  )

  useEffect(() => {
    void loadQueue()
  }, [loadQueue])

  const syncReconcileUrl = useCallback(
    (
      patch: {
        month?: string
        account?: string | null
        kind?: ReconciliationKindFilter
        q?: string | null
      },
      mode: 'push' | 'replace',
    ) => {
      if (!isActive) {
        return
      }
      const nextMonth = patch.month ?? yearMonth
      const nextAccount =
        patch.account !== undefined ? patch.account : filterAccountKey || null
      const nextKind = patch.kind !== undefined ? patch.kind : filterKind
      const nextQuery =
        patch.q !== undefined ? patch.q : filterQuery.trim() || null
      setSearchParams(
        (current) =>
          patchSearchParams(current, {
            month: nextMonth,
            account: nextAccount,
            kind: nextKind || null,
            q: nextQuery,
            section: null,
            tab: null,
          }),
        { replace: mode === 'replace' },
      )
    },
    [
      isActive,
      yearMonth,
      filterAccountKey,
      filterKind,
      filterQuery,
      setSearchParams,
    ],
  )

  useEffect(() => {
    if (isActive && !wasActiveRef.current) {
      syncReconcileUrl({}, 'replace')
    }
    wasActiveRef.current = isActive
  }, [isActive, syncReconcileUrl])

  useEffect(() => {
    if (!isActive) {
      return
    }
    const month = readMonthParam(searchParams)
    if (month && month !== yearMonth) {
      setYearMonth(month)
    }
    setFilterAccountKey(readAccountParam(searchParams) ?? '')
    setFilterKind(readKindParam(searchParams))
    const q = readQueryParam(searchParams) ?? ''
    setFilterQuery(q)
    setSearchOpen(Boolean(q))
  }, [searchParams, isActive])

  const changeYearMonth = useCallback(
    (next: string) => {
      setYearMonth(next)
      setFilterAccountKey('')
      setFilterKind('')
      setFilterQuery('')
      setSearchOpen(false)
      syncReconcileUrl(
        { month: next, account: null, kind: '', q: null },
        'push',
      )
    },
    [syncReconcileUrl],
  )

  useEffect(() => {
    if (!isActive) {
      return
    }
    const handle = window.setTimeout(() => {
      syncReconcileUrl({ q: filterQuery.trim() || null }, 'replace')
    }, 250)
    return () => window.clearTimeout(handle)
  }, [filterQuery, syncReconcileUrl, isActive])

  const loadIgnored = useCallback(async () => {
    setIgnoredLoading(true)
    try {
      const data = await apiFetch<{ items: IgnoredItem[] }>(
        '/api/reconciliation/ignored',
      )
      setIgnoredItems(data.items)
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Erro ao carregar ignorados')
    } finally {
      setIgnoredLoading(false)
    }
  }, [apiFetch, onError])

  const openIgnored = useCallback(() => {
    setIgnoredOpen(true)
    void loadIgnored()
  }, [loadIgnored])

  const restoreIgnored = useCallback(
    async (pluggyTransactionId: string) => {
      setRestoringId(pluggyTransactionId)
      onError(null)
      try {
        await apiFetch(`/api/reconciliation/ignored/${pluggyTransactionId}`, {
          method: 'DELETE',
        })
        setIgnoredItems((current) =>
          current.filter(
            (item) => item.pluggyTransactionId !== pluggyTransactionId,
          ),
        )
        setStatusMessage('Ignorar desfeito — item voltou para a fila.')
        await loadQueue({ silent: true })
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Erro ao restaurar')
      } finally {
        setRestoringId(null)
      }
    },
    [apiFetch, onError, loadQueue],
  )

  const loadInvoices = useCallback(
    async (creditCardId: number): Promise<OrganizzeInvoice[]> => {
      const cached = invoicesByCard[creditCardId]
      if (cached) {
        return cached
      }
      try {
        const invoices = sortInvoicesDesc(
          await apiFetch<OrganizzeInvoice[]>(
            `/api/organizze/credit-cards/${creditCardId}/invoices`,
          ),
        )
        setInvoicesByCard((prev) => ({ ...prev, [creditCardId]: invoices }))
        return invoices
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Erro ao carregar faturas')
        return []
      }
    },
    [apiFetch, invoicesByCard, onError],
  )

  const linkAmountForItem = useCallback(
    (item: ReconciliationQueueItem) =>
      linkAmountInputs[item.pluggy.id] ??
      formatSignedAmountInput(item.pluggy.organizzeAmountCents),
    [linkAmountInputs],
  )

  const setLinkAmountForItem = (pluggyId: string, value: string) => {
    setLinkAmountInputs((prev) => ({ ...prev, [pluggyId]: value }))
  }

  const openCreateModal = (item: ReconciliationQueueItem) => {
    setCreateItem(item)
    setImportDescription(
      isSamePersonTransfer(item.pluggy)
        ? item.pluggy.description || 'Transferência entre contas'
        : item.pluggy.description,
    )
    setImportAmount(
      isSamePersonTransfer(item.pluggy)
        ? formatUnsignedAmountInput(item.pluggy.organizzeAmountCents)
        : formatSignedAmountInput(item.pluggy.organizzeAmountCents),
    )
    setImportCategoryId('')
    setInvoiceCardId('')
    setInvoiceId('')
    setTransferOtherAccountId(
      item.pluggy.transferCounterpart
        ? String(item.pluggy.transferCounterpart.mappedOrganizzeTargetId)
        : '',
    )
    onError(null)
    if (item.pluggy.kind === 'credit_purchase') {
      const cardId = item.pluggy.mappedOrganizzeTargetId
      const pluggyId = item.pluggy.id
      const referenceDate = item.pluggy.date
      void loadInvoices(cardId).then((invoices) => {
        setCreateItem((current) => {
          if (!current || current.pluggy.id !== pluggyId) {
            return current
          }
          const picked = pickCurrentInvoice(invoices, referenceDate)
          if (picked) {
            setInvoiceId(String(picked.id))
          }
          return current
        })
      })
    }
  }

  const closeCreateModal = () => {
    if (modalBusy) {
      return
    }
    setCreateItem(null)
  }

  const openSearchModal = (item: ReconciliationQueueItem) => {
    setSearchItem(item)
    setSearchQuery(item.pluggy.description.slice(0, 40))
    setSearchLinkAmount(
      formatSignedAmountInput(item.pluggy.organizzeAmountCents),
    )
    setSearchOnlyMapped(true)
    setSearchRows([])
    onError(null)
    const from = shiftIsoDate(item.pluggy.date.slice(0, 10), -45)
    const to = shiftIsoDate(item.pluggy.date.slice(0, 10), 45)
    setSearchLoading(true)
    void apiFetch<OrganizzeTransactionRow[]>(
      `/api/organizze/transactions?startDate=${encodeURIComponent(from)}&endDate=${encodeURIComponent(to)}`,
    )
      .then((rows) => {
        setSearchRows(rows)
      })
      .catch((err) => {
        onError(
          err instanceof Error
            ? err.message
            : 'Erro ao carregar lançamentos do Organizze',
        )
      })
      .finally(() => {
        setSearchLoading(false)
      })
  }

  const closeSearchModal = () => {
    if (modalBusy) {
      return
    }
    setSearchItem(null)
    setSearchRows([])
    setSearchQuery('')
  }

  const searchCandidates = useMemo(() => {
    if (!searchItem) {
      return [] as MatchCandidate[]
    }
    const q = searchQuery.trim().toLowerCase()
    const mappedId = searchItem.pluggy.mappedOrganizzeTargetId
    const isCard = searchItem.pluggy.mappedTargetType === 'credit_card'
    const filtered = searchRows.filter((tx) => {
      if (notesAlreadyLinked(tx.notes)) {
        return false
      }
      if (searchOnlyMapped) {
        if (isCard) {
          if (tx.credit_card_id !== mappedId) {
            return false
          }
        } else if (tx.account_id !== mappedId) {
          return false
        }
      }
      if (!q) {
        return true
      }
      const amountText = (tx.amount_cents / 100).toFixed(2).replace('.', ',')
      const haystack =
        `${tx.description} ${tx.date} ${tx.id} ${amountText} ${Math.abs(tx.amount_cents)}`.toLowerCase()
      return haystack.includes(q) || q.split(/\s+/).every((part) => haystack.includes(part))
    })

    return filtered
      .map((tx) =>
        toSearchCandidate(
          tx,
          searchItem.pluggy,
          organizzeAccounts,
          creditCards,
          categories,
        ),
      )
      .sort((a, b) => {
        const amountCmp = a.amountDiffCents - b.amountDiffCents
        if (amountCmp !== 0) {
          return amountCmp
        }
        return a.daysDiff - b.daysDiff
      })
      .slice(0, 40)
  }, [
    searchItem,
    searchQuery,
    searchRows,
    searchOnlyMapped,
    organizzeAccounts,
    creditCards,
    categories,
  ])

  const removeFromQueue = (...pluggyIds: string[]) => {
    const idSet = new Set(pluggyIds)
    setQueue((current) =>
      current
        ? {
            ...current,
            items: current.items.filter(
              (entry) => !idSet.has(entry.pluggy.id),
            ),
          }
        : current,
    )
  }

  const finishAction = async (
    pluggyIds: string | string[],
    successMessage: string,
  ) => {
    const ids = Array.isArray(pluggyIds) ? pluggyIds : [pluggyIds]
    removeFromQueue(...ids)
    setCreateItem(null)
    setSearchItem(null)
    setAction(null)
    setStatusMessage(successMessage)
  }

  const link = async (
    item: ReconciliationQueueItem,
    candidate: MatchCandidate,
    options?: { amountCents?: number },
  ) => {
    const parcel =
      candidate.totalInstallments &&
      candidate.totalInstallments > 1 &&
      candidate.installment
        ? ` (parcela ${candidate.installment}/${candidate.totalInstallments})`
        : ''
    setAction({
      pluggyId: item.pluggy.id,
      kind: 'link',
      candidateId: candidate.organizzeTransactionId,
      phase: 'working',
      message: `Vinculando a “${candidate.description}”${parcel} no Organizze…`,
    })
    onError(null)
    const started = performance.now()
    try {
      await apiFetch(`/api/reconciliation/${item.pluggy.id}/link`, {
        method: 'POST',
        body: JSON.stringify({
          from: range.from,
          to: range.to,
          organizzeTransactionId: candidate.organizzeTransactionId,
          syncDate: true,
          ...(options?.amountCents !== undefined
            ? { amountCents: options.amountCents }
            : {}),
        }),
      })
      console.info(
        `[perf] link ${item.pluggy.id} client ${Math.round(performance.now() - started)}ms`,
      )
      await finishAction(
        item.pluggy.id,
        `Vinculado a “${candidate.description}”.`,
      )
    } catch (err) {
      console.warn(
        `[perf] link ${item.pluggy.id} failed after ${Math.round(performance.now() - started)}ms`,
      )
      onError(err instanceof Error ? err.message : 'Erro ao vincular')
      setAction(null)
    }
  }

  const importTx = async (item: ReconciliationQueueItem) => {
    const amountCents = parseSignedBRLInputToCents(importAmount)
    if (amountCents === null || amountCents === 0) {
      onError('Informe um valor válido para o Organizze')
      return
    }
    if (item.pluggy.kind === 'credit_purchase' && !invoiceId) {
      onError('Selecione a fatura do cartão')
      return
    }
    setAction({
      pluggyId: item.pluggy.id,
      kind: 'import',
      candidateId: null,
      phase: 'working',
      message: 'Criando lançamento no Organizze…',
    })
    onError(null)
    const started = performance.now()
    try {
      const body: Record<string, string | number | boolean> = {
        from: range.from,
        to: range.to,
        description: importDescription.trim() || item.pluggy.description,
        paid: true,
        amountCents,
      }
      if (importCategoryId) {
        body.categoryId = Number(importCategoryId)
      }

      if (item.pluggy.kind === 'credit_purchase') {
        body.creditCardId = item.pluggy.mappedOrganizzeTargetId
        body.creditCardInvoiceId = Number(invoiceId)
      }

      await apiFetch(`/api/reconciliation/${item.pluggy.id}/import`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      console.info(
        `[perf] import ${item.pluggy.id} client ${Math.round(performance.now() - started)}ms`,
      )
      await finishAction(item.pluggy.id, 'Lançamento criado no Organizze.')
    } catch (err) {
      console.warn(
        `[perf] import ${item.pluggy.id} failed after ${Math.round(performance.now() - started)}ms`,
      )
      onError(err instanceof Error ? err.message : 'Erro ao criar lançamento')
      setAction(null)
    }
  }

  const payInvoice = async (item: ReconciliationQueueItem) => {
    if (!invoiceCardId || !invoiceId) {
      onError('Selecione cartão e fatura')
      return
    }
    setAction({
      pluggyId: item.pluggy.id,
      kind: 'invoice',
      candidateId: null,
      phase: 'working',
      message: 'Registrando pagamento de fatura no Organizze…',
    })
    onError(null)
    try {
      await apiFetch(`/api/reconciliation/${item.pluggy.id}/invoice-payment`, {
        method: 'POST',
        body: JSON.stringify({
          from: range.from,
          to: range.to,
          creditCardId: Number(invoiceCardId),
          invoiceId: Number(invoiceId),
        }),
      })
      await finishAction(
        item.pluggy.id,
        'Pagamento de fatura registrado no Organizze.',
      )
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Erro no pagamento de fatura')
      setAction(null)
    }
  }

  const transferTx = async (item: ReconciliationQueueItem) => {
    const amountCents = parseUnsignedBRLInputToCents(importAmount)
    if (amountCents === null || amountCents <= 0) {
      onError('Informe um valor válido para a transferência')
      return
    }
    if (!transferOtherAccountId) {
      onError('Selecione a outra conta da transferência')
      return
    }
    const otherAccountId = Number(transferOtherAccountId)
    const counterpart = item.pluggy.transferCounterpart
    const useCounterpart =
      counterpart &&
      counterpart.mappedOrganizzeTargetId === otherAccountId
        ? counterpart.pluggyId
        : undefined
    const otherName =
      organizzeAccounts.find((account) => account.id === otherAccountId)
        ?.name ?? 'conta destino'
    const sourceName =
      createOrganizzeDestination ?? formatPluggyAccountLabel(item.pluggy)
    const fromLabel =
      item.pluggy.organizzeAmountCents < 0 ? sourceName : otherName
    const toLabel =
      item.pluggy.organizzeAmountCents < 0 ? otherName : sourceName

    setAction({
      pluggyId: item.pluggy.id,
      kind: 'transfer',
      candidateId: null,
      phase: 'working',
      message: useCounterpart
        ? `Registrando transferência e mesclando os 2 lados Open Finance…`
        : `Registrando transferência ${fromLabel} → ${toLabel}…`,
    })
    onError(null)
    const started = performance.now()
    try {
      const result = await apiFetch<{
        counterpartPluggyId: string | null
      }>(`/api/reconciliation/${item.pluggy.id}/transfer`, {
        method: 'POST',
        body: JSON.stringify({
          from: range.from,
          to: range.to,
          otherAccountId,
          description:
            importDescription.trim() ||
            item.pluggy.description ||
            'Transferência entre contas',
          amountCents,
          ...(useCounterpart
            ? { counterpartPluggyId: useCounterpart }
            : {}),
        }),
      })
      console.info(
        `[perf] transfer ${item.pluggy.id} client ${Math.round(performance.now() - started)}ms`,
      )
      const removedIds = [item.pluggy.id]
      if (result.counterpartPluggyId) {
        removedIds.push(result.counterpartPluggyId)
      }
      await finishAction(
        removedIds,
        useCounterpart
          ? `Transferência criada e os 2 registros Open Finance foram mesclados.`
          : `Transferência ${fromLabel} → ${toLabel} criada no Organizze.`,
      )
    } catch (err) {
      console.warn(
        `[perf] transfer ${item.pluggy.id} failed after ${Math.round(performance.now() - started)}ms`,
      )
      onError(
        err instanceof Error ? err.message : 'Erro ao criar transferência',
      )
      setAction(null)
    }
  }

  const ignore = async (item: ReconciliationQueueItem) => {
    if (!window.confirm('Ignorar esta transação? Ela sai da fila deste app.')) {
      return
    }
    setAction({
      pluggyId: item.pluggy.id,
      kind: 'ignore',
      candidateId: null,
      phase: 'working',
      message: 'Ignorando transação…',
    })
    onError(null)
    try {
      await apiFetch(`/api/reconciliation/${item.pluggy.id}/ignore`, {
        method: 'POST',
        body: JSON.stringify({ from: range.from, to: range.to }),
      })
      await finishAction(item.pluggy.id, 'Transação ignorada.')
      void loadIgnored()
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Erro ao ignorar')
      setAction(null)
    }
  }

  return (
    <section className="settings recon-view">
      <PullToRefresh
        onRefresh={() => loadQueue()}
        disabled={toolbarBusy}
      >
      <div className="hero-panel">
        <div>
          <h1>
            Fila de <em>conciliação</em>
          </h1>
          <p>
            Compare Open Finance com o Organizze. <strong>Vincular</strong>{' '}
            marca um lançamento existente como pago;{' '}
            <strong>Importar</strong> cria um novo.
          </p>
        </div>
        <div className="recon-toolbar">
          <label className="month-picker">
            Mês
            <input
              type="month"
              value={yearMonth}
              disabled={toolbarBusy}
              onChange={(event) => changeYearMonth(event.target.value)}
            />
          </label>
          <div className="recon-toolbar-actions">
            <button
              type="button"
              className="btn"
              disabled={toolbarBusy}
              title="Recarrega a fila com os dados já disponíveis"
              onClick={() => void loadQueue()}
            >
              {loading ? 'Atualizando…' : 'Atualizar fila'}
            </button>
            <a
              className="recon-sync-link"
              href="https://meu.pluggy.ai/connections/"
              target="_blank"
              rel="noreferrer"
              title="Abre o MeuPluggy para atualizar as conexões"
            >
              Abrir MeuPluggy
            </a>
          </div>
        </div>
      </div>

      {statusMessage || loading || action ? (
        <div
          className={`status-banner ${loading || action ? 'busy' : ''}`}
          role="status"
          aria-live="polite"
        >
          {loading || action ? <span className="spinner" aria-hidden /> : null}
          <span>{action?.message ?? statusMessage}</span>
        </div>
      ) : null}

      {ignoredInMonth.length > 0 ? (
        <div className="warning-banner ignored-warning">
          <span>
            {formatMonthTitle(yearMonth)} tem{' '}
            <strong>{ignoredInMonth.length}</strong> lançamento
            {ignoredInMonth.length === 1 ? '' : 's'} ignorado
            {ignoredInMonth.length === 1 ? '' : 's'}.
          </span>
          <button
            type="button"
            className="warning-link"
            disabled={toolbarBusy}
            onClick={openIgnored}
          >
            Ver e restaurar
          </button>
        </div>
      ) : null}

      {queue?.unmappedPluggyAccounts.length ? (
        <div className="warning-banner">
          {queue.unmappedPluggyAccounts.length} conta(s) Pluggy sem mapeamento.
          Configure em Configurações para entrar na fila.
        </div>
      ) : null}

      {loading && !queue ? (
        <article className="panel settings-panel">
          <div className="empty loading-empty">
            <span className="spinner lg" aria-hidden />
            <strong>Carregando conciliação</strong>
            <p>Isso pode levar alguns segundos (Pluggy + Organizze).</p>
          </div>
        </article>
      ) : !queue ? (
        <article className="panel settings-panel">
          <div className="empty">
            <strong>Nenhuma fila carregada</strong>
            <p>Escolha o mês e clique em Atualizar fila.</p>
          </div>
        </article>
      ) : queue.items.length === 0 ? (
        <article className="panel settings-panel">
          <div className="empty">
            <strong>Fila vazia</strong>
            <p>
              Nada pendente em {range.from} → {range.to}. Mapeie contas se ainda
              não mapeou.
            </p>
          </div>
        </article>
      ) : (
        <>
          <div className="recon-filters" aria-label="Filtros da fila">
            <div className="recon-filters-pill">
              <FilterDropdown
                label="Conta"
                value={filterAccountKey}
                options={accountFilterOptions}
                disabled={toolbarBusy}
                searchable
                searchPlaceholder="Buscar conta (ex.: XP)…"
                minWidth={280}
                onChange={(next) => {
                  setFilterAccountKey(next)
                  syncReconcileUrl({ account: next || null }, 'push')
                }}
              />
              <FilterDropdown
                label="Tipo"
                value={filterKind}
                options={[
                  { value: 'bank', label: 'Conta' },
                  { value: 'credit_purchase', label: 'Cartão' },
                  { value: 'invoice_payment_candidate', label: 'Fatura' },
                  { value: 'same_person_transfer', label: 'Transferência' },
                ]}
                disabled={toolbarBusy}
                minWidth={180}
                onChange={(next) => {
                  const kind = next as ReconciliationKindFilter
                  setFilterKind(kind)
                  syncReconcileUrl({ kind }, 'push')
                }}
              />
            </div>
            <button
              type="button"
              className={`recon-filter-search-btn${searchOpen || filterQuery ? ' is-active' : ''}`}
              aria-label="Buscar na fila"
              aria-pressed={searchOpen}
              disabled={toolbarBusy}
              onClick={() => setSearchOpen((open) => !open)}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <circle
                  cx="11"
                  cy="11"
                  r="6.5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                />
                <path
                  d="M16.2 16.2L20 20"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          {searchOpen ? (
            <div className="recon-filter-search">
              <input
                type="search"
                value={filterQuery}
                disabled={toolbarBusy}
                placeholder="Buscar descrição, categoria, conta…"
                autoFocus
                onChange={(event) => setFilterQuery(event.target.value)}
              />
              {filterQuery ? (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setFilterQuery('')}
                >
                  Limpar
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="recon-filter-meta">
            <span>
              {filtersActive
                ? `${filteredItems.length} de ${queue.items.length} lançamento${queue.items.length === 1 ? '' : 's'}`
                : `${queue.items.length} lançamento${queue.items.length === 1 ? '' : 's'} na fila`}
            </span>
            {filtersActive ? (
              <button
                type="button"
                className="warning-link"
                disabled={toolbarBusy}
                onClick={() => {
                  setFilterAccountKey('')
                  setFilterKind('')
                  setFilterQuery('')
                  setSearchOpen(false)
                  syncReconcileUrl(
                    { account: null, kind: '', q: null },
                    'push',
                  )
                }}
              >
                Limpar filtros
              </button>
            ) : null}
          </div>

          {filteredItems.length === 0 ? (
            <article className="panel settings-panel">
              <div className="empty">
                <strong>Nenhum lançamento com esses filtros</strong>
                <p>Ajuste Conta, Tipo ou a busca para ver a fila.</p>
              </div>
            </article>
          ) : (
        <ul className={`recon-list ${anyBusy && !createItem && !searchItem ? 'is-busy' : ''}`}>
          {filteredItems.map((item) => {
            const cardAction =
              action?.pluggyId === item.pluggy.id &&
              action.kind !== 'import' &&
              action.kind !== 'invoice' &&
              action.kind !== 'transfer'
                ? action
                : null
            const busy = cardAction !== null
            return (
              <li
                key={item.pluggy.id}
                className={`recon-card ${busy ? 'is-acting' : ''}`}
              >
                {cardAction ? (
                  <div className="recon-card-overlay" role="status">
                    <span className="spinner lg" aria-hidden />
                    <strong>
                      {cardAction.phase === 'working'
                        ? 'Processando…'
                        : 'Quase lá…'}
                    </strong>
                    <p>{cardAction.message}</p>
                  </div>
                ) : null}

                <div className="recon-card-main">
                  <div className="recon-card-meta">
                    <div className="recon-badges">
                      <span className={`badge ${kindClass(item.pluggy.kind)}`}>
                        {kindLabel(item.pluggy.kind)}
                      </span>
                      {isForeignCurrency(item.pluggy.currencyCode) ? (
                        <span className="badge kind-transfer">
                          {(item.pluggy.currencyCode ?? '').toUpperCase()}
                        </span>
                      ) : null}
                      {installmentLabel(item.pluggy) ? (
                        <span className="badge kind-installment">
                          {installmentLabel(item.pluggy)}
                        </span>
                      ) : null}
                    </div>
                    <strong>{item.pluggy.description}</strong>
                    <span>
                      {formatSmartDate(item.pluggy.date)} ·{' '}
                      {formatPluggyAccountLabel(item.pluggy)}
                      {item.pluggy.category ? ` · ${item.pluggy.category}` : ''}
                      {item.pluggy.purchaseDate
                        ? ` · compra ${formatSmartDate(item.pluggy.purchaseDate)}`
                        : ''}
                    </span>
                  </div>
                  <PluggyAmountDisplay pluggy={item.pluggy} />
                </div>

                {isSamePersonTransfer(item.pluggy) ? (
                  <div className="suggestions transfer-hint">
                    <div className="suggestions-head">
                      <strong>Transferência entre contas</strong>
                      <span>
                        {item.pluggy.transferCounterpart
                          ? `Encontramos o outro lado Open Finance (${formatTransferAccountHint(item.pluggy.transferCounterpart)}). Registrar como transferência mescla os 2 registros.`
                          : 'Mesmo sem o Pix de recebimento na outra conta, você pode registrar a transferência no Organizze e escolher a conta destino. Se o outro lado já foi criado no Organizze, use Vincular abaixo.'}
                      </span>
                    </div>
                  </div>
                ) : null}

                {item.suggestions.length > 0 ? (
                  <div className="suggestions">
                    <div className="suggestions-head">
                      <strong>Sugestões no Organizze</strong>
                      <span>
                        Vincular marca o lançamento como pago e grava o ID
                        Pluggy nas observações.
                      </span>
                    </div>
                    <label className="link-amount-field">
                      Valor no Organizze ao vincular
                      <input
                        value={linkAmountForItem(item)}
                        disabled={anyBusy}
                        inputMode="decimal"
                        onChange={(event) =>
                          setLinkAmountForItem(
                            item.pluggy.id,
                            event.target.value,
                          )
                        }
                      />
                    </label>
                    <ul>
                      {item.suggestions.map((candidate) => {
                        const linkingThis =
                          cardAction?.kind === 'link' &&
                          cardAction.candidateId ===
                            candidate.organizzeTransactionId
                        const destination = candidateDestination(candidate)
                        const metaParts = [
                          formatSmartDate(candidate.date),
                          formatBRL(candidate.amountCents),
                          destination,
                          candidate.categoryName,
                          candidate.totalInstallments &&
                          candidate.totalInstallments > 1 &&
                          candidate.installment
                            ? `parcela ${candidate.installment}/${candidate.totalInstallments}`
                            : null,
                          candidate.paid ? null : 'em aberto',
                          candidate.recurring ? 'fixo' : null,
                        ].filter((part): part is string => Boolean(part))
                        return (
                          <li key={candidate.organizzeTransactionId}>
                            <div>
                              <span>{candidate.description}</span>
                              <small>{metaParts.join(' · ')}</small>
                            </div>
                            <button
                              type="button"
                              className="btn"
                              disabled={anyBusy}
                              onClick={() => {
                                const amountCents = parseSignedBRLInputToCents(
                                  linkAmountForItem(item),
                                )
                                if (amountCents === null || amountCents === 0) {
                                  onError(
                                    'Informe um valor válido para o Organizze',
                                  )
                                  return
                                }
                                void link(item, candidate, { amountCents })
                              }}
                            >
                              {linkingThis ? (
                                <>
                                  <span className="spinner sm" aria-hidden />
                                  Vinculando…
                                </>
                              ) : (
                                'Vincular'
                              )}
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ) : !isSamePersonTransfer(item.pluggy) ? (
                  <p className="no-suggestions">
                    Sem sugestões próximas (valor/data fora da tolerância) —
                    use <strong>Buscar lançamento</strong>, Criar ou Ignorar.
                  </p>
                ) : null}

                <div className="recon-actions">
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={anyBusy}
                    onClick={() => openSearchModal(item)}
                  >
                    Buscar lançamento
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={anyBusy}
                    onClick={() => openCreateModal(item)}
                  >
                    {isSamePersonTransfer(item.pluggy)
                      ? 'Transferir entre contas'
                      : 'Criar lançamento'}
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={anyBusy}
                    onClick={() => void ignore(item)}
                  >
                    {cardAction?.kind === 'ignore' ? 'Ignorando…' : 'Ignorar'}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
          )}
        </>
      )}
      </PullToRefresh>

      {createItem ? (
        <BottomSheet
          onClose={closeCreateModal}
          busy={modalBusy}
          labelledBy="create-tx-title"
          title={
            createIsTransfer
              ? 'Transferência entre contas'
              : 'Criar lançamento'
          }
          subtitle={
            createIsTransfer
              ? 'Cria uma transferência no Organizze (saída + entrada) e grava o ID Pluggy nas observações.'
              : 'Confira destino, valor e data antes de enviar ao Organizze.'
          }
        >
          {modalBusy ? (
            <div className="modal-loading" role="status">
              <span className="spinner lg" aria-hidden />
              <strong>
                {action?.kind === 'invoice'
                  ? 'Registrando pagamento…'
                  : action?.kind === 'transfer'
                    ? 'Registrando transferência…'
                    : 'Criando lançamento…'}
              </strong>
              <p>{action?.message}</p>
            </div>
          ) : null}

            <div className="settings-form modal-body">
              <div className="create-destination" aria-label="Resumo do lançamento">
                <div className="create-destination-row">
                  <span>Valor</span>
                  <strong
                    className={
                      createItem.pluggy.organizzeAmountCents < 0 ? 'neg' : 'pos'
                    }
                  >
                    {isForeignCurrency(createItem.pluggy.currencyCode)
                      ? formatMoney(
                          createItem.pluggy.amountCents,
                          createItem.pluggy.currencyCode ?? 'USD',
                        )
                      : formatBRL(createItem.pluggy.organizzeAmountCents)}
                  </strong>
                </div>
                {isForeignCurrency(createItem.pluggy.currencyCode) &&
                createItem.pluggy.amountInAccountCurrencyCents != null ? (
                  <div className="create-destination-row">
                    <span>Em reais (fatura)</span>
                    <strong
                      className={
                        createItem.pluggy.organizzeAmountCents < 0
                          ? 'neg'
                          : 'pos'
                      }
                    >
                      {formatBRL(createItem.pluggy.organizzeAmountCents)}
                    </strong>
                  </div>
                ) : null}
                <div className="create-destination-row">
                  <span>Data</span>
                  <strong>{formatDateBR(createItem.pluggy.date)}</strong>
                </div>
                {createIsTransfer ? (
                  <>
                    <div className="create-destination-row">
                      <span>
                        {createItem.pluggy.organizzeAmountCents < 0
                          ? 'Conta de origem'
                          : 'Conta de destino'}
                      </span>
                      <strong>{createOrganizzeDestination ?? '—'}</strong>
                    </div>
                    <div className="create-destination-row">
                      <span>Origem Pluggy</span>
                      <strong>
                        {formatPluggyAccountLabel(createItem.pluggy)}
                      </strong>
                    </div>
                    {createItem.pluggy.transferCounterpart ? (
                      <div className="create-destination-row">
                        <span>Outro lado Open Finance</span>
                        <strong>
                          {formatTransferAccountHint(
                            createItem.pluggy.transferCounterpart,
                          )}
                        </strong>
                      </div>
                    ) : (
                      <div className="create-destination-row">
                        <span>Outro lado Open Finance</span>
                        <strong>Ainda não apareceu na fila</strong>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="create-destination-row">
                      <span>Destino no Organizze</span>
                      <strong>{createOrganizzeDestination ?? '—'}</strong>
                    </div>
                    <div className="create-destination-row">
                      <span>Origem Pluggy</span>
                      <strong>
                        {formatPluggyAccountLabel(createItem.pluggy)}
                      </strong>
                    </div>
                    {createItem.pluggy.kind === 'credit_purchase' ? (
                      <div className="create-destination-row">
                        <span>Fatura</span>
                        <strong>
                          {createSelectedInvoice
                            ? invoiceOptionLabel(createSelectedInvoice).title
                            : 'Selecionando…'}
                        </strong>
                      </div>
                    ) : null}
                  </>
                )}
              </div>

              <label>
                Descrição
                <input
                  value={importDescription}
                  disabled={modalBusy}
                  onChange={(event) => setImportDescription(event.target.value)}
                />
              </label>

              <label>
                {createIsTransfer
                  ? 'Valor da transferência (R$)'
                  : 'Valor no Organizze (R$)'}
                <input
                  value={importAmount}
                  disabled={modalBusy}
                  inputMode="decimal"
                  onChange={(event) => setImportAmount(event.target.value)}
                />
              </label>

              {createIsTransfer ? (
                <label>
                  {createItem.pluggy.organizzeAmountCents < 0
                    ? 'Conta de destino'
                    : 'Conta de origem'}
                  <select
                    value={transferOtherAccountId}
                    disabled={modalBusy}
                    onChange={(event) =>
                      setTransferOtherAccountId(event.target.value)
                    }
                  >
                    <option value="">Selecione a outra conta…</option>
                    {transferAccountOptions.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <>
                  <label>
                    Categoria
                    <CategoryPicker
                      categories={categories}
                      value={importCategoryId}
                      amountCents={
                        parseSignedBRLInputToCents(importAmount) ??
                        createItem.pluggy.organizzeAmountCents
                      }
                      disabled={modalBusy}
                      onChange={setImportCategoryId}
                    />
                  </label>

                  {createItem.pluggy.kind === 'credit_purchase' ? (
                    <label>
                      Fatura do cartão
                      <InvoicePicker
                        invoices={
                          invoicesByCard[
                            createItem.pluggy.mappedOrganizzeTargetId
                          ] ?? []
                        }
                        value={invoiceId}
                        disabled={modalBusy}
                        emptyLabel="Carregando fatura…"
                        onOpen={() =>
                          void loadInvoices(
                            createItem.pluggy.mappedOrganizzeTargetId,
                          )
                        }
                        onChange={setInvoiceId}
                      />
                    </label>
                  ) : null}

                  {canOfferInvoicePayment(createItem.pluggy) ? (
                    <>
                      <label>
                        Cartão (pagamento de fatura)
                        <CreditCardPicker
                          cards={creditCards}
                          value={invoiceCardId}
                          disabled={modalBusy}
                          onChange={(next) => {
                            setInvoiceCardId(next)
                            setInvoiceId('')
                            if (next) {
                              void loadInvoices(Number(next))
                            }
                          }}
                        />
                      </label>
                      {invoiceCardId ? (
                        <label>
                          Fatura
                          <InvoicePicker
                            invoices={
                              invoicesByCard[Number(invoiceCardId)] ?? []
                            }
                            value={invoiceId}
                            disabled={modalBusy}
                            emptyLabel="Escolher fatura…"
                            onOpen={() =>
                              void loadInvoices(Number(invoiceCardId))
                            }
                            onChange={setInvoiceId}
                          />
                        </label>
                      ) : null}
                    </>
                  ) : null}
                </>
              )}

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn ghost"
                  disabled={modalBusy}
                  onClick={closeCreateModal}
                >
                  Cancelar
                </button>
                {createIsTransfer ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={modalBusy || !transferOtherAccountId}
                    onClick={() => void transferTx(createItem)}
                  >
                    Registrar transferência
                  </button>
                ) : (
                  <>
                    {canOfferInvoicePayment(createItem.pluggy) &&
                    invoiceCardId &&
                    invoiceId ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={modalBusy}
                        onClick={() => void payInvoice(createItem)}
                      >
                        Registrar pagamento de fatura
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn"
                      disabled={modalBusy}
                      onClick={() => void importTx(createItem)}
                    >
                      Criar no Organizze
                    </button>
                  </>
                )}
              </div>
            </div>
        </BottomSheet>
      ) : null}

      {searchItem ? (
        <BottomSheet
          onClose={closeSearchModal}
          busy={modalBusy || searchLoading}
          labelledBy="search-link-title"
          title="Buscar lançamento"
          subtitle="Procure qualquer lançamento no Organizze (mesmo com valor bem diferente) e vincule a este item do Open Finance."
        >
          {modalBusy ? (
            <div className="modal-loading" role="status">
              <span className="spinner lg" aria-hidden />
              <strong>Vinculando…</strong>
              <p>{action?.message ?? 'Atualizando Organizze.'}</p>
            </div>
          ) : null}

          <div className="settings-form modal-body">
            <div className="create-destination">
              <div className="create-destination-row">
                <span>Open Finance</span>
                <strong>{searchItem.pluggy.description}</strong>
              </div>
              <div className="create-destination-row">
                <span>Valor / data</span>
                <strong>
                  {formatBRL(searchItem.pluggy.organizzeAmountCents)} ·{' '}
                  {formatSmartDate(searchItem.pluggy.date)}
                </strong>
              </div>
            </div>

            <label>
              Buscar
              <input
                value={searchQuery}
                disabled={modalBusy || searchLoading}
                placeholder="Descrição, valor ou data…"
                autoFocus
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </label>

            <label className="balance-source-toggle">
              <input
                type="checkbox"
                checked={searchOnlyMapped}
                disabled={modalBusy || searchLoading}
                onChange={(event) => setSearchOnlyMapped(event.target.checked)}
              />
              <span>
                Só no destino mapeado (
                {searchItem.pluggy.mappedTargetType === 'credit_card'
                  ? 'cartão'
                  : 'conta'}{' '}
                #{searchItem.pluggy.mappedOrganizzeTargetId})
              </span>
            </label>

            <label>
              Valor no Organizze ao vincular (R$)
              <input
                value={searchLinkAmount}
                disabled={modalBusy || searchLoading}
                inputMode="decimal"
                onChange={(event) => setSearchLinkAmount(event.target.value)}
              />
            </label>

            {searchLoading ? (
              <div className="empty loading-empty">
                <span className="spinner lg" aria-hidden />
                <strong>Carregando lançamentos…</strong>
              </div>
            ) : searchCandidates.length === 0 ? (
              <div className="empty">
                <strong>Nenhum lançamento encontrado</strong>
                <p>
                  Ajuste o texto da busca ou desmarque o filtro do destino
                  mapeado.
                </p>
              </div>
            ) : (
              <div className="suggestions search-link-results">
                <div className="suggestions-head">
                  <strong>
                    {searchCandidates.length} resultado
                    {searchCandidates.length === 1 ? '' : 's'}
                  </strong>
                  <span>±45 dias em torno de {formatSmartDate(searchItem.pluggy.date)}</span>
                </div>
                <ul>
                  {searchCandidates.map((candidate) => {
                    const linkingThis =
                      action?.kind === 'link' &&
                      action.candidateId === candidate.organizzeTransactionId
                    const destination = candidateDestination(candidate)
                    const metaParts = [
                      formatSmartDate(candidate.date),
                      formatBRL(candidate.amountCents),
                      destination,
                      candidate.categoryName,
                      candidate.amountDiffCents > 0
                        ? `Δ ${formatBRL(candidate.amountDiffCents)}`
                        : 'mesmo valor',
                      candidate.paid ? null : 'em aberto',
                    ].filter((part): part is string => Boolean(part))
                    return (
                      <li key={candidate.organizzeTransactionId}>
                        <div>
                          <span>{candidate.description}</span>
                          <small>{metaParts.join(' · ')}</small>
                        </div>
                        <button
                          type="button"
                          className="btn"
                          disabled={modalBusy}
                          onClick={() => {
                            const amountCents = parseSignedBRLInputToCents(
                              searchLinkAmount,
                            )
                            if (amountCents === null || amountCents === 0) {
                              onError(
                                'Informe um valor válido para o Organizze',
                              )
                              return
                            }
                            void link(searchItem, candidate, { amountCents })
                          }}
                        >
                          {linkingThis ? (
                            <>
                              <span className="spinner sm" aria-hidden />
                              Vinculando…
                            </>
                          ) : (
                            'Vincular'
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}

            <div className="modal-actions">
              <button
                type="button"
                className="btn ghost"
                disabled={modalBusy}
                onClick={closeSearchModal}
              >
                Fechar
              </button>
            </div>
          </div>
        </BottomSheet>
      ) : null}

      {ignoredOpen ? (
        <BottomSheet
          onClose={() => {
            if (!restoringId) {
              setIgnoredOpen(false)
            }
          }}
          busy={Boolean(restoringId)}
          labelledBy="ignored-title"
          className="ignored-modal"
          title="Ignorados"
          subtitle={`Lançamentos ignorados em ${formatMonthTitle(yearMonth)}. Restaurar coloca de volta na fila.`}
        >
            <div className="modal-body ignored-body">
              {ignoredLoading ? (
                <div className="empty loading-empty">
                  <span className="spinner lg" aria-hidden />
                  <strong>Carregando ignorados…</strong>
                </div>
              ) : ignoredInMonth.length === 0 ? (
                <div className="empty">
                  <strong>Nenhum ignorado</strong>
                  <p>Quando você ignorar um item, ele aparece aqui.</p>
                </div>
              ) : (
                <ul className="ignored-list">
                  {ignoredInMonth.map((item) => {
                    const snap = item.snapshot
                    const busy = restoringId === item.pluggyTransactionId
                    return (
                      <li key={item.id} className="ignored-row">
                        <div className="ignored-meta">
                          <div className="recon-badges">
                            <span className="badge kind-bank">Ignorado</span>
                            {snap ? (
                              <span
                                className={`badge ${kindClass(snap.kind)}`}
                              >
                                {kindLabel(snap.kind)}
                              </span>
                            ) : null}
                            {snap &&
                            snap.totalInstallments &&
                            snap.totalInstallments > 1 &&
                            snap.installmentNumber ? (
                              <span className="badge kind-installment">
                                Parcela {snap.installmentNumber}/
                                {snap.totalInstallments}
                              </span>
                            ) : null}
                          </div>
                          <strong>
                            {snap?.description ?? item.pluggyTransactionId}
                          </strong>
                          <span>
                            {snap
                              ? `${formatDateBR(snap.date)} · ${snap.accountName}`
                              : 'Sem detalhes salvos (ignorado antes do snapshot)'}
                          </span>
                        </div>
                        <div className="ignored-side">
                          {snap ? (
                            <strong
                              className={`recon-amount ${
                                snap.organizzeAmountCents < 0 ? 'neg' : 'pos'
                              }`}
                            >
                              {formatBRL(snap.organizzeAmountCents)}
                            </strong>
                          ) : null}
                          <button
                            type="button"
                            className="btn"
                            disabled={Boolean(restoringId)}
                            onClick={() =>
                              void restoreIgnored(item.pluggyTransactionId)
                            }
                          >
                            {busy ? (
                              <>
                                <span className="spinner sm" aria-hidden />
                                Restaurando…
                              </>
                            ) : (
                              'Restaurar'
                            )}
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
        </BottomSheet>
      ) : null}
    </section>
  )
}
