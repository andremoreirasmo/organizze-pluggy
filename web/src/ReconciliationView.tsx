import { useCallback, useEffect, useMemo, useState } from 'react'
import { CategoryPicker, type CategoryOption } from './CategoryPicker'
import { CreditCardPicker } from './CreditCardPicker'
import {
  InvoicePicker,
  formatInvoiceDate,
  invoiceOptionLabel,
} from './InvoicePicker'

export type ReconciliationKind =
  | 'bank'
  | 'credit_purchase'
  | 'invoice_payment_candidate'

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

export type OrganizzeInvoice = {
  id: number
  date: string
  starting_date: string
  closing_date: string
  amount_cents: number
  balance_cents: number
  credit_card_id: number
}

type ApiFetch = <T>(path: string, init?: RequestInit) => Promise<T>

type ActionKind = 'link' | 'import' | 'invoice' | 'ignore'

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

function formatDateBR(isoDate: string): string {
  return formatInvoiceDate(isoDate)
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
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
  return 'kind-bank'
}

type Props = {
  apiFetch: ApiFetch
  onError: (message: string | null) => void
}

export function ReconciliationView({ apiFetch, onError }: Props) {
  const [yearMonth, setYearMonth] = useState(currentYearMonth)
  const [queue, setQueue] = useState<ReconciliationQueueResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [action, setAction] = useState<ActionState | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [categories, setCategories] = useState<OrganizzeCategory[]>([])
  const [creditCards, setCreditCards] = useState<OrganizzeCreditCard[]>([])
  const [invoicesByCard, setInvoicesByCard] = useState<
    Record<number, OrganizzeInvoice[]>
  >({})
  const [createItem, setCreateItem] = useState<ReconciliationQueueItem | null>(
    null,
  )
  const [ignoredOpen, setIgnoredOpen] = useState(false)
  const [ignoredItems, setIgnoredItems] = useState<IgnoredItem[]>([])
  const [ignoredLoading, setIgnoredLoading] = useState(false)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [importDescription, setImportDescription] = useState('')
  const [importCategoryId, setImportCategoryId] = useState('')
  const [invoiceCardId, setInvoiceCardId] = useState('')
  const [invoiceId, setInvoiceId] = useState('')

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
  const anyBusy = action !== null
  const modalBusy =
    action?.kind === 'import' || action?.kind === 'invoice'

  const createSelectedInvoice = useMemo(() => {
    if (!createItem || createItem.pluggy.kind !== 'credit_purchase' || !invoiceId) {
      return null
    }
    const invoices =
      invoicesByCard[createItem.pluggy.mappedOrganizzeTargetId] ?? []
    return invoices.find((invoice) => String(invoice.id) === invoiceId) ?? null
  }, [createItem, invoiceId, invoicesByCard])

  const loadQueue = useCallback(
    async (options?: { silent?: boolean }) => {
      onError(null)
      if (!options?.silent) {
        setLoading(true)
        setStatusMessage('Buscando transações Pluggy e Organizze…')
      }
      try {
        const [queueData, cats, cards, ignored] = await Promise.all([
          apiFetch<ReconciliationQueueResponse>(
            `/api/reconciliation/queue?from=${range.from}&to=${range.to}`,
          ),
          apiFetch<OrganizzeCategory[]>('/api/organizze/categories'),
          apiFetch<OrganizzeCreditCard[]>('/api/organizze/credit-cards'),
          apiFetch<{ items: IgnoredItem[] }>('/api/reconciliation/ignored'),
        ])
        setQueue(queueData)
        setCategories(cats)
        setCreditCards(cards)
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
        setStatusMessage(null)
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

  const openCreateModal = (item: ReconciliationQueueItem) => {
    setCreateItem(item)
    setImportDescription(item.pluggy.description)
    setImportCategoryId('')
    setInvoiceCardId('')
    setInvoiceId('')
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

  const removeFromQueue = (pluggyId: string) => {
    setQueue((current) =>
      current
        ? {
            ...current,
            items: current.items.filter((entry) => entry.pluggy.id !== pluggyId),
          }
        : current,
    )
  }

  const finishAction = async (
    pluggyId: string,
    successMessage: string,
  ) => {
    removeFromQueue(pluggyId)
    setCreateItem(null)
    setAction(null)
    setStatusMessage(successMessage)
  }

  const link = async (
    item: ReconciliationQueueItem,
    candidate: MatchCandidate,
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
    try {
      await apiFetch(`/api/reconciliation/${item.pluggy.id}/link`, {
        method: 'POST',
        body: JSON.stringify({
          from: range.from,
          to: range.to,
          organizzeTransactionId: candidate.organizzeTransactionId,
          syncDate: true,
          syncAmount: false,
        }),
      })
      await finishAction(
        item.pluggy.id,
        `Vinculado a “${candidate.description}”.`,
      )
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Erro ao vincular')
      setAction(null)
    }
  }

  const importTx = async (item: ReconciliationQueueItem) => {
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
    try {
      const body: Record<string, string | number | boolean> = {
        from: range.from,
        to: range.to,
        description: importDescription.trim() || item.pluggy.description,
        paid: true,
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
      await finishAction(item.pluggy.id, 'Lançamento criado no Organizze.')
    } catch (err) {
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
              disabled={loading || anyBusy}
              onChange={(event) => setYearMonth(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn"
            disabled={loading || anyBusy}
            onClick={() => void loadQueue()}
          >
            {loading ? 'Atualizando…' : 'Atualizar fila'}
          </button>
        </div>
      </div>

      {statusMessage || loading || action ? (
        <div
          className={`status-banner ${loading || action ? 'busy' : ''}`}
          role="status"
          aria-live="polite"
        >
          {loading || action ? <span className="spinner" aria-hidden /> : null}
          <span>
            {action?.message ??
              (loading ? 'Carregando fila de conciliação…' : statusMessage)}
          </span>
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
            disabled={loading || anyBusy}
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
        <ul className={`recon-list ${anyBusy && !createItem ? 'is-busy' : ''}`}>
          {queue.items.map((item) => {
            const cardAction =
              action?.pluggyId === item.pluggy.id &&
              action.kind !== 'import' &&
              action.kind !== 'invoice'
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
                  <div
                    className={`recon-amount ${
                      item.pluggy.organizzeAmountCents < 0 ? 'neg' : 'pos'
                    }`}
                  >
                    {formatBRL(item.pluggy.organizzeAmountCents)}
                  </div>
                </div>

                {item.suggestions.length > 0 ? (
                  <div className="suggestions">
                    <div className="suggestions-head">
                      <strong>Sugestões no Organizze</strong>
                      <span>
                        Vincular marca o lançamento como pago e grava o ID
                        Pluggy nas observações.
                      </span>
                    </div>
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
                              onClick={() => void link(item, candidate)}
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
                ) : (
                  <p className="no-suggestions">
                    Sem sugestões próximas — use Criar lançamento ou Ignorar.
                  </p>
                )}

                <div className="recon-actions">
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={anyBusy}
                    onClick={() => openCreateModal(item)}
                  >
                    Criar lançamento
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

      {createItem ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={closeCreateModal}
        >
          <div
            className="modal-card create-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-tx-title"
            onClick={(event) => event.stopPropagation()}
          >
            {modalBusy ? (
              <div className="modal-loading" role="status">
                <span className="spinner lg" aria-hidden />
                <strong>
                  {action?.kind === 'invoice'
                    ? 'Registrando pagamento…'
                    : 'Criando lançamento…'}
                </strong>
                <p>{action?.message}</p>
              </div>
            ) : null}

            <div className="modal-head">
              <div>
                <h2 id="create-tx-title">Criar lançamento</h2>
                <p>Confira destino, valor e data antes de enviar ao Organizze.</p>
              </div>
              <button
                type="button"
                className="modal-close"
                disabled={modalBusy}
                onClick={closeCreateModal}
                aria-label="Fechar"
                title="Fechar"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  aria-hidden="true"
                >
                  <path
                    d="M3 3l8 8M11 3L3 11"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>

            <div className="settings-form modal-body">
              <div className="create-destination" aria-label="Resumo do lançamento">
                <div className="create-destination-row">
                  <span>Valor</span>
                  <strong
                    className={
                      createItem.pluggy.organizzeAmountCents < 0 ? 'neg' : 'pos'
                    }
                  >
                    {formatBRL(createItem.pluggy.organizzeAmountCents)}
                  </strong>
                </div>
                <div className="create-destination-row">
                  <span>Data</span>
                  <strong>{formatDateBR(createItem.pluggy.date)}</strong>
                </div>
                <div className="create-destination-row">
                  <span>Destino no Organizze</span>
                  <strong>{formatPluggyAccountLabel(createItem.pluggy)}</strong>
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
                Categoria
                <CategoryPicker
                  categories={categories}
                  value={importCategoryId}
                  amountCents={createItem.pluggy.organizzeAmountCents}
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

              {createItem.pluggy.kind === 'invoice_payment_candidate' ||
              createItem.pluggy.kind === 'bank' ? (
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
                        invoices={invoicesByCard[Number(invoiceCardId)] ?? []}
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

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn ghost"
                  disabled={modalBusy}
                  onClick={closeCreateModal}
                >
                  Cancelar
                </button>
                {(createItem.pluggy.kind === 'invoice_payment_candidate' ||
                  createItem.pluggy.kind === 'bank') &&
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
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {ignoredOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => {
            if (!restoringId) {
              setIgnoredOpen(false)
            }
          }}
        >
          <div
            className="modal-card ignored-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ignored-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <div>
                <h2 id="ignored-title">Ignorados</h2>
                <p>
                  Lançamentos ignorados em {formatMonthTitle(yearMonth)}.
                  Restaurar coloca de volta na fila.
                </p>
              </div>
              <button
                type="button"
                className="modal-close"
                disabled={Boolean(restoringId)}
                onClick={() => setIgnoredOpen(false)}
                aria-label="Fechar"
                title="Fechar"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  aria-hidden="true"
                >
                  <path
                    d="M3 3l8 8M11 3L3 11"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>

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
          </div>
        </div>
      ) : null}
    </section>
  )
}
