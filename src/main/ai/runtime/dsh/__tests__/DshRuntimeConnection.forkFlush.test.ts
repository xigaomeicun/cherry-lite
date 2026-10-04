import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentRuntimeConnectInput } from '../../types'

const mocks = vi.hoisted(() => ({
  harnessOptions: undefined as Record<string, any> | undefined,
  bridge: undefined as { request: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } | undefined,
  getShellEnv: vi.fn(),
  resolveBun: vi.fn(),
  usesDshGateway: vi.fn(),
  getGatewayConfig: vi.fn()
}))

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  const result = mockApplicationFactory()
  const get = result.application.getContainer().get.bind(result.application.getContainer())
  result.application.get.mockImplementation((name: string) => {
    if (name === 'ApiGatewayService') return { getCurrentConfig: mocks.getGatewayConfig }
    return get(name)
  })
  return result
})

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../dshConnectionSignature', () => ({
  DshInvalidConnectionSnapshotError: class extends Error {},
  captureDshConnectionSnapshot: vi.fn(() =>
    Promise.resolve({
      signature: 'sig-1',
      agent: { id: 'agent-1', configuration: {}, disabledTools: [] },
      session: { agentId: 'agent-1', workspace: { path: '/workspace' } },
      provider: {},
      model: {},
      enabledApiKeys: [],
      additionalSkillPaths: [],
      mcpServerSnapshots: [],
      linkedChannel: null
    })
  )
}))
vi.mock('../modelInjection', () => ({
  resolveDshProviderInjectionFromSnapshot: vi.fn(() => ({
    providerName: 'deepseek',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:23333',
    modelId: 'deepseek-chat',
    apiKey: 'key',
    modelConfig: { id: 'deepseek-chat', contextWindow: 128_000, maxTokens: 8192 },
    usageCapture: { owner: 'provider-calls' }
  })),
  usesDshGateway: mocks.usesDshGateway
}))
vi.mock('../compositionBuilder', () => ({
  buildDshCompositionYaml: vi.fn(() => 'plugins: []'),
  resolveDshRuntimeBinPath: vi.fn(() => '/dsh/bin')
}))
vi.mock('../bunRuntime', () => ({ resolveDshBunRuntime: mocks.resolveBun }))
vi.mock('../DshBridgeServer', () => ({
  DshBridgeServer: vi.fn(function DshBridgeServerMock() {
    const instance = {
      socketPath: '/tmp/dsh.sock',
      authenticationToken: 'bridge-token',
      listen: vi.fn().mockResolvedValue(undefined),
      whenReady: vi.fn().mockResolvedValue(undefined),
      request: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    }
    mocks.bridge = instance
    return instance
  })
}))
vi.mock('../DshCherryToolBridge', () => ({
  buildDshCherryToolBridge: vi.fn().mockResolvedValue({
    tools: [],
    callTool: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined)
  }),
  buildDshCherryToolName: (server: string, tool: string) => `mcp__${server}__${tool}`,
  warmDshMcpToolCatalogs: vi.fn().mockResolvedValue(undefined),
  DSH_AUTO_APPROVED_BRIDGED_TOOLS: new Set<string>(),
  DSH_APPROVAL_REQUIRED_BRIDGED_TOOLS: new Set<string>(),
  DSH_NON_BYPASSABLE_APPROVAL_BRIDGED_TOOLS: new Set<string>()
}))
vi.mock('../dshSdk', () => ({
  loadDshSdk: vi.fn().mockResolvedValue({
    HarnessClient: vi.fn(function HarnessClientMock(options: Record<string, unknown>) {
      mocks.harnessOptions = options
      return {
        start: vi.fn(),
        initialize: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn(() => ({ async *[Symbol.asyncIterator]() {}, close: vi.fn() })),
        close: vi.fn().mockResolvedValue(undefined)
      }
    })
  })
}))
vi.mock('@main/utils/shellEnv', () => ({
  getShellEnv: mocks.getShellEnv,
  getPathFromEnvironment: (env: Record<string, string | undefined>) =>
    Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1]
}))
vi.mock('@main/ai/agents/agentDataDirectory', () => ({
  ensureAgentDataDirectory: vi.fn().mockResolvedValue('/agent-data')
}))
vi.mock('@main/ai/runtime/agentPrompt', () => ({
  buildAgentRuntimePrompt: vi.fn().mockResolvedValue({ base: { kind: 'native' }, append: '' })
}))
vi.mock('@main/ai/runtime/agentMcpServers', () => ({ buildAgentMcpServers: vi.fn(() => []) }))
vi.mock('@main/ai/runtime/citationsGuidance', () => ({ buildCitationsGuidance: vi.fn(() => '') }))
vi.mock('@main/ai/steerReminder', () => ({ wrapSteerReminder: vi.fn((text: string) => text) }))

const { DshRuntimeConnection } = await import('../DshRuntimeConnection')

const connectInput = {
  sessionId: 'session-1',
  agentId: 'agent-1',
  modelId: 'deepseek::deepseek-chat'
} as unknown as AgentRuntimeConnectInput

beforeEach(() => {
  mocks.bridge = undefined
  mocks.resolveBun.mockReset().mockResolvedValue('/bundled/bun')
  mocks.usesDshGateway.mockReset().mockReturnValue(true)
  mocks.getGatewayConfig.mockReset().mockReturnValue({ enabled: true, host: '127.0.0.1', port: 23333 })
  mocks.getShellEnv.mockReset().mockResolvedValue({ PATH: '/usr/bin', HOME: '/Users/tester' })
})

// A Session forked by an earlier edit resumes a native id that no longer equals the host Session
// id, and the bridge registers its live agent under that native id. Flushing the host id is what
// made every edit-resend after the first one fail with "no live agent for session <host>", which
// surfaced as the generic operation_failed copy ("check file permissions and free disk space").
describe('DshRuntimeConnection fork flush', () => {
  it('flushes the native session the bridge opened, not the host Session', async () => {
    const connection = await new DshRuntimeConnection({
      ...connectInput,
      nativeSessionId: 'native-session',
      resumeToken: 'native-resumed'
    } as unknown as AgentRuntimeConnectInput).start()

    const opened = mocks.bridge!.request.mock.calls.find(([method]) => method === 'session/open')
    expect(opened?.[1]).toMatchObject({ sessionId: 'native-resumed' })

    await connection.flushForFork()

    const flushed = mocks.bridge!.request.mock.calls.find(([method]) => method === 'session/flush')
    expect(flushed?.[1]).toMatchObject({ sessionId: 'native-resumed' })
    expect(flushed?.[1]).not.toMatchObject({ sessionId: connectInput.sessionId })
  })

  it('returns live events from session/fork-snapshot after flushing the native session', async () => {
    const connection = await new DshRuntimeConnection({
      ...connectInput,
      nativeSessionId: 'native-session',
      resumeToken: 'native-resumed'
    } as unknown as AgentRuntimeConnectInput).start()
    const events = [{ type: 'turn/end', seq: 4 }]
    mocks.bridge!.request.mockImplementation(async (method: string) => {
      if (method === 'session/fork-snapshot') return { events }
      return {}
    })

    await expect(connection.snapshotForFork(4)).resolves.toEqual(events)

    const flushed = mocks.bridge!.request.mock.calls.find(([method]) => method === 'session/flush')
    const snapshotted = mocks.bridge!.request.mock.calls.find(([method]) => method === 'session/fork-snapshot')
    expect(flushed?.[1]).toMatchObject({ sessionId: 'native-resumed' })
    expect(snapshotted?.[1]).toEqual({ sessionId: 'native-resumed', boundary: 4 })
    expect(mocks.bridge!.request.mock.calls.findIndex(([method]) => method === 'session/flush')).toBeLessThan(
      mocks.bridge!.request.mock.calls.findIndex(([method]) => method === 'session/fork-snapshot')
    )
  })

  it('propagates history_changed instead of hiding it behind a disk scan', async () => {
    const connection = await new DshRuntimeConnection({
      ...connectInput,
      resumeToken: 'native-resumed'
    } as unknown as AgentRuntimeConnectInput).start()
    mocks.bridge!.request.mockImplementation(async (method: string) => {
      if (method === 'session/fork-snapshot') throw new Error('history_changed')
      return {}
    })

    await expect(connection.snapshotForFork(4)).rejects.toThrow('history_changed')
  })

  it('falls back when the connection was never started', async () => {
    const connection = new DshRuntimeConnection(connectInput)
    await expect(connection.snapshotForFork(1)).resolves.toBeUndefined()
  })
})
