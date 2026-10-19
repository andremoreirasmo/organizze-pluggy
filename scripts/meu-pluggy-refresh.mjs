#!/usr/bin/env node
/**
 * Force-refresh Meu Pluggy connections by clicking "Atualizar" on meu.pluggy.ai.
 *
 * Local login (exports storageState for Cloud Run):
 *   npm run pluggy:refresh:login
 *   # then: gcloud storage cp .cache/meu-pluggy-storageState.json gs://BUCKET/meu-pluggy/storageState.json
 *
 * Local refresh with saved profile/state:
 *   npm run pluggy:refresh
 *
 * Cloud Run Job (headless + GCS or file state):
 *   MEU_PLUGGY_STORAGE_STATE_GCS=gs://bucket/meu-pluggy/storageState.json
 *   MEU_PLUGGY_STORAGE_STATE_PATH=/tmp/storageState.json
 *   MEU_PLUGGY_PROGRESS_GCS=gs://bucket/meu-pluggy/progress.json  (optional; derived from state URI)
 *
 * Env:
 *   MEU_PLUGGY_CONNECTION_IDS   optional comma-separated UUIDs
 *   MEU_PLUGGY_PROFILE_DIR      local persistent profile (default .cache/meu-pluggy-browser)
 *   MEU_PLUGGY_STORAGE_STATE_OUT  where to write state after login
 *   MEU_PLUGGY_PROGRESS_PATH    local progress JSON (default .cache/meu-pluggy-progress.json)
 *   MEU_PLUGGY_LOGIN_TIMEOUT_MS
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const BASE = 'https://meu.pluggy.ai'
const CONNECTIONS_URL = `${BASE}/connections/`
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

const headed =
  process.argv.includes('--headed') || process.env.MEU_PLUGGY_HEADED === '1'
const exportOnly = process.argv.includes('--export-state-only')
const profileDir = path.resolve(
  process.env.MEU_PLUGGY_PROFILE_DIR ||
    path.join(ROOT, '.cache', 'meu-pluggy-browser'),
)
const storageStateOut = path.resolve(
  process.env.MEU_PLUGGY_STORAGE_STATE_OUT ||
    path.join(ROOT, '.cache', 'meu-pluggy-storageState.json'),
)
const progressPath = path.resolve(
  process.env.MEU_PLUGGY_PROGRESS_PATH ||
    path.join(ROOT, '.cache', 'meu-pluggy-progress.json'),
)
const loginTimeoutMs = Number(
  process.env.MEU_PLUGGY_LOGIN_TIMEOUT_MS || 300_000,
)

/** @type {{ Storage?: typeof import('@google-cloud/storage').Storage }} */
let storageModule = null

function parseIdsFromEnv() {
  const raw = process.env.MEU_PLUGGY_CONNECTION_IDS?.trim()
  if (!raw) {
    return []
  }
  return raw
    .split(/[\s,;]+/)
    .map((id) => id.trim())
    .filter((id) => UUID_RE.test(id))
}

function log(message) {
  console.log(`[meu-pluggy-refresh] ${message}`)
}

function parseGcsUri(uri) {
  const match = uri.match(/^gs:\/\/([^/]+)\/(.+)$/)
  if (!match) {
    throw new Error(`Invalid GCS URI: ${uri}`)
  }
  return { bucket: match[1], object: match[2] }
}

function resolveProgressGcsUri() {
  const explicit = process.env.MEU_PLUGGY_PROGRESS_GCS?.trim()
  if (explicit) {
    return explicit
  }
  const stateUri = process.env.MEU_PLUGGY_STORAGE_STATE_GCS?.trim()
  if (!stateUri) {
    return null
  }
  return stateUri.replace(/[^/]+$/, 'progress.json')
}

async function getStorage() {
  if (!storageModule) {
    storageModule = await import('@google-cloud/storage')
  }
  return new storageModule.Storage()
}

/**
 * @typedef {{
 *   runId: string | null
 *   status: 'idle' | 'running' | 'succeeded' | 'failed'
 *   startedAt: string | null
 *   updatedAt: string
 *   finishedAt: string | null
 *   total: number
 *   completed: number
 *   currentIndex: number
 *   currentId: string | null
 *   currentLabel: string | null
 *   stepPercent: number | null
 *   percent: number
 *   message: string
 *   results: Array<{ id: string, label: string | null, ok: boolean, note: string }>
 * }} ProgressState
 */

const runId =
  process.env.MEU_PLUGGY_RUN_ID?.trim() ||
  `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** @type {ProgressState} */
let progressState = {
  runId,
  status: 'idle',
  startedAt: null,
  updatedAt: new Date().toISOString(),
  finishedAt: null,
  total: 0,
  completed: 0,
  currentIndex: 0,
  currentId: null,
  currentLabel: null,
  stepPercent: null,
  percent: 0,
  message: '',
  results: [],
}

function computePercent(completed, total, stepPercent) {
  if (total <= 0) {
    return 0
  }
  const step = Math.min(100, Math.max(0, stepPercent ?? 0)) / 100
  const raw = ((completed + step) / total) * 100
  return Math.min(100, Math.round(raw))
}

async function writeProgress(patch) {
  progressState = {
    ...progressState,
    ...patch,
    runId,
    updatedAt: new Date().toISOString(),
  }
  progressState.percent = computePercent(
    progressState.completed,
    progressState.total,
    progressState.stepPercent,
  )

  mkdirSync(path.dirname(progressPath), { recursive: true })
  const json = JSON.stringify(progressState, null, 2)
  writeFileSync(progressPath, json, 'utf8')

  const gcsUri = resolveProgressGcsUri()
  if (gcsUri) {
    try {
      const { bucket, object } = parseGcsUri(gcsUri)
      const storage = await getStorage()
      await storage.bucket(bucket).file(object).save(json, {
        contentType: 'application/json',
        resumable: false,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`Aviso: falha ao gravar progress no GCS — ${message}`)
    }
  }
}

async function resolveStorageStatePath() {
  const localPath = process.env.MEU_PLUGGY_STORAGE_STATE_PATH?.trim()
  if (localPath && existsSync(localPath)) {
    return localPath
  }

  const gcsUri = process.env.MEU_PLUGGY_STORAGE_STATE_GCS?.trim()
  if (!gcsUri) {
    if (existsSync(storageStateOut)) {
      return storageStateOut
    }
    return null
  }

  const { bucket, object } = parseGcsUri(gcsUri)
  const dest = localPath || '/tmp/meu-pluggy-storageState.json'
  log(`Baixando storageState de gs://${bucket}/${object}`)
  const storage = await getStorage()
  await storage.bucket(bucket).file(object).download({ destination: dest })
  return dest
}

async function waitUntilLoggedIn(page) {
  const deadline = Date.now() + loginTimeoutMs
  while (Date.now() < deadline) {
    const url = page.url()
    if (url.includes('/connections') || url.includes(BASE)) {
      const needsAuth =
        (await page
          .getByRole('button', { name: /google|continuar com google|sign in/i })
          .count()) > 0
      const onGoogle = /accounts\.google\.com/i.test(url)
      if (!needsAuth && !onGoogle && url.includes('/connections')) {
        return
      }
    }
    await page.waitForTimeout(1500)
  }
  throw new Error(
    `Login não concluído em ${loginTimeoutMs}ms. Rode com --headed e complete o Google SSO.`,
  )
}

async function discoverConnectionIds(page) {
  await page.goto(CONNECTIONS_URL, { waitUntil: 'domcontentloaded' })
  await page.goto(CONNECTIONS_URL, { waitUntil: 'networkidle' }).catch(() =>
    page.goto(CONNECTIONS_URL, { waitUntil: 'domcontentloaded' }),
  )

  const hrefs = await page.$$eval('a[href*="/connections/"]', (anchors) =>
    anchors.map((a) => a.getAttribute('href') || ''),
  )
  const ids = new Set()
  for (const href of hrefs) {
    const match = href.match(
      /\/connections\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    )
    if (match?.[1]) {
      ids.add(match[1].toLowerCase())
    }
  }
  return [...ids]
}

async function dismissCookieBanner(page) {
  const accept = page.getByRole('link', { name: /^\s*aceitar\s*$/i }).or(
    page.getByRole('button', { name: /^\s*aceitar\s*$/i }),
  )
  if ((await accept.count()) > 0) {
    await accept
      .first()
      .click({ timeout: 2000 })
      .catch(() => undefined)
    await page.waitForTimeout(300)
  }
}

async function findUpdateButton(page, timeoutMs = 20_000) {
  const candidates = [
    page.getByRole('button', { name: /^\s*atualizar\s*$/i }),
    page.getByRole('button', { name: /atualizar/i }),
    page.locator('button:has-text("Atualizar")'),
    page.locator('[role="button"]:has-text("Atualizar")'),
  ]
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const loc of candidates) {
      const first = loc.first()
      if (
        (await first.count()) > 0 &&
        (await first.isVisible().catch(() => false))
      ) {
        return first
      }
    }
    await page.waitForTimeout(400)
  }
  return null
}

async function readConnectionLabel(page) {
  const fromHeading = await page
    .locator('h1, h2')
    .first()
    .innerText()
    .catch(() => '')
  if (fromHeading?.trim()) {
    return fromHeading.trim().split('\n')[0].trim()
  }
  const title = await page.title().catch(() => '')
  const cleaned = title.replace(/\s*[—–|-]\s*Meu Pluggy.*$/i, '').trim()
  return cleaned || null
}

/**
 * @param {import('playwright').Page} page
 * @param {import('playwright').BrowserContext} context
 * @param {string} connectionId
 */
async function scrapeWidgetProgress(page, context, connectionId) {
  /** @type {{ stepPercent: number | null, message: string | null }} */
  let best = { stepPercent: null, message: null }

  const pages = [page, ...context.pages().filter((p) => p !== page)]
  for (const target of pages) {
    if (target.isClosed()) {
      continue
    }
    for (const frame of target.frames()) {
      const url = frame.url()
      if (!/connect\.pluggy\.ai|api\.pluggy\.ai|meu\.pluggy\.ai/i.test(url)) {
        continue
      }
      const snap = await frame
        .evaluate(() => {
          const text = (document.body?.innerText || '').replace(/\s+/g, ' ')
          const matches = [...text.matchAll(/(\d{1,3})\s*%/g)].map((m) =>
            Number(m[1]),
          )
          const pct =
            matches.length > 0 ? Math.max(...matches.filter((n) => n <= 100)) : null
          const line =
            text
              .split(/\n|(?<=[.!?])\s+/)
              .map((l) => l.trim())
              .find(
                (l) =>
                  l.length > 8 &&
                  l.length < 180 &&
                  /atualiz|sincron|colet|baixando|loading|connecting|dados (da|do|de)/i.test(
                    l,
                  ) &&
                  !/overview|fluxo|ativos|conexões|cookies|política/i.test(l),
              ) || null
          return { pct, line: line?.slice(0, 160) || null, text: text.slice(0, 240) }
        })
        .catch(() => null)
      if (!snap) {
        continue
      }
      if (snap.pct != null && (best.stepPercent == null || snap.pct > best.stepPercent)) {
        best.stepPercent = snap.pct
      }
      if (snap.line) {
        best.message = snap.line
      }
    }
  }

  // Last item poll from network is attached on page; also try DOM title crumbs.
  void connectionId
  return best
}

/**
 * @param {import('playwright').Page} page
 * @param {string} connectionId
 */
function attachItemProgressListener(page, connectionId) {
  /** @type {{ stepPercent: number | null, message: string | null, executionStatus: string | null }} */
  const state = {
    stepPercent: null,
    message: null,
    executionStatus: null,
  }

  const onResponse = async (response) => {
    const url = response.url()
    if (
      !url.includes(`/items/${connectionId}`) ||
      response.request().method() !== 'GET'
    ) {
      return
    }
    const ct = response.headers()['content-type'] || ''
    if (!ct.includes('json')) {
      return
    }
    try {
      const item = await response.json()
      if (!item || typeof item !== 'object') {
        return
      }
      const executionStatus =
        typeof item.executionStatus === 'string' ? item.executionStatus : null
      state.executionStatus = executionStatus

      const detail = item.statusDetail
      let pct = null
      if (detail && typeof detail === 'object') {
        const values = Object.values(detail)
        const nums = values
          .map((v) => {
            if (v && typeof v === 'object' && 'progress' in v) {
              return Number(v.progress)
            }
            return NaN
          })
          .filter((n) => Number.isFinite(n))
        if (nums.length > 0) {
          pct = Math.round(
            nums.reduce((a, b) => a + b, 0) / nums.length,
          )
        }
      }
      if (
        pct == null &&
        typeof item.parameter === 'object' &&
        item.parameter &&
        'progress' in item.parameter
      ) {
        pct = Number(item.parameter.progress)
      }
      if (Number.isFinite(pct)) {
        state.stepPercent = Math.min(100, Math.max(0, pct))
      }
      if (
        executionStatus &&
        !/SUCCESS|PARTIAL_SUCCESS|DONE|UPDATED|FINISHED/i.test(executionStatus)
      ) {
        state.message = executionStatus.replace(/_/g, ' ')
      }
    } catch {
      // ignore parse errors
    }
  }

  page.on('response', onResponse)
  return {
    get: () => state,
    dispose: () => page.off('response', onResponse),
  }
}

async function isUpdateIdle(page) {
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
    const update = buttons.find((el) =>
      /atualizar/i.test(el.textContent || ''),
    )
    if (!update) {
      return false
    }
    const text = (update.textContent || '').trim()
    const disabled =
      update.disabled ||
      update.getAttribute('aria-disabled') === 'true' ||
      update.classList.contains('disabled')
    return (
      /^atualizar$/i.test(text) &&
      !/atualizando|updating/i.test(text) &&
      !disabled
    )
  })
}

/**
 * @param {import('playwright').Page} page
 * @param {import('playwright').BrowserContext} context
 * @param {string} connectionId
 * @param {string | null} label
 * @param {number} index
 * @param {number} total
 */
async function refreshConnection(page, context, connectionId, label, index, total) {
  const url = `${BASE}/connections/${connectionId}`
  log(`Abrindo ${url}`)
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.goto(url, { waitUntil: 'networkidle' }).catch(() => undefined)
  await dismissCookieBanner(page)

  if (/login|sign-in|accounts\.google/i.test(page.url())) {
    throw new Error(
      'Sessão expirada — rode pluggy:refresh:login e reenvie o storageState ao GCS.',
    )
  }

  const pageLabel = (await readConnectionLabel(page)) || label
  await writeProgress({
    status: 'running',
    currentIndex: index,
    currentId: connectionId,
    currentLabel: pageLabel,
    stepPercent: 0,
    message: `Abrindo ${pageLabel || connectionId}…`,
  })

  const button = await findUpdateButton(page)
  if (!button) {
    throw new Error(
      `Botão "Atualizar" não encontrado em ${connectionId}. A UI do Meu Pluggy pode ter mudado.`,
    )
  }

  const listener = attachItemProgressListener(page, connectionId)
  const popupPromise = context
    .waitForEvent('page', { timeout: 8_000 })
    .catch(() => null)

  const btnLabel = ((await button.innerText().catch(() => '')) || '').trim()
  if (/atualizando|updating|sincroniz/i.test(btnLabel)) {
    log(`${connectionId}: já em atualização — aguardando…`)
  } else {
    log(`${connectionId}: clicando Atualizar`)
    await writeProgress({
      message: `Atualizando ${pageLabel || connectionId}…`,
      stepPercent: 5,
    })
    await button.click()
  }

  const popup = await popupPromise
  if (popup) {
    log(`${connectionId}: widget Connect aberto`)
    await popup.waitForLoadState('domcontentloaded').catch(() => undefined)
  }

  const deadline = Date.now() + 180_000
  let settled = false
  let lastStep = -1
  while (Date.now() < deadline) {
    const fromApi = listener.get()
    const fromUi = await scrapeWidgetProgress(page, context, connectionId)
    const observed = [fromApi.stepPercent, fromUi.stepPercent].filter(
      (n) => typeof n === 'number' && Number.isFinite(n),
    )
    const message =
      fromUi.message ||
      fromApi.message ||
      `Sincronizando ${pageLabel || connectionId}…`

    const nextStep =
      observed.length > 0
        ? Math.max(...observed)
        : Math.min(90, Math.max(10, lastStep < 0 ? 10 : lastStep + 2))

    if (nextStep !== lastStep) {
      lastStep = nextStep
      await writeProgress({
        stepPercent: nextStep,
        message,
        currentLabel: pageLabel,
      })
      log(`${connectionId}: ${nextStep}% — ${message}`)
    }

    const popupClosed = popup ? popup.isClosed() : true
    const idle = await isUpdateIdle(page).catch(() => false)
    const doneStatus =
      fromApi.executionStatus &&
      /SUCCESS|PARTIAL_SUCCESS|DONE|UPDATED|FINISHED/i.test(
        fromApi.executionStatus,
      )

    if ((idle && Date.now() > deadline - 180_000 + 2_500) || doneStatus) {
      if (popup && !popupClosed) {
        // give widget a moment; don't force-close
      }
      settled = true
      break
    }

    // If widget opened and closed and button idle
    if (popup && popupClosed && idle) {
      settled = true
      break
    }

    await page.waitForTimeout(700)
  }

  listener.dispose()

  if (!settled) {
    log(
      `${connectionId}: timeout aguardando fim do sync (pode ter concluído mesmo assim)`,
    )
    return {
      id: connectionId,
      label: pageLabel,
      ok: false,
      note: 'timeout',
    }
  }

  await writeProgress({
    stepPercent: 100,
    message: `${pageLabel || connectionId} atualizado`,
  })
  log(`${connectionId}: ok`)
  return { id: connectionId, label: pageLabel, ok: true, note: 'ok' }
}

async function exportStorageState(context) {
  mkdirSync(path.dirname(storageStateOut), { recursive: true })
  const state = await context.storageState()
  writeFileSync(storageStateOut, JSON.stringify(state, null, 2), 'utf8')
  log(`storageState salvo em ${storageStateOut}`)
  log(
    'Envie ao GCS, ex.: gcloud storage cp .cache/meu-pluggy-storageState.json gs://BUCKET/meu-pluggy/storageState.json',
  )
}

async function launchBrowser() {
  const statePath = await resolveStorageStatePath()
  const usePersistent = headed && !statePath

  if (usePersistent || (headed && !process.env.MEU_PLUGGY_STORAGE_STATE_GCS)) {
    mkdirSync(profileDir, { recursive: true })
    log(`Perfil persistente: ${profileDir}`)
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: !headed,
      viewport: { width: 1280, height: 900 },
      locale: 'pt-BR',
      args: ['--disable-blink-features=AutomationControlled'],
      ...(statePath && existsSync(statePath)
        ? { storageState: statePath }
        : {}),
    })
    const page = context.pages()[0] || (await context.newPage())
    return { browser: null, context, page, mode: 'persistent' }
  }

  if (!statePath || !existsSync(statePath)) {
    throw new Error(
      'storageState ausente. Defina MEU_PLUGGY_STORAGE_STATE_GCS ou rode npm run pluggy:refresh:login',
    )
  }

  log(`Usando storageState: ${statePath}`)
  const browser = await chromium.launch({
    headless: !headed,
    args: ['--disable-blink-features=AutomationControlled'],
  })
  const context = await browser.newContext({
    storageState: statePath,
    viewport: { width: 1280, height: 900 },
    locale: 'pt-BR',
  })
  const page = await context.newPage()
  return { browser, context, page, mode: 'storageState' }
}

async function main() {
  log(headed ? 'Modo headed' : 'Modo headless')
  log(`runId=${runId}`)
  await writeProgress({
    runId,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total: 0,
    completed: 0,
    currentIndex: 0,
    currentId: null,
    currentLabel: null,
    stepPercent: 0,
    message: 'Iniciando…',
    results: [],
  })

  const { browser, context, page, mode } = await launchBrowser()

  try {
    if (headed) {
      await page.goto(CONNECTIONS_URL, { waitUntil: 'domcontentloaded' })
      log(
        'Complete o login Google na janela (até aparecer a lista de conexões)…',
      )
      await waitUntilLoggedIn(page)
      await exportStorageState(context)
      if (exportOnly) {
        log('Export concluído (--export-state-only)')
        await writeProgress({
          status: 'succeeded',
          message: 'Login exportado',
          percent: 100,
          finishedAt: new Date().toISOString(),
        })
        return
      }
    }

    let ids = parseIdsFromEnv()
    if (ids.length === 0) {
      log('Descobrindo conexões em /connections')
      ids = await discoverConnectionIds(page)
    }

    if (ids.length === 0) {
      throw new Error(
        'Nenhuma conexão encontrada. Defina MEU_PLUGGY_CONNECTION_IDS ou confira o login.',
      )
    }

    log(`Conexões: ${ids.join(', ')}`)
    await writeProgress({
      total: ids.length,
      message: `${ids.length} conexão(ões) para atualizar`,
    })

    const results = []
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      try {
        const result = await refreshConnection(
          page,
          context,
          id,
          null,
          i + 1,
          ids.length,
        )
        results.push(result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`${id}: ERRO — ${message}`)
        results.push({ id, label: null, ok: false, note: message })
      }

      await writeProgress({
        completed: results.length,
        stepPercent: 0,
        results: results.map((r) => ({
          id: r.id,
          label: r.label,
          ok: r.ok,
          note: r.note,
        })),
        message:
          results.length < ids.length
            ? `Concluídas ${results.length}/${ids.length}`
            : 'Finalizando…',
      })
    }

    if (mode === 'persistent' && headed) {
      await exportStorageState(context)
    }

    const failed = results.filter((r) => !r.ok)
    log(
      `Fim: ${results.length - failed.length}/${results.length} ok` +
        (failed.length
          ? ` · falhas: ${failed.map((f) => f.id).join(', ')}`
          : ''),
    )
    await writeProgress({
      status: failed.length > 0 ? 'failed' : 'succeeded',
      completed: results.length,
      stepPercent: 100,
      percent: 100,
      currentId: null,
      currentLabel: null,
      message:
        failed.length > 0
          ? `${results.length - failed.length}/${results.length} ok`
          : 'Todas as conexões atualizadas',
      finishedAt: new Date().toISOString(),
      results: results.map((r) => ({
        id: r.id,
        label: r.label,
        ok: r.ok,
        note: r.note,
      })),
    })
    if (failed.length > 0) {
      process.exitCode = 1
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await writeProgress({
      status: 'failed',
      message,
      finishedAt: new Date().toISOString(),
    })
    throw error
  } finally {
    await context.close()
    if (browser) {
      await browser.close()
    }
  }
}

main().catch((error) => {
  console.error(
    `[meu-pluggy-refresh] ${error instanceof Error ? error.message : error}`,
  )
  process.exitCode = 1
})
