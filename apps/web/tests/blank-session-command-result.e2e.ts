// Web e2e: slash commands typed into a blank Session show their result rows
// without a model turn, on both composer routes: an argument claim and a bare
// Enter. New Session, which reuses the same blank Session, presents it on its
// Hero again, and so does a reload with the same command-only history. The
// shipped composition runs with no model adapter, so an accidental turn fails
// loud.
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-commands/types'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria,
  compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/blank-session-command-result', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL(
  './expected/blank-session-command-result/ui.expected.md', import.meta.url,
))
const MODE = webSnapshotMode()
const HERO = 'Into the Unknown'
const RESULT = /Feedback recorded for session/
const BARE_RESULT = 'Session log download requested.'

describe('web e2e: command result in a blank Session', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const events: SessionEvent[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows the first command result in place of the Hero without a model turn', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-blank-session-command-result'))
    await expect.poll(() => page.getByText(HERO, { exact: false }).count(), { timeout: 15_000 }).toBe(1)
    const input = page.locator('[data-composer-input]').first()
    await input.fill('/feedback first command in a blank session')
    await input.press('Enter')

    await page.getByText(RESULT).waitFor({ timeout: 10_000 })
    await expect.poll(() => page.locator('[data-phase="active"]').count()).toBe(1)
    expect(await page.getByText(HERO, { exact: false }).count()).toBe(0)
    expect(events.filter(event => event.type === 'command/run' || event.type === 'command/done')
      .map(event => event.type)).toEqual(['command/run', 'command/done'])
    expect(events.some(event => event.type === 'turn/start')).toBe(false)
    expect(events.some(event => event.type === 'user/message')).toBe(false)

    await expect.poll(() => input.textContent(), { timeout: 10_000 }).toBe('')
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('presents the reused blank Session on its Hero again after New Session', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-blank-session-command-result-new-session'))
    const [blank] = scaffold.ctx.sessions.list()
    const newSession = page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' })
    await Promise.all([page.waitForResponse('**/api/session/create'), newSession.click()])

    await expect.poll(() => page.getByText(HERO, { exact: false }).count(), { timeout: 15_000 }).toBe(1)
    expect(await page.getByText(RESULT).count()).toBe(0)
    expect(await page.locator('[data-phase="active"]').count()).toBe(0)
    expect(scaffold.ctx.sessions.list()).toEqual([blank])
  }, 60_000)

  it('shows a bare command result typed into the reused blank Session', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-blank-session-command-result-bare'))
    const eventStart = events.length
    const input = page.locator('[data-composer-input]').first()
    await input.fill('/export')
    await input.press('Enter')

    await page.getByText(BARE_RESULT).waitFor({ timeout: 10_000 })
    await expect.poll(() => page.locator('[data-phase="active"]').count()).toBe(1)
    expect(await page.getByText(HERO, { exact: false }).count()).toBe(0)
    const later = events.slice(eventStart)
    expect(later.filter(event => event.type === 'command/run' || event.type === 'command/done')
      .map(event => event.type)).toEqual(['command/run', 'command/done'])
    expect(later.some(event => event.type === 'turn/start' || event.type === 'user/message')).toBe(false)
    await expect.poll(() => input.textContent(), { timeout: 10_000 }).toBe('')
  }, 60_000)

  it('reopens the Session on its Hero because command-only history is not activity', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-blank-session-command-result-reload'))
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)

    await expect.poll(() => page.getByText(HERO, { exact: false }).count(), { timeout: 15_000 }).toBe(1)
    expect(await page.getByText(RESULT).count()).toBe(0)
    expect(await page.getByText(BARE_RESULT).count()).toBe(0)
    expect(await page.locator('[data-phase="active"]').count()).toBe(0)

    const sessions = scaffold.ctx.sessions.list()
    expect(sessions).toHaveLength(1)
    const persisted = sessions[0]?.snapshotEvents() ?? []
    expect(persisted.filter(event => event.type === 'command/done')).toHaveLength(2)
    expect(persisted.some(event => event.type === 'turn/start')).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  }, 90_000)
})
