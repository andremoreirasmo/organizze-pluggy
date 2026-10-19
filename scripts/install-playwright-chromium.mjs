#!/usr/bin/env node
/**
 * Install Playwright Chromium into the default user cache
 * (%LOCALAPPDATA%/ms-playwright), ignoring any sandbox PLAYWRIGHT_BROWSERS_PATH.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env }
delete env.PLAYWRIGHT_BROWSERS_PATH

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['playwright', 'install', 'chromium'],
  { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' },
)

process.exit(result.status ?? 1)
