// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createSidebarShortcutId, type SidebarShortcutItem } from '@shared/data/preference/preferenceTypes'

import { createSidebarShortcutTarget } from '../../../utils/sidebar'
import type * as SidebarConstantsModule from '../../Sidebar/constants'
import type * as SidebarFooterModule from '../../Sidebar/SidebarFooter'

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  registryResolve: vi.fn(),
  remove: vi.fn(),
  reorder: vi.fn(),
  resolutions: [] as any[],
  sidebarWidth: 170,
  shortcuts: [] as any[],
  openSettingsTab: vi.fn()
}))

vi.unmock('@cherrystudio/ui')

vi.mock('@data/hooks/useCache', () => ({
  usePersistCache: () => [mocks.sidebarWidth, vi.fn()]
}))
vi.mock('@renderer/services/mainWindowNavigation', () => ({ openSettingsTab: mocks.openSettingsTab }))
vi.mock('@renderer/hooks/useSidebarShortcuts', () => ({
  useSidebarShortcuts: () => ({ shortcuts: mocks.shortcuts, remove: mocks.remove, reorder: mocks.reorder })
}))
vi.mock('../sidebarShortcuts', () => ({
  useSidebarNavigationSnapshot: () => ({ url: '/' }),
  useResolvedSidebarShortcuts: () => mocks.resolutions,
  useSidebarShortcutActivation: () => mocks.activate,
  useSidebarShortcutRegistry: () => ({ resolve: mocks.registryResolve })
}))

vi.mock('../../Sidebar', async () => {
  const constants = await vi.importActual<typeof SidebarConstantsModule>('../../Sidebar/constants')
  const { SidebarFooter } = await vi.importActual<typeof SidebarFooterModule>('../../Sidebar/SidebarFooter')

  return {
    getSidebarDisplayWidth: constants.getSidebarDisplayWidth,
    getSidebarLayout: constants.getSidebarLayout,
    normalizeSidebarWidth: constants.normalizeSidebarWidth,
    Sidebar: ({
      width = 170,
      entries,
      isFloating = false,
      onEntriesReorder,
      onHoverChange,
      actions,
      renderUserTrigger,
      user,
      userAction
    }: {
      width?: number
      entries: Array<{
        key: string
        label: string
        disabled?: boolean
        onOpen: () => void
        contextMenuItems: Array<{ id: string; label: string; enabled?: boolean; onSelect: () => void }>
      }>
      isFloating?: boolean
      onEntriesReorder: (event: { oldIndex: number; newIndex: number }) => void
      onHoverChange?: (visible: boolean) => void
      actions?: ReactNode | ((layout: 'full' | 'icon', onOverlayOpenChange?: (open: boolean) => void) => ReactNode)
      renderUserTrigger?: (trigger: ReactElement) => ReactElement
      user?: { name: string; avatar?: string; indicator?: ReactNode; onClick?: () => void }
      userAction?: ReactNode | ((layout: 'full' | 'icon', onOverlayOpenChange?: (open: boolean) => void) => ReactNode)
    }) => {
      const shellLayout = constants.getSidebarLayout(width)
      // The real dock passes its visible band through. A hidden dock's flyout is a full sheet.
      const footerLayout = !isFloating && shellLayout === 'icon' ? 'icon' : 'full'

      return (
        <div
          data-testid={isFloating ? 'floating-sidebar' : 'docked-sidebar'}
          onMouseEnter={() => onHoverChange?.(true)}>
          <div data-testid="sidebar-footer-user">
            <SidebarFooter
              layout={footerLayout}
              actions={actions}
              user={user}
              userAction={userAction}
              renderUserTrigger={renderUserTrigger}
            />
          </div>
          <ol aria-label="shortcuts">
            {entries.map((entry) => (
              <li key={entry.key} aria-label={entry.label}>
                <button
                  type="button"
                  aria-disabled={entry.disabled || undefined}
                  onClick={() => !entry.disabled && entry.onOpen()}>
                  {entry.label}
                </button>
                {entry.contextMenuItems.map((item) => (
                  <button key={item.id} type="button" disabled={item.enabled === false} onClick={item.onSelect}>
                    {item.label}
                  </button>
                ))}
              </li>
            ))}
          </ol>
          <button type="button" onClick={() => onEntriesReorder({ oldIndex: 0, newIndex: 1 })}>
            reorder
          </button>
        </div>
      )
    }
  }
})
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

import Sidebar from '../Sidebar'

function shortcut(providerId: string, resourceId: string, fallbackLabel?: string): SidebarShortcutItem {
  const target = createSidebarShortcutTarget(providerId, resourceId)
  return { type: 'shortcut', id: createSidebarShortcutId(target), target, fallbackLabel }
}

function renderedShortcutLabels(): Array<string | null> {
  return within(screen.getByRole('list', { name: 'shortcuts' }))
    .getAllByRole('listitem')
    .map((item) => item.getAttribute('aria-label'))
}

describe('app Sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.shortcuts = []
    mocks.resolutions = []
    mocks.sidebarWidth = 170
    mocks.registryResolve.mockReturnValue({ activate: mocks.activate })
    mocks.reorder.mockResolvedValue(undefined)
  })

  it.each([
    { isFullscreen: false, width: 170 },
    { isFullscreen: false, width: 50 },
    { isFullscreen: false, width: 0 },
    { isFullscreen: true, width: 170 },
    { isFullscreen: true, width: 50 },
    { isFullscreen: true, width: 0 }
  ])(
    'shows only the settings button in the sidebar footer when fullscreen=$isFullscreen at sidebar width $width',
    async ({ isFullscreen, width }) => {
      mocks.sidebarWidth = width
      const user = userEvent.setup()
      render(<Sidebar isFullscreen={isFullscreen} />)
      if (width === 0) fireEvent.mouseEnter(screen.getByTestId('docked-sidebar'))
      const sidebar = screen.getByTestId(width === 0 ? 'floating-sidebar' : 'docked-sidebar')
      const footer = within(sidebar).getByTestId('sidebar-footer-user')
      const settings = within(footer).getByRole('button', { name: 'settings.title' })

      expect(settings).toBeVisible()
      expect(within(footer).getAllByRole('button')).toEqual([settings])
      expect(screen.queryByLabelText('sidebar.account_menu')).not.toBeInTheDocument()

      await user.click(settings)
      expect(mocks.openSettingsTab).toHaveBeenCalledWith()
    }
  )

  it('clears a previous hover reveal when hiding the sidebar again', () => {
    mocks.sidebarWidth = 0
    const view = render(<Sidebar />)
    fireEvent.mouseEnter(screen.getByTestId('docked-sidebar'))
    expect(screen.getByTestId('floating-sidebar')).toBeVisible()

    mocks.sidebarWidth = 200
    view.rerender(<Sidebar />)
    mocks.sidebarWidth = 0
    view.rerender(<Sidebar />)

    expect(screen.queryByTestId('floating-sidebar')).not.toBeInTheDocument()
    fireEvent.mouseEnter(screen.getByTestId('docked-sidebar'))
    expect(screen.getByTestId('floating-sidebar')).toBeVisible()
  })

  it('keeps a missing resource in place, disables activation, and allows removal', () => {
    const missing = shortcut('core.knowledge-base', 'missing', 'Lost Knowledge Base')
    mocks.shortcuts = [missing]
    mocks.resolutions = [{ status: 'missing', shortcut: missing }]

    render(<Sidebar />)

    expect(screen.getByRole('button', { name: 'Lost Knowledge Base' })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Lost Knowledge Base' }))
    expect(mocks.activate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'launchpad.unpin_from_sidebar' }))
    expect(mocks.remove).toHaveBeenCalledWith(missing.target)
  })

  it('keeps the dropped order visible until the preference write confirms it', async () => {
    const first = shortcut('core.knowledge-base', 'one', 'One')
    const second = shortcut('core.topic', 'two', 'Two')
    const firstResolution = { status: 'missing', shortcut: first }
    const secondResolution = { status: 'unavailable', shortcut: second }
    let finishReorder: () => void = vi.fn()
    mocks.reorder.mockReturnValue(
      new Promise<void>((resolve) => {
        finishReorder = resolve
      })
    )
    mocks.shortcuts = [first, second]
    mocks.resolutions = [firstResolution, secondResolution]

    const { rerender } = render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: 'reorder' }))

    expect(renderedShortcutLabels()).toEqual(['Two', 'One'])
    expect(mocks.reorder).toHaveBeenCalledWith([second, first])

    mocks.shortcuts = [second, first]
    mocks.resolutions = [secondResolution, firstResolution]
    rerender(<Sidebar />)
    act(() => finishReorder())

    await waitFor(() => expect(renderedShortcutLabels()).toEqual(['Two', 'One']))
  })

  it('restores the persisted order when a drag write fails', async () => {
    const first = shortcut('core.knowledge-base', 'one', 'One')
    const second = shortcut('core.topic', 'two', 'Two')
    mocks.reorder.mockRejectedValue(new Error('write failed'))
    mocks.shortcuts = [first, second]
    mocks.resolutions = [
      { status: 'missing', shortcut: first },
      { status: 'unavailable', shortcut: second }
    ]

    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: 'reorder' }))

    expect(renderedShortcutLabels()).toEqual(['Two', 'One'])
    await waitFor(() => expect(renderedShortcutLabels()).toEqual(['One', 'Two']))
  })
})
