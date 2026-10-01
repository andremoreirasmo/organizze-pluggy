import { useCallback, useEffect, useRef, useState } from 'react'
import {
  InstallmentsPanel,
  type InstallmentsOverviewResponse,
} from './InstallmentsPanel'
import {
  InvestmentsPanel,
  type InvestmentsOverviewResponse,
} from './InvestmentsPanel'

type ApiFetch = <T>(path: string, init?: RequestInit) => Promise<T>

type Props = {
  apiFetch: ApiFetch
  onError: (message: string | null) => void
}

type Section = 'installments' | 'investments'

function currentMonthKeySaoPaulo(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
  })
    .format(new Date())
    .slice(0, 7)
}

function shiftMonthKey(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split('-').map(Number)
  const absolute = y * 12 + (m - 1) + delta
  const ny = Math.floor(absolute / 12)
  const nm = (absolute % 12) + 1
  return `${ny}-${String(nm).padStart(2, '0')}`
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
  const [section, setSection] = useState<Section>('installments')
  const [loading, setLoading] = useState(false)
  const [focusMonth, setFocusMonth] = useState(currentMonthKeySaoPaulo)
  const [installments, setInstallments] =
    useState<InstallmentsOverviewResponse | null>(null)
  const [investments, setInvestments] =
    useState<InvestmentsOverviewResponse | null>(null)
  const failedMonthRef = useRef<string | null>(null)

  const loadInstallments = useCallback(
    async (month: string) => {
      setLoading(true)
      onError(null)
      try {
        const data = await apiFetch<InstallmentsOverviewResponse>(
          `/api/installments/overview?month=${encodeURIComponent(month)}`,
        )
        failedMonthRef.current = null
        setInstallments(data)
        setFocusMonth(data.focusMonth)
      } catch (err) {
        failedMonthRef.current = month
        onError(
          err instanceof Error ? err.message : 'Erro ao carregar parcelas',
        )
      } finally {
        setLoading(false)
      }
    },
    [apiFetch, onError],
  )

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

  const changeFocusMonth = useCallback((month: string) => {
    setFocusMonth((current) => {
      if (current === month) {
        return current
      }
      failedMonthRef.current = null
      return month
    })
  }, [])

  useEffect(() => {
    if (section !== 'installments') {
      if (!investments && !loading) {
        void loadInvestments()
      }
      return
    }
    if (loading) {
      return
    }
    if (installments?.focusMonth === focusMonth) {
      return
    }
    if (failedMonthRef.current === focusMonth) {
      return
    }
    void loadInstallments(focusMonth)
  }, [
    section,
    focusMonth,
    installments,
    investments,
    loading,
    loadInstallments,
    loadInvestments,
  ])

  const monthTitle = formatMonthTitle(focusMonth)

  return (
    <section className="dashboard reports">
      <div className="reports-shell">
        <header className="reports-header">
          <div className="reports-header-top">
            <h1>Relatórios</h1>
            <div className="reports-month" aria-label="Mês de referência">
              <button
                type="button"
                className="reports-month-arrow"
                disabled={loading}
                aria-label="Mês anterior"
                onClick={() =>
                  changeFocusMonth(shiftMonthKey(focusMonth, -1))
                }
              >
                ‹
              </button>
              <button
                type="button"
                className="reports-month-label"
                disabled={loading}
                title="Ir para o mês atual"
                onClick={() => changeFocusMonth(currentMonthKeySaoPaulo())}
              >
                {monthTitle}
              </button>
              <button
                type="button"
                className="reports-month-arrow"
                disabled={loading}
                aria-label="Próximo mês"
                onClick={() => changeFocusMonth(shiftMonthKey(focusMonth, 1))}
              >
                ›
              </button>
            </div>
            <button
              type="button"
              className="reports-refresh"
              disabled={loading}
              onClick={() => {
                if (section === 'installments') {
                  failedMonthRef.current = null
                  setInstallments(null)
                } else {
                  setInvestments(null)
                }
              }}
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
              onClick={() => setSection('installments')}
            >
              Parcelas
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={section === 'investments'}
              className={section === 'investments' ? 'active' : ''}
              onClick={() => setSection('investments')}
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
              loading={loading}
              onFocusMonthChange={changeFocusMonth}
            />
          ) : null}
          {section === 'investments' && investments ? (
            <InvestmentsPanel data={investments} />
          ) : null}
        </div>
      </div>
    </section>
  )
}
