import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import {
  CashflowPanel,
  type ReportsCashflowOverviewResponse,
} from './CashflowPanel'
import {
  InstallmentsPanel,
  type InstallmentsOverviewResponse,
} from './InstallmentsPanel'
import {
  InvestmentsPanel,
  type InvestmentsOverviewResponse,
} from './InvestmentsPanel'
import { MonthNavigator } from './MonthNavigator'
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
  const [cashflow, setCashflow] =
    useState<ReportsCashflowOverviewResponse | null>(null)
  const failedLoadRef = useRef(false)

  const chartMonths = useMemo(() => {
    if (section === 'cashflow') {
      return cashflow?.months.map((m) => m.monthKey) ?? []
    }
    return installments?.monthlyBars.map((bar) => bar.monthKey) ?? []
  }, [section, cashflow, installments])

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

  const loadCashflow = useCallback(
    async (monthForYear: string) => {
      setLoading(true)
      onError(null)
      try {
        const data = await apiFetch<ReportsCashflowOverviewResponse>(
          `/api/reports/cashflow?month=${encodeURIComponent(monthForYear)}`,
        )
        failedLoadRef.current = false
        setCashflow(data)
        setSelectedMonth((current) => {
          const keys = data.months.map((m) => m.monthKey)
          if (keys.includes(current)) {
            return current
          }
          const sameMonth = data.months.find(
            (m) => m.monthKey.slice(5) === current.slice(5),
          )
          return sameMonth?.monthKey ?? data.selectedMonth
        })
      } catch (err) {
        failedLoadRef.current = true
        onError(
          err instanceof Error
            ? err.message
            : 'Erro ao carregar fluxo de caixa',
        )
      } finally {
        setLoading(false)
      }
    },
    [apiFetch, onError],
  )

  const changeSelectedMonth = useCallback(
    (month: string) => {
      // Parcelas: only months inside the chart window.
      // Caixa: any month (changing year reloads that calendar year).
      if (
        section === 'installments' &&
        chartMonths.length > 0 &&
        !chartMonths.includes(month)
      ) {
        return
      }
      setSelectedMonth((current) => (current === month ? current : month))
      syncDashboardUrl({ month }, 'push')
    },
    [section, chartMonths, syncDashboardUrl],
  )

  const changeSection = useCallback(
    (next: Section) => {
      setSection(next)
      failedLoadRef.current = false
      syncDashboardUrl({ section: next }, 'push')
    },
    [syncDashboardUrl],
  )

  const refresh = useCallback(async () => {
    failedLoadRef.current = false
    if (section === 'installments') {
      await loadInstallments()
      return
    }
    if (section === 'cashflow') {
      setCashflow(null)
      await loadCashflow(selectedMonth)
      return
    }
    await loadInvestments()
  }, [section, selectedMonth, loadInstallments, loadInvestments, loadCashflow])

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
    if (section === 'investments') {
      if (!investments && !loading) {
        void loadInvestments()
      }
      return
    }
    if (section === 'cashflow') {
      if (loading || failedLoadRef.current) {
        return
      }
      const selectedYear = Number(selectedMonth.slice(0, 4))
      if (cashflow && cashflow.year === selectedYear) {
        return
      }
      void loadCashflow(selectedMonth)
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
    cashflow,
    loading,
    selectedMonth,
    loadInstallments,
    loadInvestments,
    loadCashflow,
  ])

  // Parcelas: keep URL month inside the chart window once data is loaded.
  useEffect(() => {
    if (section !== 'installments') {
      return
    }
    if (chartMonths.length === 0) {
      return
    }
    if (chartMonths.includes(selectedMonth)) {
      return
    }
    const next = installments?.selectedMonth ?? chartMonths[0]
    if (!next) {
      return
    }
    setSelectedMonth(next)
    syncDashboardUrl({ month: next }, 'replace')
  }, [
    section,
    installments,
    chartMonths,
    selectedMonth,
    syncDashboardUrl,
  ])

  const selectedIndex = chartMonths.indexOf(selectedMonth)
  const canGoPrev = selectedIndex > 0
  const canGoNext =
    selectedIndex >= 0 && selectedIndex < chartMonths.length - 1
  const chartMin = chartMonths[0]
  const chartMax = chartMonths[chartMonths.length - 1]
  const monthNavDisabled =
    loading ||
    (section === 'installments' && chartMonths.length === 0) ||
    section === 'investments'

  return (
    <section className="dashboard reports">
      <PullToRefresh onRefresh={refresh} disabled={loading}>
        <div className="reports-shell">
          <header className="reports-header">
            <div className="reports-header-top">
              <h1>Relatórios</h1>
              <MonthNavigator
                value={selectedMonth}
                disabled={monthNavDisabled}
                min={section === 'installments' ? chartMin : undefined}
                max={section === 'installments' ? chartMax : undefined}
                disablePrev={
                  section === 'installments'
                    ? !canGoPrev
                    : section === 'investments'
                }
                disableNext={
                  section === 'installments'
                    ? !canGoNext
                    : section === 'investments'
                }
                onChange={changeSelectedMonth}
              />
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
                aria-selected={section === 'cashflow'}
                className={section === 'cashflow' ? 'active' : ''}
                onClick={() => changeSection('cashflow')}
              >
                Caixa
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
              (section === 'investments' && !investments) ||
              (section === 'cashflow' && !cashflow)) ? (
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
            {section === 'cashflow' && cashflow ? (
              <CashflowPanel
                data={cashflow}
                selectedMonth={selectedMonth}
                onSelectMonth={changeSelectedMonth}
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
