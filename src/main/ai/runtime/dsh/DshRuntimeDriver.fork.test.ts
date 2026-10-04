import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentRuntimeConnectInput } from '../types'

const mocks = vi.hoisted(() => ({
  flushForFork: vi.fn(async () => undefined),
  snapshotForFork: vi.fn(async () => [{ seq: 0 }, { seq: 1 }] as unknown[]),
  forkDshSession: vi.fn(async () => ({ resumeToken: 'child', checkpoints: [], publish: [] }))
}))

vi.mock('@data/services/AgentService', () => ({ agentService: {} }))
vi.mock('@data/services/McpServerService', () => ({ mcpServerService: { findByIdOrName: vi.fn() } }))
vi.mock('@application', () => ({
  application: {
    get: () => {
      throw new Error('unexpected service')
    },
    getPath: () => '/unused'
  }
}))
vi.mock('@main/ai/runtime/agentSessionWorkspace', () => ({
  prepareAgentSessionWorkspaceDirectory: vi.fn()
}))
vi.mock('./modelInjection', () => ({ assertDshProviderUsable: vi.fn() }))
vi.mock('./dshFork', () => ({ forkDshSession: mocks.forkDshSession }))
vi.mock('./DshRuntimeConnection', () => ({
  DshRuntimeConnection: vi.fn(function DshRuntimeConnectionMock() {
    const connection = {
      start: vi.fn(async () => connection),
      flushForFork: mocks.flushForFork,
      snapshotForFork: mocks.snapshotForFork
    }
    return connection
  })
}))

const { DshRuntimeDriver } = await import('./DshRuntimeDriver')

const checkpoint = {
  runtime: 'dsh',
  runtimeSessionId: 'native-1',
  boundary: 1,
  formatVersion: 4 as const
}

function forkInput() {
  return {
    sourceSessionId: 'host-session',
    checkpoint,
    checkpoints: [checkpoint],
    targetSessionId: 'child',
    targetCwd: '/workspace',
    artifactDirectory: '/tmp/fork',
    signal: new AbortController().signal
  }
}

afterEach(() => {
  vi.clearAllMocks()
  delete process.env.CHERRY_DSH_FORK_LIVE_EVENTS
  mocks.snapshotForFork.mockResolvedValue([{ seq: 0 }, { seq: 1 }])
})

describe('DshRuntimeDriver.fork live events', () => {
  it('passes the live snapshot into forkDshSession and does not flush twice', async () => {
    const driver = new DshRuntimeDriver()
    await driver.connect({ sessionId: 'host-session' } as AgentRuntimeConnectInput)

    await driver.fork(forkInput())

    expect(mocks.snapshotForFork).toHaveBeenCalledWith(1, expect.any(AbortSignal))
    expect(mocks.flushForFork).not.toHaveBeenCalled()
    expect(mocks.forkDshSession).toHaveBeenCalledWith(expect.objectContaining({ sourceSessionId: 'host-session' }), [
      { seq: 0 },
      { seq: 1 }
    ])
  })

  it('falls back to a disk fork when the source connection is gone', async () => {
    const driver = new DshRuntimeDriver()

    await driver.fork(forkInput())

    expect(mocks.snapshotForFork).not.toHaveBeenCalled()
    expect(mocks.forkDshSession).toHaveBeenCalledWith(expect.any(Object), undefined)
  })

  it('flushes without a snapshot when live events are disabled', async () => {
    process.env.CHERRY_DSH_FORK_LIVE_EVENTS = '0'
    const driver = new DshRuntimeDriver()
    await driver.connect({ sessionId: 'host-session' } as AgentRuntimeConnectInput)

    await driver.fork(forkInput())

    expect(mocks.snapshotForFork).not.toHaveBeenCalled()
    expect(mocks.flushForFork).toHaveBeenCalledOnce()
    expect(mocks.forkDshSession).toHaveBeenCalledWith(expect.any(Object), undefined)
  })

  it('omits an empty snapshot so the worker scans disk', async () => {
    mocks.snapshotForFork.mockResolvedValue([])
    const driver = new DshRuntimeDriver()
    await driver.connect({ sessionId: 'host-session' } as AgentRuntimeConnectInput)

    await driver.fork(forkInput())

    expect(mocks.forkDshSession).toHaveBeenCalledWith(expect.any(Object), undefined)
  })
})
