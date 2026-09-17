import { CommandContextKeyProvider } from '@renderer/components/command/CommandContextKeyProvider'
import { CommandProvider } from '@renderer/components/command/CommandProvider'
import { MockUsePreferenceUtils } from '@test-mocks/renderer/usePreference'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ComposerFocusShortcut } from '../ComposerFocusShortcut'

const state = vi.hoisted(() => ({ active: true }))

vi.mock('@renderer/hooks/tab', () => ({ useIsActiveTab: () => state.active }))

function mount(editable = true, composerEmpty = true) {
  const view = render(
    <CommandContextKeyProvider>
      <CommandProvider>
        <textarea aria-label="Message" />
        <ComposerFocusShortcut
          focus={() => screen.getByRole('textbox', { name: 'Message' }).focus()}
          editable={editable}
          composerEmpty={composerEmpty}
        />
      </CommandProvider>
    </CommandContextKeyProvider>
  )
  return { container: view.container, input: screen.getByRole('textbox', { name: 'Message' }), user: userEvent.setup() }
}

describe('ComposerFocusShortcut', () => {
  beforeEach(() => {
    state.active = true
    MockUsePreferenceUtils.resetMocks()
  })
  afterEach(cleanup)

  it('focuses the active composer without rendering a reminder', async () => {
    const { container, input, user } = mount()
    expect(container).toHaveTextContent('')
    expect(screen.queryByText('Ctrl+I')).not.toBeInTheDocument()
    await user.keyboard('{Control>}i{/Control}')
    expect(input).toHaveFocus()
  })

  it('follows a customized binding without rendering a reminder', async () => {
    MockUsePreferenceUtils.setPreferenceValue('shortcut.chat.input.focus', {
      binding: ['CommandOrControl', 'L'],
      enabled: true
    })
    const { input, user } = mount()
    expect(screen.queryByText('Ctrl+L')).not.toBeInTheDocument()
    await user.keyboard('{Control>}i{/Control}')
    expect(input).not.toHaveFocus()
    await user.keyboard('{Control>}l{/Control}')
    expect(input).toHaveFocus()
  })

  it('does not activate a background tab', async () => {
    state.active = false
    const { input, user } = mount()
    await user.keyboard('{Control>}i{/Control}')
    expect(input).not.toHaveFocus()
  })

  it.each(['disabled', 'readonly'])('ignores the shortcut when %s', async (mode) => {
    if (mode === 'disabled') {
      MockUsePreferenceUtils.setPreferenceValue('shortcut.chat.input.focus', {
        binding: ['CommandOrControl', 'I'],
        enabled: false
      })
    }
    const { input, user } = mount(mode !== 'readonly')
    expect(screen.queryByText('Ctrl+I')).not.toBeInTheDocument()
    await user.keyboard('{Control>}i{/Control}')
    expect(input).not.toHaveFocus()
  })

  it('hides the hint once the composer holds text, so it cannot sit on top of the first line', () => {
    mount(true, false)

    expect(screen.queryByText('Ctrl+I')).not.toBeInTheDocument()
  })

  it('keeps the hint out of the editor flow so it cannot drag the editor scrollbar inward', () => {
    mount()

    // `absolute` is the whole point: a flow-level sibling steals width from the editor, which moves
    // the editor's own scrollbar away from the composer's right edge while the hint is visible.
    const hint = screen.getByText('Ctrl+I').parentElement
    expect(hint).not.toBeNull()
    expect(hint).toHaveClass('absolute')
    expect(hint).not.toHaveClass('flex-1')
  })
})
