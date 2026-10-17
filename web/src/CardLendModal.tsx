import { useEffect, useMemo, useState } from 'react'
import { BottomSheet } from './BottomSheet'
import { CategoryPicker, type CategoryOption } from './CategoryPicker'
import { InvoicePicker, invoiceOptionLabel } from './InvoicePicker'
import { MoneyInput } from './MoneyInput.tsx'
import { OptionPicker } from './OptionPicker'

export type CardLendPluggy = {
  id: string
  description: string
  date: string
  organizzeAmountCents: number
  mappedOrganizzeTargetId: number
  installmentNumber: number | null
  totalInstallments: number | null
}

/** Parcelas restantes a criar no Organizze a partir da parcela OF atual. */
function remainingInstallments(
  installmentNumber: number | null | undefined,
  totalInstallments: number | null | undefined,
): number {
  const total = totalInstallments ?? 0
  if (total <= 1) {
    return Math.max(total, 0)
  }
  const current =
    installmentNumber != null && installmentNumber >= 1 ? installmentNumber : 1
  if (current > total) {
    return 1
  }
  return total - current + 1
}

export type CardLendInvoice = {
  id: number
  date: string
  starting_date?: string
  closing_date?: string
  amount_cents: number
  balance_cents: number
}

export type CardLendAccount = {
  id: number
  name: string
  archived?: boolean
}

export type CardLendCreditCard = {
  id: number
  name: string
  payment_account_id?: number | null
}

type PersonRow = {
  key: string
  name: string
  amountCents: number | null
}

type Props = {
  pluggy: CardLendPluggy
  cardName: string
  invoices: CardLendInvoice[]
  accounts: CardLendAccount[]
  creditCards: CardLendCreditCard[]
  categories: CategoryOption[]
  busy: boolean
  onClose: () => void
  onOpenInvoices: () => void
  onSubmit: (payload: {
    creditCardId: number
    creditCardInvoiceId: number
    description: string
    myAmountCents: number
    myCategoryId: number | null
    peopleCategoryId: number
    receiveAccountId: number
    receiveCategoryId: number
    receiveDate: string
    people: Array<{ name: string; amountCents: number }>
  }) => void
  onError: (message: string | null) => void
}

function formatBRL(amountCents: number): string {
  return (amountCents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
}

function formatDateBR(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) {
    return iso
  }
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`
}

export function defaultCardLendReceiveDate(
  invoiceDueDate: string,
  todayIso?: string,
): string {
  const due = invoiceDueDate.slice(0, 10)
  const today = (todayIso ?? new Date().toISOString().slice(0, 10)).slice(0, 10)
  const [y, m, d] = due.split('-').map(Number)
  if (!y || !m || !d) {
    return today
  }
  const utc = new Date(Date.UTC(y, m - 1, d))
  utc.setUTCDate(utc.getUTCDate() - 3)
  const candidate = utc.toISOString().slice(0, 10)
  return candidate < today ? today : candidate
}

function newPersonRow(): PersonRow {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    amountCents: null,
  }
}

export function CardLendModal({
  pluggy,
  cardName,
  invoices,
  accounts,
  creditCards,
  categories,
  busy,
  onClose,
  onOpenInvoices,
  onSubmit,
  onError,
}: Props) {
  const totalCents = Math.abs(pluggy.organizzeAmountCents)
  const creditCardId = pluggy.mappedOrganizzeTargetId
  const seriesRemaining = remainingInstallments(
    pluggy.installmentNumber,
    pluggy.totalInstallments,
  )
  const isInstallmentSeries = seriesRemaining > 1

  const [description, setDescription] = useState(pluggy.description)
  const [myAmountCents, setMyAmountCents] = useState<number | null>(null)
  const [myCategoryId, setMyCategoryId] = useState('')
  const [peopleCategoryId, setPeopleCategoryId] = useState('')
  const [receiveCategoryId, setReceiveCategoryId] = useState('')
  const [invoiceId, setInvoiceId] = useState('')
  const [receiveAccountId, setReceiveAccountId] = useState('')
  const [receiveDate, setReceiveDate] = useState('')
  const [people, setPeople] = useState<PersonRow[]>([newPersonRow()])

  const selectedInvoice = useMemo(
    () => invoices.find((invoice) => String(invoice.id) === invoiceId) ?? null,
    [invoices, invoiceId],
  )

  const accountOptions = useMemo(
    () =>
      accounts
        .filter((account) => !account.archived)
        .map((account) => ({
          value: String(account.id),
          label: account.name,
        })),
    [accounts],
  )

  useEffect(() => {
    onOpenInvoices()
    // Intentionally once per OF item open — parent callback is not memoized.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluggy.id])

  useEffect(() => {
    if (invoiceId || invoices.length === 0) {
      return
    }
    const purchaseDate = pluggy.date.slice(0, 10)
    const overlapping = invoices.find((invoice) => {
      const start = (invoice.starting_date ?? invoice.date).slice(0, 10)
      const end = (invoice.closing_date ?? invoice.date).slice(0, 10)
      return purchaseDate >= start && purchaseDate <= end
    })
    const picked = overlapping ?? invoices[0]
    if (picked) {
      setInvoiceId(String(picked.id))
    }
  }, [invoiceId, invoices, pluggy.date])

  useEffect(() => {
    if (!selectedInvoice) {
      return
    }
    setReceiveDate(defaultCardLendReceiveDate(selectedInvoice.date))
  }, [selectedInvoice])

  useEffect(() => {
    if (receiveAccountId) {
      return
    }
    const card = creditCards.find((entry) => entry.id === creditCardId)
    if (typeof card?.payment_account_id === 'number') {
      setReceiveAccountId(String(card.payment_account_id))
      return
    }
    if (accountOptions[0]) {
      setReceiveAccountId(accountOptions[0].value)
    }
  }, [accountOptions, creditCardId, creditCards, receiveAccountId])

  const myCents = myAmountCents ?? 0
  const peopleSum = people.reduce(
    (sum, row) => sum + (row.amountCents ?? 0),
    0,
  )
  const allocated = myCents + peopleSum
  const remaining = totalCents - allocated

  const submit = () => {
    onError(null)
    if (!invoiceId) {
      onError('Selecione a fatura do cartão')
      return
    }
    if (!peopleCategoryId) {
      onError('Selecione a categoria das pessoas')
      return
    }
    if (!receiveAccountId) {
      onError('Selecione a conta para receber')
      return
    }
    if (!receiveCategoryId) {
      onError('Selecione a categoria do recebimento')
      return
    }
    if (!receiveDate) {
      onError('Informe a data a receber')
      return
    }
    if (myCents > 0 && !myCategoryId) {
      onError('Selecione a categoria da sua parte')
      return
    }
    const peoplePayload: Array<{ name: string; amountCents: number }> = []
    for (const row of people) {
      const name = row.name.trim()
      if (!name) {
        onError('Informe o nome de cada pessoa')
        return
      }
      if (row.amountCents == null || row.amountCents <= 0) {
        onError(`Informe um valor válido para ${name}`)
        return
      }
      peoplePayload.push({ name, amountCents: row.amountCents })
    }
    if (Math.abs(allocated - totalCents) > 1) {
      onError(
        `A soma (${formatBRL(allocated)}) precisa fechar o total (${formatBRL(totalCents)})`,
      )
      return
    }

    onSubmit({
      creditCardId,
      creditCardInvoiceId: Number(invoiceId),
      description: description.trim() || pluggy.description,
      myAmountCents: myCents,
      myCategoryId: myCategoryId ? Number(myCategoryId) : null,
      peopleCategoryId: Number(peopleCategoryId),
      receiveAccountId: Number(receiveAccountId),
      receiveCategoryId: Number(receiveCategoryId),
      receiveDate,
      people: peoplePayload,
    })
  }

  return (
    <BottomSheet
      onClose={onClose}
      busy={busy}
      busyLabel={
        isInstallmentSeries
          ? `Criando rateio (${seriesRemaining}x)…`
          : 'Criando rateio…'
      }
      busyHint={
        isInstallmentSeries
          ? 'Séries no cartão e a receber na conta.'
          : 'Despesas no cartão e recebimentos na conta.'
      }
      labelledBy="card-lend-title"
      title="Emprestei o cartão"
      subtitle={
        isInstallmentSeries
          ? `Rateia a parcela atual e cria séries de ${seriesRemaining}x no cartão e a receber.`
          : 'Rateia a compra: sua despesa, despesas das pessoas no cartão e valores a receber na conta.'
      }
    >
      <div className="settings-form modal-body">
        <div className="create-destination" aria-label="Resumo da compra">
          <div className="create-destination-row">
            <span>Total Open Finance</span>
            <strong className="neg">{formatBRL(-totalCents)}</strong>
          </div>
          <div className="create-destination-row">
            <span>Data</span>
            <strong>{formatDateBR(pluggy.date)}</strong>
          </div>
          <div className="create-destination-row">
            <span>Cartão</span>
            <strong>{cardName}</strong>
          </div>
          <div className="create-destination-row">
            <span>Fatura</span>
            <strong>
              {selectedInvoice
                ? invoiceOptionLabel(selectedInvoice).title
                : 'Selecionar…'}
            </strong>
          </div>
          <div className="create-destination-row">
            <span>Distribuído</span>
            <strong className={remaining === 0 ? 'pos' : ''}>
              {formatBRL(allocated)}
              {remaining !== 0 ? ` · falta ${formatBRL(remaining)}` : ' · ok'}
            </strong>
          </div>
          {isInstallmentSeries ? (
            <div className="create-destination-row">
              <span>Parcelado</span>
              <strong>
                {seriesRemaining}x · valor = parcela atual rateada
                {pluggy.installmentNumber != null &&
                pluggy.totalInstallments != null
                  ? ` (OF ${pluggy.installmentNumber}/${pluggy.totalInstallments})`
                  : ''}
              </strong>
            </div>
          ) : null}
        </div>

        <label>
          Descrição da compra
          <input
            value={description}
            disabled={busy}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>

        <label>
          Fatura do cartão
          <InvoicePicker
            invoices={invoices}
            value={invoiceId}
            disabled={busy}
            emptyLabel="Escolher fatura…"
            onOpen={onOpenInvoices}
            onChange={setInvoiceId}
          />
        </label>

        <fieldset className="card-lend-section">
          <legend>Sua parte</legend>
          <label>
            Valor (R$)
            <MoneyInput
              valueCents={myAmountCents}
              disabled={busy}
              onChangeCents={setMyAmountCents}
            />
          </label>
          <label>
            Categoria da compra
            <CategoryPicker
              categories={categories}
              value={myCategoryId}
              amountCents={-1}
              disabled={busy || myCents === 0}
              emptyLabel={
                myCents === 0
                  ? 'Não precisa (sua parte é zero)'
                  : 'Escolher categoria…'
              }
              onChange={setMyCategoryId}
            />
          </label>
        </fieldset>

        <fieldset className="card-lend-section">
          <legend>Pessoas</legend>
          <label>
            Categoria das despesas delas
            <CategoryPicker
              categories={categories}
              value={peopleCategoryId}
              amountCents={-1}
              disabled={busy}
              emptyLabel="Ex.: Empréstimos / Pessoas…"
              onChange={setPeopleCategoryId}
            />
          </label>

          <div className="card-lend-people">
            {people.map((row, index) => (
              <div key={row.key} className="card-lend-person-row">
                <label>
                  Nome
                  <input
                    value={row.name}
                    disabled={busy}
                    placeholder={`Pessoa ${index + 1}`}
                    onChange={(event) => {
                      const name = event.target.value
                      setPeople((current) =>
                        current.map((entry) =>
                          entry.key === row.key ? { ...entry, name } : entry,
                        ),
                      )
                    }}
                  />
                </label>
                <label>
                  Valor (R$)
                  <MoneyInput
                    valueCents={row.amountCents}
                    disabled={busy}
                    onChangeCents={(amountCents) =>
                      setPeople((current) =>
                        current.map((entry) =>
                          entry.key === row.key
                            ? { ...entry, amountCents }
                            : entry,
                        ),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy || people.length <= 1}
                  aria-label={`Remover ${row.name || `pessoa ${index + 1}`}`}
                  onClick={() =>
                    setPeople((current) =>
                      current.filter((entry) => entry.key !== row.key),
                    )
                  }
                >
                  Remover
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn ghost"
            disabled={busy || people.length >= 20}
            onClick={() => setPeople((current) => [...current, newPersonRow()])}
          >
            + Pessoa
          </button>
        </fieldset>

        <fieldset className="card-lend-section">
          <legend>A receber</legend>
          <label>
            Conta
            <OptionPicker
              value={receiveAccountId}
              options={accountOptions}
              disabled={busy}
              placeholder="Escolher conta…"
              searchable
              onChange={setReceiveAccountId}
            />
          </label>
          <label>
            Categoria de receita
            <CategoryPicker
              categories={categories}
              value={receiveCategoryId}
              amountCents={1}
              disabled={busy}
              emptyLabel="Escolher categoria…"
              onChange={setReceiveCategoryId}
            />
          </label>
          <label>
            Data a receber
            <input
              type="date"
              value={receiveDate}
              disabled={busy}
              onChange={(event) => setReceiveDate(event.target.value)}
            />
            <small className="field-hint">
              {isInstallmentSeries
                ? `1ª parcela a receber; demais mensalmente (${seriesRemaining}x). Padrão: 3 dias antes do vencimento da fatura.`
                : 'Padrão: 3 dias antes do vencimento da fatura.'}
            </small>
          </label>
        </fieldset>

        <div className="modal-actions">
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={onClose}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={submit}
          >
            {isInstallmentSeries
              ? `Criar rateio (${seriesRemaining}x)`
              : 'Criar rateio'}
          </button>
        </div>
      </div>
    </BottomSheet>
  )
}
