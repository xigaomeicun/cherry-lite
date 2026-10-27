import { MockCacheUtils } from '@test-mocks/renderer/CacheService'
import { MockUsePreferenceUtils } from '@test-mocks/renderer/usePreference'
import { mockRendererLoggerService } from '@test-mocks/RendererLoggerService'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import LocalModelsSection from '../LocalModelsSection'

const mockRequest = vi.fn()

vi.unmock('@data/hooks/useCache')

vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: (...args: unknown[]) => mockRequest(...args) }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('@cherrystudio/ui', () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onClick,
    'aria-label': ariaLabel
  }: {
    children?: ReactNode
    onClick?: () => void
    'aria-label'?: string
  }) => (
    <button type="button" onClick={onClick} aria-label={ariaLabel}>
      {children}
    </button>
  ),
  DescriptionSwitch: ({
    checked,
    description,
    label,
    onCheckedChange
  }: {
    checked: boolean
    description?: string
    label: string
    onCheckedChange: (checked: boolean) => void
  }) => (
    <label>
      <span>{label}</span>
      {description && <span>{description}</span>}
      <input type="checkbox" checked={checked} onChange={(event) => onCheckedChange(event.target.checked)} />
    </label>
  )
}))

const EMBEDDING = 'qwen3-embedding-0.6b'
const OCR = 'pp-ocrv6-medium'

/** What the registry reports as installable; the cards are rendered from it. */
const LISTED_MODELS = {
  models: [
    { id: EMBEDDING, capability: 'embedding' },
    { id: OCR, capability: 'ocr' }
  ]
}

/** Answer `local_model.list` for every test, and layer the test's own routes over it. */
function mockRoutes(handler: (route: string, input?: { id: string }) => unknown): void {
  mockRequest.mockImplementation((route: string, input?: { id: string }) =>
    route === 'local_model.list' ? Promise.resolve(LISTED_MODELS) : Promise.resolve(handler(route, input))
  )
}

describe('LocalModelsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    MockCacheUtils.resetMocks()
    MockUsePreferenceUtils.resetMocks()
  })

  it('does not render the local embedding card when embedding cards are removed', async () => {
    mockRoutes(() => ({ supported: false }))
    render(<LocalModelsSection />)
    expect(screen.queryByRole('link', { name: 'onnx-community/Qwen3-Embedding-0.6B-ONNX' })).not.toBeInTheDocument()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByText('settings.dependencies.localModels.title')).toBeInTheDocument()
  })

  it('shows a supported acceleration switch and persists the user choice', async () => {
    const user = userEvent.setup()
    mockRoutes((route) => {
      if (route === 'local_model.get_acceleration_capability') return Promise.resolve({ supported: true })
      return Promise.resolve()
    })

    render(<LocalModelsSection />)

    const acceleration = await screen.findByRole('checkbox', {
      name: /settings\.dependencies\.localModels\.acceleration\.label/
    })
    expect(acceleration).not.toBeChecked()

    await user.click(acceleration)

    expect(MockUsePreferenceUtils.getPreferenceValue('feature.local_model.hardware_acceleration.enabled')).toBe(true)
  })

  it('hides the acceleration switch when the main process reports no supported provider', async () => {
    mockRoutes((route) => {
      if (route === 'local_model.get_acceleration_capability') return Promise.resolve({ supported: false })
      return Promise.resolve()
    })

    render(<LocalModelsSection />)

    await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('local_model.get_acceleration_capability'))
    expect(
      screen.queryByRole('checkbox', { name: /settings\.dependencies\.localModels\.acceleration\.label/ })
    ).not.toBeInTheDocument()
  })

  it('logs acceleration capability probe failures while keeping the switch hidden', async () => {
    const error = new Error('capability probe failed')
    const warnSpy = vi.spyOn(mockRendererLoggerService, 'warn').mockImplementation(() => {})
    mockRoutes((route) => {
      if (route === 'local_model.get_acceleration_capability') return Promise.reject(error)
      return Promise.resolve()
    })

    render(<LocalModelsSection />)

    await waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith('Failed to detect local inference hardware acceleration', error)
    )
    expect(
      screen.queryByRole('checkbox', { name: /settings\.dependencies\.localModels\.acceleration\.label/ })
    ).not.toBeInTheDocument()
  })
})
