import { MockUsePreferenceUtils } from '@test-mocks/renderer/usePreference'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type PropsWithChildren, type ReactElement, useState } from 'react'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '@renderer/i18n/resolver'
import type {
  CherryCloudAccountPlans,
  CherryCloudAccountReceipt,
  CherryCloudStatus
} from '@shared/ipc/schemas/cherryCloud'

import { UserAccountPanel } from '../UserAccountPanel'

vi.unmock('@cherrystudio/ui')

const request = vi.mocked(window.api.ipcApi.request)
let session: Pick<CherryCloudStatus, 'phase' | 'accountId' | 'displayName'>
let plans: CherryCloudAccountPlans

let revision = 0
function receiptFor(status = session, value?: CherryCloudAccountPlans): CherryCloudAccountReceipt {
  const nextRevision = ++revision
  return {
    status: { ...status, scopeId: status.accountId ?? status.phase, revision: nextRevision },
    reason: 'initial',
    account: { freshness: 'unknown', error: null },
    models: { freshness: 'unknown', error: null },
    plans: value ? { freshness: 'fresh', value, observedRevision: nextRevision } : { freshness: 'unknown', error: null }
  }
}
function publishReceipt(receipt: CherryCloudAccountReceipt) {
  vi.mocked(window.api.ipcApi.on)
    .mock.calls.filter(([event]) => event === 'cherry_cloud.account_changed')
    .forEach(([, listener]) => listener(receipt))
}

let swrCache = new Map()

function SWRWrapper({ children }: PropsWithChildren) {
  return <SWRConfig value={{ provider: () => swrCache, dedupingInterval: 0 }}>{children}</SWRConfig>
}

function renderAccount(ui: ReactElement) {
  return render(ui, { wrapper: SWRWrapper })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(async () => {
  swrCache = new Map()
  vi.clearAllMocks()
  MockUsePreferenceUtils.resetMocks()
  MockUsePreferenceUtils.setPreferenceValue('app.user.name', '')
  vi.stubGlobal('__APP_EDITION__', 'global')
  vi.stubEnv('DEV', true)
  await i18n.changeLanguage('zh-CN')

  session = { phase: 'signed-in', accountId: 'account-1', displayName: 'c***@cherry-ai.com' }
  plans = { measured_at: '2026-09-23T00:00:00Z', entitlements: [], available_plans: [] }
  request.mockImplementation(async (route) => {
    if (route === 'cherry_cloud.status.get') return { ok: true, data: receiptFor().status }
    if (route === 'cherry_cloud.account.get') return { ok: true, data: receiptFor() }
    if (route === 'cherry_cloud.account_origin.get') return { ok: true, data: 'https://cloud-dev.cherryai.com' }
    if (route === 'cherry_cloud.account.refresh')
      return { ok: true, data: { outcome: 'refreshed', receipt: receiptFor(session, plans) } }
    if (route === 'cherry_cloud.account_portal.open') return { ok: true, data: { outcome: 'opened' } }
    if (route === 'cherry_cloud.login.start') {
      session = { phase: 'authorizing', accountId: null, displayName: null }
      publishReceipt(receiptFor())
      return new Promise(() => undefined)
    }
    return { ok: true, data: undefined }
  })
})

afterEach(() => vi.unstubAllEnvs())

describe('UserAccountPanel', () => {
  it('keeps the account entry label while loading and after signing out', async () => {
    const pendingStatus = deferred<{ ok: true; data: CherryCloudAccountReceipt }>()
    request.mockImplementation(() => pendingStatus.promise)
    renderAccount(<UserAccountPanel />)

    const header = screen.getByRole('button', { name: '用户名' })
    expect(within(header).getByText('个人信息')).toBeVisible()
    await act(async () =>
      pendingStatus.resolve({ ok: true, data: receiptFor({ phase: 'signed-out', accountId: null, displayName: null }) })
    )

    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument()
    expect(within(header).getByText('个人信息')).toBeVisible()
    expect(within(header).queryByText('Cherry Cloud')).not.toBeInTheDocument()
  })

  it('keeps account status errors separate from the account entry label', async () => {
    request.mockResolvedValue({ ok: false, error: { code: 'INTERNAL', message: 'failed' } })
    renderAccount(<UserAccountPanel />)

    await screen.findByRole('button', { name: '重试' })
    const header = screen.getByRole('button', { name: '用户名' })
    expect(within(header).getByText('个人信息')).toBeVisible()
    expect(within(header).getByRole('alert')).toBeVisible()
  })

  it('uses the account entry label when the signed-in account has no display name', async () => {
    session = { ...session, displayName: null }
    renderAccount(<UserAccountPanel />)

    expect(await screen.findByText('已登录')).toBeVisible()
    expect(within(screen.getByRole('button', { name: '用户名' })).getByText('个人信息')).toBeVisible()
  })

  it('prefers the local nickname and shows the cloud identity separately', async () => {
    MockUsePreferenceUtils.setPreferenceValue('app.user.name', 'Local nickname')
    renderAccount(<UserAccountPanel />)

    await screen.findByText(session.displayName!)
    const header = screen.getByRole('button', { name: '用户名' })
    expect(within(header).getByText('Local nickname')).toBeVisible()
    expect(within(header).getByText(session.displayName!)).toBeVisible()
  })

  it('places help below appearance and keeps settings as the last menu action', () => {
    renderAccount(
      <UserAccountPanel>
        <button type="button">帮助</button>
      </UserAccountPanel>
    )
    const appearance = screen.getByRole('button', { name: '外观' })
    const help = screen.getByRole('button', { name: '帮助' })
    const settings = screen.getByRole('button', { name: '设置' })

    expect(screen.getAllByRole('button').filter((button) => [appearance, help, settings].includes(button))).toEqual([
      appearance,
      help,
      settings
    ])
  })

  it('closes the entire account menu after selecting an appearance mode', async () => {
    function AccountMenu() {
      const [open, setOpen] = useState(true)
      return open ? (
        <UserAccountPanel onRequestClose={() => setOpen(false)} />
      ) : (
        <button type="button">Open account menu</button>
      )
    }
    const user = userEvent.setup()
    renderAccount(<AccountMenu />)

    await user.hover(screen.getByRole('button', { name: '外观' }))
    await user.click(await screen.findByRole('button', { name: '浅色', pressed: false }))

    expect(screen.getByRole('button', { name: 'Open account menu' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '用户名' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '外观' })).not.toBeInTheDocument()
  })

  it('shows the signed-in email without a name prompt in the global account menu', async () => {
    renderAccount(<UserAccountPanel />)

    expect(await screen.findByText('c***@cherry-ai.com')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '用户名' })).toHaveTextContent('c***@cherry-ai.com')
    expect(within(screen.getByRole('button', { name: '用户名' })).getByText('个人信息')).toBeVisible()
    expect(screen.getAllByText('c***@cherry-ai.com')).toHaveLength(1)
    expect(screen.queryByText('输入您的姓名')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '退出登录' })).not.toBeInTheDocument()
  })

  it('offers CN sign-in in production', async () => {
    vi.stubGlobal('__APP_EDITION__', 'cn')
    vi.stubEnv('DEV', false)
    session = { phase: 'signed-out', accountId: null, displayName: null }
    const user = userEvent.setup()
    renderAccount(<UserAccountPanel />)

    const login = await screen.findByRole('button', { name: '登录' })
    await waitFor(() => expect(login).toBeEnabled())
    await user.click(login)

    expect(await screen.findByRole('button', { name: '取消' })).toBeEnabled()
    expect(request).toHaveBeenCalledWith('cherry_cloud.login.start', undefined)
    expect(request.mock.calls.some(([route]) => route === 'cherry_cloud.account.refresh')).toBe(false)
  })

  it('restores CN sign-in after the account signs out', async () => {
    vi.stubGlobal('__APP_EDITION__', 'cn')
    renderAccount(<UserAccountPanel />)
    await screen.findByText(session.displayName!)
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument()
    const listener = vi
      .mocked(window.api.ipcApi.on)
      .mock.calls.find(([event]) => event === 'cherry_cloud.account_changed')![1]

    act(() => listener(receiptFor({ phase: 'signed-out', accountId: null, displayName: null })))

    expect(await screen.findByRole('button', { name: '登录' })).toBeEnabled()
  })
})
