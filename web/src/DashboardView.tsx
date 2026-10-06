import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import {
  InstallmentsPanel,
  type InstallmentsOverviewResponse,
} from './InstallmentsPanel'
import {
  InvestmentsPanel,
  type InvestmentsOverviewResponse,
} from './InvestmentsPanel'
import { PullToRefresh } from './PullToRefresh'
import {
  patchSearchParams,
  readMonthParam,
  readSectionParam,
  resolveYearMonth,
  ROUTES,
  type ReportSection,
} from './routes'

type ApiFetch = <T>(path: string, init?: RequestInit) => Promise<T>

type Props = {
  apiFetch: ApiFetch
  onError: (message: string | null) => void
}

type Section = ReportSection

function currentMonthKeySaoPaulo(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
  })
    .format(new Date())
    .slice(0, 7)
}

function formatMonthTitle(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function DashboardView({ apiFetch, onError }: Props) {
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const isActive = location.pathname === ROUTES.dashboard
  const wasActiveRef = useRef(isActive)

  const [section, setSection] = useState<Section>(
    () =>
      readSectionParam(new URLSearchParams(window.location.search)) ??
      'installments',
  )
  const [loading, setLoading] = useState(false)
  const [selectedMonth, setSelectedMonth] = useState(
    () =>
      readMonthParam(new URLSearchParams(window.location.search)) ??
      currentMonthKeySaoPaulo(),
  )
  const [installments, setInstallments] =
    useState<InstallmentsOverviewResponse | null>(null)
  const [investments, setInvestments] =
    useState<InvestmentsOverviewResponse | null>(null)
  const failedLoadRef = useRef(false)

  const chartMonths = useMemo(
    () => installments?.monthlyBars.map((bar) => bar.monthKey) ?? [],
    [installments],
  )

  const syncDashboardUrl = useCallback(
    (
      patch: { month?: string; section?: Section },
      mode: 'push' | 'replace',
    ) => {
      if (!isActive) {
        return
      }
      const nextMonth = patch.month ?? selectedMonth
      const nextSection = patch.section ?? section
      setSearchParams(
        (current) =>
          patchSearchParams(current, {
            month: nextMonth,
            section: nextSection === 'installments' ? null : nextSection,
            account: null,
            kind: null,
            q: null,
            tab: null,
          }),
        { replace: mode === 'replace' },
      )
    },
    [isActive, selectedMonth, section, setSearchParams],
  )

  useEffect(() => {
    if (isActive && !wasActiveRef.current) {
      syncDashboardUrl({}, 'replace')
    }
    wasActiveRef.current = isActive
  }, [isActive, syncDashboardUrl])

  useEffect(() => {
    if (!isActive) {
      return
    }
    const nextSection = readSectionParam(searchParams) ?? 'installments'
    setSection(nextSection)
    const month = resolveYearMonth(searchParams, currentMonthKeySaoPaulo())
    setSelectedMonth((current) => (current === month ? current : month))
  }, [searchParams, isActive])

  const loadInstallments = useCallback(async () => {
    setLoading(true)
    onError(null)
    try {
      const data = await apiFetch<InstallmentsOverviewResponse>(
        '/api/installments/overview',
      )
      failedLoadRef.current = false
      setInstallments(data)
      setSelectedMonth((current) => {
        const chartKeys = data.monthlyBars.map((bar) => bar.monthKey)
        if (chartKeys.includes(current)) {
          return current
        }
        return data.selectedMonth
      })
    } catch (err) {
      failedLoadRef.current = true
      onError(
        err instanceof Error ? err.message : 'Erro ao carregar parcelas',
      )
    } finally {
      setLoading(false)
    }
  }, [apiFetch, onError])

  const loadInvestments = useCallback(async () => {
    setLoading(true)
    onError(null)
    try {
      const data = await apiFetch<InvestmentsOverviewResponse>(
        '/api/investments/overview',
      )
      setInvestments(data)
    } catch (err) {
      onError(
        err instanceof Error ? err.message : 'Erro ao carregar investimentos',
      )
    } finally {
      setLoading(false)
    }
  }, [apiFetch, onError])

  const changeSelectedMonth = useCallback(
    (month: string) => {
      if (chartMonths.length > 0 && !chartMonths.includes(month)) {
        return
      }
      setSelectedMonth((current) => (current === month ? current : month))
      syncDashboardUrl({ month }, 'push')
    },
    [chartMonths, syncDashboardUrl],
  )

  const changeSection = useCallback(
    (next: Section) => {
      setSection(next)
      syncDashboardUrl({ section: next }, 'push')
    },
    [syncDashboardUrl],
  )

  const refresh = useCallback(async () => {
    if (section === 'installments') {
      failedLoadRef.current = false
      await loadInstallments()
      return
    }
    await loadInvestments()
  }, [section, loadInstallments, loadInvestments])

  const ignorePurchase = useCallback(
    async (ignoreKey: string) => {
      onError(null)
      try {
        await apiFetch('/api/installments/ignore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: ignoreKey }),
        })
        failedLoadRef.current = false
        await loadInstallments()
      } catch (err) {
        onError(
          err instanceof Error ? err.message : 'Erro ao ignorar parcela',
        )
      }
    },
    [apiFetch, onError, loadInstallments],
  )

  const unignorePurchase = useCallback(
    async (ignoreKey: string) => {
      onError(null)
      try {
        await apiFetch(
          `/api/installments/ignore?key=${encodeURIComponent(ignoreKey)}`,
          { method: 'DELETE' },
        )
        failedLoadRef.current = false
        await loadInstallments()
      } catch (err) {
        onError(
          err instanceof Error ? err.message : 'Erro ao restaurar parcela',
        )
      }
    },
    [apiFetch, onError, loadInstallments],
  )

  useEffect(() => {
    if (section !== 'installments') {
      if (!investments && !loading) {
        void loadInvestments()
      }
      return
    }
    if (loading || installments || failedLoadRef.current) {
      return
    }
    void loadInstallments()
  }, [
    section,
    installments,
    investments,
    loading,
    loadInstallments,
    loadInvestments,
  ])

  // Keep URL month inside the chart window once data is loaded.
  useEffect(() => {
    if (!installments || chartMonths.length === 0) {
      return
    }
    if (chartMonths.includes(selectedMonth)) {
      return
    }
    const next = installments.selectedMonth
    setSelectedMonth(next)
    syncDashboardUrl({ month: next }, 'replace')
  }, [installments, chartMonths, selectedMonth, syncDashboardUrl])

  const monthTitle = formatMonthTitle(selectedMonth)
  const selectedIndex = chartMonths.indexOf(selectedMonth)
  const canGoPrev = selectedIndex > 0
  const canGoNext =
    selectedIndex >= 0 && selectedIndex < chartMonths.length - 1

  return (
    <section className="dashboard reports">
      <PullToRefresh onRefresh={refresh} disabled={loading}>
        <div className="reports-shell">
          <header className="reports-header">
            <div className="reports-header-top">
              <h1>Relatórios</h1>
              <div className="reports-month" aria-label="Mês de referência">
                <button
                  type="button"
                  className="reports-month-arrow"
                  disabled={loading || !canGoPrev}
                  aria-label="Mês anterior"
                  onClick={() => {
                    if (!canGoPrev) {
                      return
                    }
                    changeSelectedMonth(chartMonths[selectedIndex - 1])
                  }}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="reports-month-label"
                  disabled={loading || chartMonths.length === 0}
                  title="Ir para o mês atual"
                  onClick={() => {
                    const today = currentMonthKeySaoPaulo()
                    if (chartMonths.includes(today)) {
                      changeSelectedMonth(today)
                    }
                  }}
                >
                  {monthTitle}
                </button>
                <button
                  type="button"
                  className="reports-month-arrow"
                  disabled={loading || !canGoNext}
                  aria-label="Próximo mês"
                  onClick={() => {
                    if (!canGoNext) {
                      return
                    }
                    changeSelectedMonth(chartMonths[selectedIndex + 1])
                  }}
                >
                  ›
                </button>
              </div>
              <button
                type="button"
                className="reports-refresh"
                disabled={loading}
                onClick={() => void refresh()}
              >
                {loading ? 'Atualizando…' : 'Atualizar'}
              </button>
            </div>

            <div
              className="reports-tabs"
              role="tablist"
              aria-label="Seção de relatórios"
            >
              <button
                type="button"
                role="tab"
                aria-selected={section === 'installments'}
                className={section === 'installments' ? 'active' : ''}
                onClick={() => changeSection('installments')}
              >
                Parcelas
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={section === 'investments'}
                className={section === 'investments' ? 'active' : ''}
                onClick={() => changeSection('investments')}
              >
                Investimentos
              </button>
            </div>
          </header>

          <div className="reports-body">
            {loading &&
            ((section === 'installments' && !installments) ||
              (section === 'investments' && !investments)) ? (
              <p className="dash-empty">Carregando…</p>
            ) : null}

            {section === 'installments' && installments ? (
              <InstallmentsPanel
                data={installments}
                selectedMonth={selectedMonth}
                loading={loading}
                onSelectMonth={changeSelectedMonth}
                onIgnorePurchase={ignorePurchase}
                onUnignorePurchase={unignorePurchase}
              />
            ) : null}
            {section === 'investments' && investments ? (
              <InvestmentsPanel data={investments} />
            ) : null}
          </div>
        </div>
      </PullToRefresh>
    </section>
  )
}
