import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppView } from './routes'

type Props = {
  view: AppView
  sessionEmail: string | null
  themeLabel: string
  themeIcon: string
  onCycleTheme: () => void
  onReconcile: () => void
  onBalances: () => void
  onDashboard: () => void
  onSettings: () => void
  onLogout: () => void
}

export function AppChrome({
  view,
  sessionEmail,
  themeLabel,
  themeIcon,
  onCycleTheme,
  onReconcile,
  onBalances,
  onDashboard,
  onSettings,
  onLogout,
}: Props) {
  const [open, setOpen] = useState(false)
  const navRef = useRef<HTMLDivElement | null>(null)
  const bodyOverflowRef = useRef<string | null>(null)

  const setOpenImmediate = useCallback((next: boolean) => {
    const root = navRef.current
    if (root) {
      root.classList.toggle('is-open', next)
      root.setAttribute('aria-hidden', next ? 'false' : 'true')
    }
    if (next) {
      if (bodyOverflowRef.current === null) {
        bodyOverflowRef.current = document.body.style.overflow
      }
      document.body.style.overflow = 'hidden'
    } else if (bodyOverflowRef.current !== null) {
      document.body.style.overflow = bodyOverflowRef.current
      bodyOverflowRef.current = null
    }
    setOpen(next)
  }, [])

  const close = useCallback(() => {
    setOpenImmediate(false)
  }, [setOpenImmediate])

  const go = useCallback(
    (action: () => void) => {
      setOpenImmediate(false)
      action()
    },
    [setOpenImmediate],
  )

  useEffect(() => {
    if (!open) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenImmediate(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, setOpenImmediate])

  useEffect(() => {
    setOpenImmediate(false)
  }, [view, setOpenImmediate])

  useEffect(() => {
    return () => {
      if (bodyOverflowRef.current !== null) {
        document.body.style.overflow = bodyOverflowRef.current
        bodyOverflowRef.current = null
      }
    }
  }, [])

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            o
          </div>
          <div className="brand-text">
            <strong>organizze</strong>
            <span>↔ pluggy · conciliação</span>
          </div>
        </div>
        <nav
          className="topbar-nav topbar-nav-desktop"
          aria-label="Navegação principal"
        >
          <button
            type="button"
            className={`btn ghost ${view === 'reconcile' ? 'active-nav' : ''}`}
            onClick={onReconcile}
          >
            <span className="nav-label-full">Conciliação</span>
            <span className="nav-label-short">Fila</span>
          </button>
          <button
            type="button"
            className={`btn ghost ${view === 'balances' ? 'active-nav' : ''}`}
            onClick={onBalances}
          >
            <span className="nav-label-full">Saldos</span>
            <span className="nav-label-short">Saldos</span>
          </button>
          <button
            type="button"
            className={`btn ghost ${view === 'dashboard' ? 'active-nav' : ''}`}
            onClick={onDashboard}
          >
            <span className="nav-label-full">Relatórios</span>
            <span className="nav-label-short">Relat.</span>
          </button>
          <button
            type="button"
            className={`btn ghost ${view === 'settings' ? 'active-nav' : ''}`}
            onClick={onSettings}
          >
            <span className="nav-label-full">Configurações</span>
            <span className="nav-label-short">Config</span>
          </button>
        </nav>
        <button
          type="button"
          className="btn ghost theme-toggle topbar-theme-desktop"
          onClick={onCycleTheme}
          title={`Tema: ${themeLabel}`}
          aria-label={`Alternar tema (atual: ${themeLabel})`}
        >
          <span className="theme-toggle-icon" aria-hidden>
            {themeIcon}
          </span>
          <span className="theme-toggle-label">{themeLabel}</span>
        </button>
        <button
          type="button"
          className="btn ghost topbar-logout topbar-logout-desktop"
          onClick={onLogout}
        >
          <span className="nav-logout-full">
            Sair{sessionEmail ? ` · ${sessionEmail.split('@')[0]}` : ''}
          </span>
          <span className="nav-logout-short">Sair</span>
        </button>
        <button
          type="button"
          className="btn ghost topbar-menu-btn"
          aria-label="Abrir menu"
          aria-expanded={open}
          aria-controls="mobile-nav-drawer"
          onClick={() => setOpenImmediate(true)}
        >
          <span className="topbar-menu-icon" aria-hidden />
        </button>
      </header>

      <div
        ref={navRef}
        className={`mobile-nav${open ? ' is-open' : ''}`}
        aria-hidden={!open}
      >
        <button
          type="button"
          className="mobile-nav-backdrop"
          aria-label="Fechar menu"
          tabIndex={open ? 0 : -1}
          onClick={close}
        />
        <aside
          id="mobile-nav-drawer"
          className="mobile-nav-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
        >
          <div className="mobile-nav-head">
            <strong>Menu</strong>
            <button
              type="button"
              className="btn ghost mobile-nav-close"
              aria-label="Fechar menu"
              onClick={close}
            >
              ✕
            </button>
          </div>
          <nav className="mobile-nav-links" aria-label="Navegação principal">
            <button
              type="button"
              className={`mobile-nav-link ${view === 'reconcile' ? 'is-active' : ''}`}
              onClick={() => go(onReconcile)}
            >
              Conciliação
            </button>
            <button
              type="button"
              className={`mobile-nav-link ${view === 'balances' ? 'is-active' : ''}`}
              onClick={() => go(onBalances)}
            >
              Saldos
            </button>
            <button
              type="button"
              className={`mobile-nav-link ${view === 'dashboard' ? 'is-active' : ''}`}
              onClick={() => go(onDashboard)}
            >
              Relatórios
            </button>
            <button
              type="button"
              className={`mobile-nav-link ${view === 'settings' ? 'is-active' : ''}`}
              onClick={() => go(onSettings)}
            >
              Configurações
            </button>
          </nav>
          <div className="mobile-nav-footer">
            <button
              type="button"
              className="btn ghost theme-toggle mobile-nav-theme"
              onClick={onCycleTheme}
              title={`Tema: ${themeLabel}`}
              aria-label={`Alternar tema (atual: ${themeLabel})`}
            >
              <span className="theme-toggle-icon" aria-hidden>
                {themeIcon}
              </span>
              <span>Tema: {themeLabel}</span>
            </button>
            <button
              type="button"
              className="btn ghost mobile-nav-logout"
              onClick={() => {
                close()
                onLogout()
              }}
            >
              Sair{sessionEmail ? ` · ${sessionEmail.split('@')[0]}` : ''}
            </button>
          </div>
        </aside>
      </div>
    </>
  )
}
