import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { BottomSheet } from './BottomSheet'
import { CategoryPicker, type CategoryOption } from './CategoryPicker'
import { ConfirmDialog } from './ConfirmDialog'
import { MoneyInput } from './MoneyInput.tsx'
import { OptionPicker } from './OptionPicker'
import { PullToRefresh } from './PullToRefresh'
import { TagPicker, type TagOption } from './TagPicker'
import { ROUTES } from './routes'

type ApiFetch = <T>(path: string, init?: RequestInit) => Promise<T>

type Props = {
  apiFetch: ApiFetch
  onError: (message: string | null) => void
}

type RecurringKind = 'EXPENSE' | 'INCOME'
type RecurringUnit = 'DAY' | 'WEEK' | 'MONTH'
type OccurrenceStatus = 'PENDING' | 'CREATED' | 'FAILED'

type SeriesSummary = {
  id: string
  kind: RecurringKind
  description: string
  amountCents: number
  accountId: number
  categoryId: number | null
  tags: string[]
  startDate: string
  endDate: string
  intervalUnit: RecurringUnit
  intervalCount: number
  status: 'ACTIVE' | 'CANCELLED'
  createdCount: number
  failedCount: number
  totalCount: number
  totalAmountCents: number
  createdAt: string
  updatedAt: string
}

type Occurrence = {
  id: string
  index: number
  scheduledDate: string
  amountCents: number
  organizzeTransactionId: number | null
  status: OccurrenceStatus
  lastError: string | null
}

type SeriesDetail = SeriesSummary & {
  occurrences: Occurrence[]
}

type PreviewResult = {
  count: number
  totalAmountCents: number
  dates: string[]
}

type OrganizzeAccount = {
  id: number
  name: string
  archived: boolean
}

type FormState = {
  kind: RecurringKind
  description: string
  amountCents: number | null
  accountId: string
  categoryId: string
  tags: string[]
  startDate: string
  endDate: string
  intervalUnit: RecurringUnit
  intervalCount: string
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function addYearsISO(iso: string, years: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const next = new Date(Date.UTC(y + years, m - 1, d))
  return next.toISOString().slice(0, 10)
}

function formatBRL(amountCents: number): string {
  return (amountCents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) {
    return iso
  }
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('pt-BR', {
    timeZone: 'UTC',
  })
}

function intervalLabel(unit: RecurringUnit, count: number): string {
  const n = Math.max(1, count)
  if (unit === 'DAY') {
    return n === 1 ? 'todo dia' : `a cada ${n} dias`
  }
  if (unit === 'WEEK') {
    return n === 1 ? 'toda semana' : `a cada ${n} semanas`
  }
  return n === 1 ? 'todo mês' : `a cada ${n} meses`
}

function kindLabel(kind: RecurringKind): string {
  return kind === 'INCOME' ? 'Receita' : 'Despesa'
}

function occurrenceStatusLabel(status: OccurrenceStatus): string {
  switch (status) {
    case 'CREATED':
      return 'Criado'
    case 'FAILED':
      return 'Falhou'
    default:
      return 'Pendente'
  }
}

function emptyForm(): FormState {
  const start = todayISO()
  return {
    kind: 'EXPENSE',
    description: '',
    amountCents: null,
    accountId: '',
    categoryId: '',
    tags: [],
    startDate: start,
    endDate: addYearsISO(start, 1),
    intervalUnit: 'WEEK',
    intervalCount: '1',
  }
}

function formFromSeries(series: SeriesDetail): FormState {
  return {
    kind: series.kind,
    description: series.description,
    amountCents: Math.abs(series.amountCents),
    accountId: String(series.accountId),
    categoryId: series.categoryId != null ? String(series.categoryId) : '',
    tags: [...series.tags],
    startDate: series.startDate.slice(0, 10),
    endDate: series.endDate.slice(0, 10),
    intervalUnit: series.intervalUnit,
    intervalCount: String(series.intervalCount),
  }
}

export function CustomRecurringView({ apiFetch, onError }: Props) {
  const location = useLocation()
  const isActive = location.pathname === ROUTES.recurring
  const wasActiveRef = useRef(false)

  const [series, setSeries] = useState<SeriesSummary[]>([])
  const [accounts, setAccounts] = useState<OrganizzeAccount[]>([])
  const [categories, setCategories] = useState<CategoryOption[]>([])
  const [tags, setTags] = useState<TagOption[]>([])
  const [tagsLoaded, setTagsLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editOriginalCount, setEditOriginalCount] = useState<number | null>(
    null,
  )
  const [form, setForm] = useState<FormState>(emptyForm)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const [detail, setDetail] = useState<SeriesDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SeriesSummary | null>(null)
  const [deleting, setDeleting] = useState(false)

  const activeAccounts = useMemo(
    () => accounts.filter((account) => account.archived !== true),
    [accounts],
  )

  const accountOptions = useMemo(
    () =>
      activeAccounts.map((account) => ({
        value: String(account.id),
        label: account.name,
      })),
    [activeAccounts],
  )

  const accountNameById = useMemo(() => {
    const map = new Map<number, string>()
    for (const account of accounts) {
      map.set(account.id, account.name)
    }
    return map
  }, [accounts])

  const loadLookups = useCallback(async () => {
    const [accts, cats] = await Promise.all([
      apiFetch<OrganizzeAccount[]>('/api/organizze/accounts'),
      apiFetch<CategoryOption[]>('/api/organizze/categories'),
    ])
    setAccounts(accts)
    setCategories(cats)
    return accts.filter((account) => account.archived !== true)
  }, [apiFetch])

  const loadList = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) {
        onError(null)
        setLoading(true)
        setStatusMessage('Carregando recorrências…')
      }
      try {
        const [rows] = await Promise.all([
          apiFetch<SeriesSummary[]>('/api/custom-recurring'),
          loadLookups().catch(() => [] as OrganizzeAccount[]),
        ])
        setSeries(rows)
        if (!options?.silent) {
          setStatusMessage(
            rows.length === 0
              ? 'Nenhuma recorrência ainda.'
              : `${rows.length} série(s).`,
          )
        }
      } catch (err) {
        onError(
          err instanceof Error ? err.message : 'Erro ao carregar recorrências',
        )
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
    [apiFetch, loadLookups, onError],
  )

  const ensureFormLookups = useCallback(async () => {
    try {
      if (accounts.length === 0 || categories.length === 0) {
        await loadLookups()
      }
    } catch (err) {
      onError(
        err instanceof Error ? err.message : 'Erro ao carregar contas',
      )
    }
    if (!tagsLoaded) {
      try {
        const next = await apiFetch<TagOption[]>('/api/organizze/tags')
        setTags(next)
        setTagsLoaded(true)
      } catch {
        // tags are optional; picker still allows free typing
      }
    }
  }, [
    accounts.length,
    apiFetch,
    categories.length,
    loadLookups,
    onError,
    tagsLoaded,
  ])

  useEffect(() => {
    if (isActive && !wasActiveRef.current) {
      void loadList().catch(() => undefined)
    }
    wasActiveRef.current = isActive
  }, [isActive, loadList])

  useEffect(() => {
    if (!formOpen) {
      setPreview(null)
      setPreviewError(null)
      return
    }
    const amountCents = form.amountCents
    const intervalCount = Number(form.intervalCount)
    if (
      amountCents === null ||
      amountCents <= 0 ||
      !form.startDate ||
      !form.endDate ||
      !Number.isFinite(intervalCount) ||
      intervalCount < 1
    ) {
      setPreview(null)
      setPreviewError(null)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void apiFetch<PreviewResult>('/api/custom-recurring/preview', {
        method: 'POST',
        body: JSON.stringify({
          startDate: form.startDate,
          endDate: form.endDate,
          intervalUnit: form.intervalUnit,
          intervalCount,
          amountCents,
          kind: form.kind,
        }),
      })
        .then((result) => {
          if (!cancelled) {
            setPreview(result)
            setPreviewError(null)
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setPreview(null)
            setPreviewError(
              err instanceof Error ? err.message : 'Preview inválido',
            )
          }
        })
    }, 280)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    formOpen,
    form.amountCents,
    form.startDate,
    form.endDate,
    form.intervalUnit,
    form.intervalCount,
    form.kind,
    apiFetch,
  ])

  const openCreate = () => {
    const next = emptyForm()
    if (activeAccounts.length === 1) {
      next.accountId = String(activeAccounts[0].id)
    }
    setEditingId(null)
    setEditOriginalCount(null)
    setForm(next)
    setFormOpen(true)
    onError(null)
    void (async () => {
      await ensureFormLookups()
      if (next.accountId) {
        return
      }
      try {
        const fresh = await loadLookups()
        if (fresh.length === 1) {
          setForm((current) => ({
            ...current,
            accountId: String(fresh[0].id),
          }))
        }
      } catch {
        // ensureFormLookups already reported
      }
    })()
  }

  const openEdit = (row: SeriesDetail) => {
    setDetail(null)
    setEditingId(row.id)
    setEditOriginalCount(row.totalCount)
    setForm(formFromSeries(row))
    setFormOpen(true)
    onError(null)
    void ensureFormLookups()
  }

  const closeForm = () => {
    if (saving) {
      return
    }
    setFormOpen(false)
    setEditingId(null)
    setEditOriginalCount(null)
  }

  const openDetail = async (id: string) => {
    setDetailLoading(true)
    onError(null)
    try {
      const row = await apiFetch<SeriesDetail>(`/api/custom-recurring/${id}`)
      setDetail(row)
    } catch (err) {
      onError(
        err instanceof Error ? err.message : 'Erro ao abrir recorrência',
      )
    } finally {
      setDetailLoading(false)
    }
  }

  const closeDetail = () => {
    if (saving || deleting) {
      return
    }
    setDetail(null)
  }

  const submitForm = async () => {
    if (form.endDate < form.startDate) {
      onError('A data fim deve ser ≥ data início')
      return
    }

    if (editingId) {
      setSaving(true)
      onError(null)
      try {
        const saved = await apiFetch<SeriesDetail>(
          `/api/custom-recurring/${editingId}`,
          {
            method: 'PUT',
            body: JSON.stringify({ endDate: form.endDate }),
          },
        )
        setFormOpen(false)
        setEditingId(null)
        setEditOriginalCount(null)
        setDetail(saved)
        await loadList({ silent: true })
        setStatusMessage(
          `Série atualizada · ${saved.createdCount}/${saved.totalCount} no Organizze.`,
        )
      } catch (err) {
        onError(
          err instanceof Error ? err.message : 'Erro ao atualizar série',
        )
      } finally {
        setSaving(false)
      }
      return
    }

    const description = form.description.trim()
    if (!description) {
      onError('Informe a descrição')
      return
    }
    const amountCents = form.amountCents
    if (amountCents === null || amountCents <= 0) {
      onError('Informe um valor válido')
      return
    }
    const accountId = Number(form.accountId)
    if (!Number.isFinite(accountId) || accountId <= 0) {
      onError('Selecione a conta')
      return
    }
    const intervalCount = Number(form.intervalCount)
    if (!Number.isFinite(intervalCount) || intervalCount < 1) {
      onError('Informe o intervalo (N)')
      return
    }

    const categoryId = form.categoryId ? Number(form.categoryId) : null
    const body = {
      kind: form.kind,
      description,
      amountCents,
      accountId,
      categoryId:
        categoryId != null && Number.isFinite(categoryId) ? categoryId : null,
      tags: form.tags,
      startDate: form.startDate,
      endDate: form.endDate,
      intervalUnit: form.intervalUnit,
      intervalCount,
    }

    setSaving(true)
    onError(null)
    try {
      const saved = await apiFetch<SeriesDetail>('/api/custom-recurring', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setFormOpen(false)
      setEditingId(null)
      setEditOriginalCount(null)
      setDetail(saved)
      await loadList({ silent: true })
      setStatusMessage(
        `Série criada · ${saved.createdCount}/${saved.totalCount} no Organizze.`,
      )
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Erro ao criar série')
    } finally {
      setSaving(false)
    }
  }

  const retryFailed = async () => {
    if (!detail || detail.failedCount === 0) {
      return
    }
    setRetrying(true)
    onError(null)
    try {
      const saved = await apiFetch<SeriesDetail>(
        `/api/custom-recurring/${detail.id}/retry`,
        { method: 'POST' },
      )
      setDetail(saved)
      await loadList({ silent: true })
      setStatusMessage(
        saved.failedCount > 0
          ? `Retry: ${saved.createdCount}/${saved.totalCount} · ${saved.failedCount} ainda falhou.`
          : `Retry ok · ${saved.createdCount}/${saved.totalCount} no Organizze.`,
      )
    } catch (err) {
      onError(
        err instanceof Error ? err.message : 'Erro ao recriar falhas',
      )
    } finally {
      setRetrying(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) {
      return
    }
    setDeleting(true)
    onError(null)
    try {
      await apiFetch<{ ok: true }>(`/api/custom-recurring/${deleteTarget.id}`, {
        method: 'DELETE',
      })
      setDeleteTarget(null)
      if (detail?.id === deleteTarget.id) {
        setDetail(null)
      }
      await loadList({ silent: true })
      setStatusMessage('Série cancelada · futuros removidos do Organizze.')
    } catch (err) {
      onError(
        err instanceof Error ? err.message : 'Erro ao apagar recorrência',
      )
    } finally {
      setDeleting(false)
    }
  }

  const signedPreviewCents =
    preview == null
      ? null
      : form.kind === 'EXPENSE'
        ? -preview.totalAmountCents
        : preview.totalAmountCents

  return (
    <>
      <PullToRefresh
        onRefresh={() => loadList()}
        disabled={loading || saving || !isActive}
      >
        <section className="reports-shell recurring-shell">
          <header className="reports-header">
            <div className="settings-header-top">
              <h1>Recorrências</h1>
              <button
                type="button"
                className="reports-refresh"
                disabled={loading || saving}
                onClick={() => void loadList()}
              >
                {loading ? 'Atualizando…' : 'Atualizar'}
              </button>
              <button
                type="button"
                className="btn"
                disabled={loading || saving}
                onClick={openCreate}
              >
                Nova série
              </button>
            </div>
            <p className="settings-header-copy">
              Lançamentos normais no Organizze, gerados pelo app (ex.: a cada 5
              semanas). Cartão fica fora do v1.
            </p>
          </header>

          <div className="reports-body recurring-body">
            {statusMessage || loading ? (
              <div
                className={`status-banner ${loading ? 'busy' : ''}`}
                role="status"
                aria-live="polite"
              >
                {loading ? <span className="spinner" aria-hidden /> : null}
                <span>{statusMessage}</span>
              </div>
            ) : null}

            {loading && series.length === 0 ? (
              <div className="empty loading-empty">
                <span className="spinner lg" aria-hidden />
                <p>Carregando…</p>
              </div>
            ) : series.length === 0 ? (
              <div className="empty">
                <p>Nenhuma recorrência customizada.</p>
                <button type="button" className="btn" onClick={openCreate}>
                  Criar primeira série
                </button>
              </div>
            ) : (
              <ul className="recurring-list">
                {series.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      className="recurring-card"
                      disabled={detailLoading}
                      onClick={() => void openDetail(row.id)}
                    >
                      <div className="recurring-card-head">
                        <div>
                          <span
                            className={`recurring-kind ${row.kind === 'INCOME' ? 'is-income' : 'is-expense'}`}
                          >
                            {kindLabel(row.kind)}
                          </span>
                          <strong>{row.description}</strong>
                        </div>
                        <strong
                          className={row.kind === 'INCOME' ? 'pos' : 'neg'}
                        >
                          {row.kind === 'EXPENSE' ? '−' : '+'}
                          {formatBRL(row.amountCents)}
                        </strong>
                      </div>
                      <div className="recurring-card-meta">
                        <span>
                          {intervalLabel(row.intervalUnit, row.intervalCount)}
                        </span>
                        <span>
                          {formatDate(row.startDate)} →{' '}
                          {formatDate(row.endDate)}
                        </span>
                        <span>
                          {accountNameById.get(row.accountId) ??
                            `Conta #${row.accountId}`}
                        </span>
                      </div>
                      <div className="recurring-card-progress">
                        <span>
                          {row.createdCount}/{row.totalCount} no Organizze
                          {row.failedCount > 0
                            ? ` · ${row.failedCount} falha(s)`
                            : ''}
                        </span>
                        <strong>
                          Total {formatBRL(row.totalAmountCents)}
                        </strong>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </PullToRefresh>

      {formOpen ? (
        <BottomSheet
          onClose={closeForm}
          busy={saving}
          busyLabel={editingId ? 'Atualizando série…' : 'Criando série…'}
          busyHint={
            editingId
              ? 'Adicionando ou removendo lançamentos no Organizze.'
              : 'Gerando datas e lançamentos no Organizze.'
          }
          labelledBy="recurring-form-title"
          title={editingId ? 'Ajustar data fim' : 'Nova recorrência'}
          subtitle={
            editingId
              ? 'Só a data fim muda — acrescenta ou remove lançamentos no fim da série.'
              : 'Cria lançamentos avulsos no Organizze — sem recorrência nativa.'
          }
        >
          <div className="settings-form modal-body">
            {editingId ? (
              <>
                <div className="create-destination">
                  <div className="create-destination-row">
                    <span>Série</span>
                    <strong>{form.description}</strong>
                  </div>
                  <div className="create-destination-row">
                    <span>Tipo</span>
                    <strong>{kindLabel(form.kind)}</strong>
                  </div>
                  <div className="create-destination-row">
                    <span>Valor</span>
                    <strong className={form.kind === 'INCOME' ? 'pos' : 'neg'}>
                      {form.kind === 'EXPENSE' ? '−' : '+'}
                      {formatBRL(
                        form.amountCents ?? 0,
                      )}
                    </strong>
                  </div>
                  <div className="create-destination-row">
                    <span>Conta</span>
                    <strong>
                      {accountNameById.get(Number(form.accountId)) ??
                        (form.accountId ? `#${form.accountId}` : '—')}
                    </strong>
                  </div>
                  <div className="create-destination-row">
                    <span>Cadência</span>
                    <strong>
                      {intervalLabel(
                        form.intervalUnit,
                        Number(form.intervalCount) || 1,
                      )}
                    </strong>
                  </div>
                  <div className="create-destination-row">
                    <span>1º lançamento</span>
                    <strong>{formatDate(form.startDate)}</strong>
                  </div>
                </div>

                <label>
                  Até
                  <input
                    type="date"
                    value={form.endDate}
                    min={form.startDate}
                    disabled={saving}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        endDate: event.target.value,
                      }))
                    }
                  />
                  <small className="field-hint">
                    Antecipar remove lançamentos além dessa data; adiar cria os
                    faltantes.
                  </small>
                </label>
              </>
            ) : (
              <>
                <label>
                  Tipo
                  <OptionPicker
                    value={form.kind}
                    disabled={saving}
                    options={[
                      { value: 'EXPENSE', label: 'Despesa' },
                      { value: 'INCOME', label: 'Receita' },
                    ]}
                    onChange={(value) =>
                      setForm((current) => ({
                        ...current,
                        kind: value as RecurringKind,
                      }))
                    }
                  />
                </label>

                <label>
                  Descrição
                  <input
                    value={form.description}
                    disabled={saving}
                    maxLength={200}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        description: event.target.value,
                      }))
                    }
                  />
                </label>

                <label>
                  Valor (R$)
                  <MoneyInput
                    valueCents={form.amountCents}
                    disabled={saving}
                    onChangeCents={(amountCents) =>
                      setForm((current) => ({
                        ...current,
                        amountCents,
                      }))
                    }
                  />
                </label>

                <label>
                  Conta
                  <OptionPicker
                    value={form.accountId}
                    options={accountOptions}
                    disabled={saving}
                    searchable
                    placeholder={
                      accountOptions.length === 0
                        ? 'Carregando contas…'
                        : 'Escolher conta…'
                    }
                    onChange={(value) =>
                      setForm((current) => ({
                        ...current,
                        accountId: value,
                      }))
                    }
                  />
                  {formOpen && accountOptions.length === 0 ? (
                    <small className="field-hint">
                      Nenhuma conta bancária disponível no Organizze.
                    </small>
                  ) : null}
                </label>

                <label>
                  Categoria
                  <CategoryPicker
                    categories={categories}
                    value={form.categoryId}
                    amountCents={
                      form.kind === 'EXPENSE'
                        ? -(form.amountCents ?? 100)
                        : form.amountCents ?? 100
                    }
                    disabled={saving}
                    onChange={(categoryId) =>
                      setForm((current) => ({ ...current, categoryId }))
                    }
                  />
                </label>

                <label>
                  Tags
                  <TagPicker
                    suggestions={tags}
                    value={form.tags}
                    disabled={saving}
                    onChange={(next) =>
                      setForm((current) => ({ ...current, tags: next }))
                    }
                  />
                  <small className="field-hint">
                    Selecione existentes ou digite e Enter para criar.
                  </small>
                </label>

                <div className="recurring-date-row">
                  <label>
                    1º lançamento
                    <input
                      type="date"
                      value={form.startDate}
                      disabled={saving}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          startDate: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Até
                    <input
                      type="date"
                      value={form.endDate}
                      disabled={saving}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          endDate: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>

                <div className="recurring-date-row">
                  <label>
                    A cada
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={form.intervalCount}
                      disabled={saving}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          intervalCount: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    Unidade
                    <OptionPicker
                      value={form.intervalUnit}
                      disabled={saving}
                      options={[
                        { value: 'DAY', label: 'dias' },
                        { value: 'WEEK', label: 'semanas' },
                        { value: 'MONTH', label: 'meses' },
                      ]}
                      onChange={(value) =>
                        setForm((current) => ({
                          ...current,
                          intervalUnit: value as RecurringUnit,
                        }))
                      }
                    />
                  </label>
                </div>
              </>
            )}

            {previewError ? (
              <p className="error">{previewError}</p>
            ) : preview ? (
              <p className="recurring-preview" role="status">
                {editingId && editOriginalCount != null ? (
                  <>
                    Ficam <strong>{preview.count}</strong> lançamento
                    {preview.count === 1 ? '' : 's'}
                    {preview.count === editOriginalCount
                      ? ' (sem mudança)'
                      : preview.count > editOriginalCount
                        ? ` · +${preview.count - editOriginalCount} novo(s)`
                        : ` · −${editOriginalCount - preview.count} removido(s)`}
                    {' · total '}
                    <strong
                      className={
                        signedPreviewCents != null && signedPreviewCents < 0
                          ? 'neg'
                          : 'pos'
                      }
                    >
                      {formatBRL(preview.totalAmountCents)}
                    </strong>
                  </>
                ) : (
                  <>
                    Serão criados <strong>{preview.count}</strong> lançamento
                    {preview.count === 1 ? '' : 's'} · total{' '}
                    <strong
                      className={
                        signedPreviewCents != null && signedPreviewCents < 0
                          ? 'neg'
                          : 'pos'
                      }
                    >
                      {formatBRL(preview.totalAmountCents)}
                    </strong>
                    {' · '}
                    {intervalLabel(
                      form.intervalUnit,
                      Number(form.intervalCount) || 1,
                    )}
                  </>
                )}
              </p>
            ) : (
              <p className="field-hint">
                {editingId
                  ? 'Ajuste a data fim para ver quantos lançamentos entram ou saem.'
                  : 'Preencha valor, datas e intervalo para ver o preview.'}
              </p>
            )}

            <div className="modal-actions">
              <button
                type="button"
                className="btn ghost"
                disabled={saving}
                onClick={closeForm}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn"
                disabled={saving || Boolean(previewError)}
                onClick={() => void submitForm()}
              >
                {editingId ? 'Salvar data fim' : 'Criar série'}
              </button>
            </div>
          </div>
        </BottomSheet>
      ) : null}

      {detail ? (
        <BottomSheet
          onClose={closeDetail}
          busy={saving || deleting || retrying}
          labelledBy="recurring-detail-title"
          title={detail.description}
          subtitle={`${kindLabel(detail.kind)} · ${intervalLabel(detail.intervalUnit, detail.intervalCount)} · ${detail.createdCount}/${detail.totalCount}`}
        >
          <div className="settings-form modal-body">
            <div className="create-destination">
              <div className="create-destination-row">
                <span>Valor unitário</span>
                <strong className={detail.kind === 'INCOME' ? 'pos' : 'neg'}>
                  {detail.kind === 'EXPENSE' ? '−' : '+'}
                  {formatBRL(detail.amountCents)}
                </strong>
              </div>
              <div className="create-destination-row">
                <span>Total da série</span>
                <strong>{formatBRL(detail.totalAmountCents)}</strong>
              </div>
              <div className="create-destination-row">
                <span>Conta</span>
                <strong>
                  {accountNameById.get(detail.accountId) ??
                    `#${detail.accountId}`}
                </strong>
              </div>
              <div className="create-destination-row">
                <span>Período</span>
                <strong>
                  {formatDate(detail.startDate)} → {formatDate(detail.endDate)}
                </strong>
              </div>
              {detail.tags.length > 0 ? (
                <div className="create-destination-row">
                  <span>Tags</span>
                  <strong>{detail.tags.join(', ')}</strong>
                </div>
              ) : null}
            </div>

            <ul className="recurring-occ-list">
              {detail.occurrences.map((occ) => (
                <li key={occ.id} className="recurring-occ-row">
                  <div>
                    <strong>{formatDate(occ.scheduledDate)}</strong>
                    <span>
                      #{occ.index + 1} · {occurrenceStatusLabel(occ.status)}
                      {occ.organizzeTransactionId != null
                        ? ` · Oz #${occ.organizzeTransactionId}`
                        : ''}
                    </span>
                    {occ.lastError ? (
                      <small className="error">{occ.lastError}</small>
                    ) : null}
                  </div>
                  <strong className={detail.kind === 'INCOME' ? 'pos' : 'neg'}>
                    {formatBRL(occ.amountCents)}
                  </strong>
                </li>
              ))}
            </ul>

            <div className="modal-actions">
              <button
                type="button"
                className="btn ghost"
                disabled={saving || deleting || retrying}
                onClick={() => setDeleteTarget(detail)}
              >
                Apagar
              </button>
              {detail.failedCount > 0 ? (
                <button
                  type="button"
                  className="btn ghost"
                  disabled={saving || deleting || retrying}
                  onClick={() => void retryFailed()}
                >
                  {retrying ? 'Recriando…' : 'Recriar falhas'}
                </button>
              ) : null}
              <button
                type="button"
                className="btn"
                disabled={saving || deleting || retrying}
                onClick={() => openEdit(detail)}
              >
                Editar
              </button>
            </div>
          </div>
        </BottomSheet>
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title="Apagar recorrência?"
          message={`Remove lançamentos futuros não pagos do Organizze e cancela “${deleteTarget.description}”. Passado permanece no histórico.`}
          confirmLabel="Apagar série"
          busyLabel="Apagando…"
          busy={deleting}
          danger
          onCancel={() => {
            if (!deleting) {
              setDeleteTarget(null)
            }
          }}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </>
  )
}
