import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))

// Mock registerAdapterFactory to capture the factory function
vi.mock('../../ChannelManager', () => ({
  registerAdapterFactory: vi.fn()
}))

const mockBot = {
  use: vi.fn(),
  command: vi.fn(),
  on: vi.fn(),
  api: {
    config: {
      use: vi.fn()
    },
    setMyCommands: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
    sendDocument: vi.fn().mockResolvedValue(undefined),
    sendPhoto: vi.fn().mockResolvedValue(undefined),
    setMessageReaction: vi.fn().mockResolvedValue(undefined)
  },
  catch: vi.fn(),
  init: vi.fn().mockResolvedValue(undefined),
  start: vi.fn(),
  stop: vi.fn().mockResolvedValue(undefined)
}

vi.mock('grammy', () => {
  class MockInputFile {
    constructor(
      readonly data: Buffer,
      readonly filename: string
    ) {}
  }
  class MockGrammyError extends Error {
    constructor(
      message: string,
      readonly payload: { ok: boolean; error_code: number; description: string },
      readonly method: string,
      readonly parameters: Record<string, unknown>
    ) {
      super(message)
      this.name = 'GrammyError'
    }
    get error_code() {
      return this.payload.error_code
    }
    get description() {
      return this.payload.description
    }
  }
  class MockHttpError extends Error {
    constructor(
      message: string,
      readonly error: unknown
    ) {
      super(message)
      this.name = 'HttpError'
    }
  }
  return {
    Bot: vi.fn().mockImplementation(function BotMock() {
      return mockBot
    }),
    InputFile: MockInputFile,
    GrammyError: MockGrammyError,
    HttpError: MockHttpError
  }
})

// Import the module to trigger self-registration side effect
import '../telegram/TelegramAdapter'

import { Bot, InputFile } from 'grammy'

import { registerAdapterFactory } from '../../ChannelManager'
import { CHUNK_MAX } from '../telegram/markdownTg'

function getFactory() {
  const call = vi.mocked(registerAdapterFactory).mock.calls[0]
  if (!call) throw new Error('registerAdapterFactory was not called')
  return call[1] as (channel: any, agentId: string) => any
}

describe('TelegramAdapter', () => {
  beforeEach(() => {
    // Reset all mock functions but preserve the factory registration
    mockBot.use.mockClear()
    mockBot.command.mockClear()
    mockBot.on.mockClear()
    mockBot.api.config.use.mockClear()
    mockBot.api.setMyCommands.mockClear().mockResolvedValue(undefined)
    mockBot.api.sendMessage.mockClear().mockResolvedValue(undefined)
    mockBot.api.sendChatAction.mockClear().mockResolvedValue(undefined)
    mockBot.api.sendDocument.mockClear().mockResolvedValue(undefined)
    mockBot.api.sendPhoto.mockClear().mockResolvedValue(undefined)
    mockBot.catch.mockClear()
    mockBot.init.mockReset().mockResolvedValue(undefined)
    mockBot.start.mockReset().mockImplementation(async (options?: { onStart?: (info: object) => void }) => {
      await options?.onStart?.({})
    })
    mockBot.stop.mockReset().mockResolvedValue(undefined)
    vi.mocked(Bot).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function createAdapter(overrides: Record<string, unknown> = {}) {
    const factory = getFactory()
    return factory(
      {
        id: (overrides.channelId as string) ?? 'ch-1',
        type: 'telegram',
        enabled: true,
        config: {
          bot_token: (overrides.bot_token as string) ?? 'test-token',
          allowed_chat_ids: (overrides.allowed_chat_ids as string[]) ?? ['123']
        }
      },
      (overrides.agentId as string) ?? 'agent-1'
    )
  }

  it('connect() registers middleware, commands, message handler, and starts polling', async () => {
    const adapter = createAdapter()
    await adapter.connect()

    expect(mockBot.use).toHaveBeenCalledTimes(1) // auth middleware
    expect(mockBot.command).toHaveBeenCalledTimes(10) // new/stop/model/switch/mode/status/rename/compact/reboot/restart
    expect(mockBot.on).toHaveBeenCalledWith('callback_query:data', expect.any(Function))
    expect(mockBot.on).toHaveBeenCalledWith('message:text', expect.any(Function))
    expect(mockBot.api.setMyCommands).toHaveBeenCalledWith([
      { command: 'new', description: '🆕 开启全新会话' },
      { command: 'stop', description: '✋ 终止当前任务' },
      { command: 'model', description: '🧠 切换底座模型' },
      { command: 'switch', description: '🤖 切换执行后端' },
      { command: 'mode', description: '🎮 切换权限模式' },
      { command: 'status', description: '📊 查看当前状态' },
      { command: 'rename', description: '✏️ 命名当前会话' },
      { command: 'compact', description: '🗜️ 压缩会话记忆' },
      { command: 'reboot', description: '🧿 重启樱桃服务' }
    ])
    expect(mockBot.catch).toHaveBeenCalledTimes(1)
    expect(mockBot.start).toHaveBeenCalledTimes(1)
    expect(mockBot.api.config.use).toHaveBeenCalledTimes(1)
    expect(mockBot.start).toHaveBeenCalledWith(expect.objectContaining({ timeout: 30, onStart: expect.any(Function) }))
  })

  it('reports connected only after grammY confirms polling startup', async () => {
    let onStart: ((info: object) => void) | undefined
    mockBot.start.mockImplementationOnce((options?: { onStart?: (info: object) => void }) => {
      onStart = options?.onStart
      return new Promise(() => {})
    })
    const adapter = createAdapter()

    await adapter.connect()
    expect(adapter.connected).toBe(false)

    onStart?.({})
    expect(adapter.connected).toBe(true)
  })

  it('aborts only a suspended getUpdates request after 45 seconds', async () => {
    vi.useFakeTimers()
    const adapter = createAdapter()
    await adapter.connect()
    const transformer = mockBot.api.config.use.mock.calls[0][0]
    let requestSignal: AbortSignal | undefined
    const request = vi.fn((_method: string, _payload: unknown, signal?: AbortSignal) => {
      requestSignal = signal
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })

    const upstream = new AbortController()
    const removeListener = vi.spyOn(upstream.signal, 'removeEventListener')
    const polling = transformer(request, 'getUpdates', { timeout: 30 }, upstream.signal)
    const rejected = expect(polling).rejects.toBeDefined()
    await vi.advanceTimersByTimeAsync(44_999)
    expect(requestSignal?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(requestSignal?.aborted).toBe(true)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('does not apply the polling timeout to sends or uploads', async () => {
    const adapter = createAdapter()
    await adapter.connect()
    const transformer = mockBot.api.config.use.mock.calls[0][0]
    const signal = new AbortController().signal
    const request = vi.fn().mockResolvedValue({ ok: true, result: true })

    await transformer(request, 'sendMessage', { chat_id: '123', text: 'hello' }, signal)
    await transformer(request, 'sendDocument', { chat_id: '123', document: 'file-id' }, signal)

    expect(request).toHaveBeenNthCalledWith(1, 'sendMessage', { chat_id: '123', text: 'hello' }, signal)
    expect(request).toHaveBeenNthCalledWith(2, 'sendDocument', { chat_id: '123', document: 'file-id' }, signal)
  })

  it('coalesces resume events and restarts polling on the same bot', async () => {
    let finishStop: (() => void) | undefined
    let finishPolling: (() => void) | undefined
    mockBot.start.mockImplementationOnce((options?: { onStart?: (info: object) => void }) => {
      options?.onStart?.({})
      return new Promise<void>((resolve) => {
        finishPolling = resolve
      })
    })
    mockBot.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve
        })
    )
    const adapter = createAdapter()
    await adapter.connect()

    adapter.handleSystemResume()
    adapter.handleSystemResume()

    expect(mockBot.stop).toHaveBeenCalledOnce()
    finishStop?.()
    finishPolling?.()
    await vi.waitFor(() => expect(mockBot.start).toHaveBeenCalledTimes(2))
    expect(Bot).toHaveBeenCalledOnce()
  })

  it('restarts polling after resume even when stopping the stale poll fails', async () => {
    mockBot.stop.mockRejectedValueOnce(new Error('stale poll stop failed'))
    const adapter = createAdapter()
    await adapter.connect()

    adapter.handleSystemResume()

    await vi.waitFor(() => expect(mockBot.start).toHaveBeenCalledTimes(2))
    expect(Bot).toHaveBeenCalledOnce()
  })

  it('does not revive polling when disconnected during resume recovery', async () => {
    let finishResumeStop: (() => void) | undefined
    mockBot.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishResumeStop = resolve
        })
    )
    const adapter = createAdapter()
    await adapter.connect()

    adapter.handleSystemResume()
    const disconnecting = adapter.disconnect()
    finishResumeStop?.()
    await disconnecting

    await vi.waitFor(() => expect(mockBot.start).toHaveBeenCalledTimes(1))
    expect(adapter.connected).toBe(false)
  })

  it('disconnect() stops the bot', async () => {
    const adapter = createAdapter()
    await adapter.connect()
    await adapter.disconnect()

    expect(mockBot.stop).toHaveBeenCalledTimes(1)
  })

  // channel-adapters-2: grammY rethrows a fatal 409/Conflict out of bot.start(); the adapter
  // must reconnect with backoff instead of staying permanently down.
  it('reconnects with backoff when polling rejects (REGRESSION channel-adapters-2)', async () => {
    vi.useFakeTimers()
    const adapter = createAdapter()
    mockBot.start.mockReset()
    // First polling attempt fails (recoverable 409); the reconnect attempt succeeds.
    mockBot.start
      .mockRejectedValueOnce(new Error('409: Conflict'))
      .mockImplementation(async (options?: { onStart?: (info: object) => void }) => {
        await options?.onStart?.({})
      })

    await adapter.connect()
    await vi.advanceTimersByTimeAsync(0) // let the rejection handler schedule the reconnect
    expect(mockBot.start).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000) // first backoff delay
    expect(mockBot.start).toHaveBeenCalledTimes(2) // reconnected
  })

  it('retries with backoff when the startup connect hits a network error', async () => {
    vi.useFakeTimers()
    const { HttpError } = (await import('grammy')) as any
    const adapter = createAdapter()
    mockBot.init.mockRejectedValueOnce(
      new HttpError("Network request for 'getMe' failed!", Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
    )

    await expect(adapter.connect()).resolves.toBeUndefined()
    expect(mockBot.start).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(mockBot.init).toHaveBeenCalledTimes(2)
    expect(mockBot.start).toHaveBeenCalledTimes(1)
  })

  it('does not fail connect when setMyCommands fails', async () => {
    const { HttpError } = (await import('grammy')) as any
    mockBot.api.setMyCommands.mockRejectedValueOnce(new HttpError("Network request for 'setMyCommands' failed!", {}))
    const adapter = createAdapter()
    await adapter.connect()
    expect(mockBot.start).toHaveBeenCalledTimes(1)
  })

  it('resets the reconnect budget after a stable polling window (REGRESSION channel-adapters-2)', async () => {
    vi.useFakeTimers()
    const adapter = createAdapter()
    mockBot.start.mockReset()
    // One transient failure bumps the attempt counter, then the reconnect stays up.
    mockBot.start
      .mockRejectedValueOnce(new Error('409: Conflict'))
      .mockImplementation(async (options?: { onStart?: (info: object) => void }) => {
        await options?.onStart?.({})
      })

    await adapter.connect()
    await vi.advanceTimersByTimeAsync(1000) // reconnect fires and succeeds
    expect(adapter.reconnectAttempts).toBe(1)

    // After the stability window the counter resets, so lifetime-cumulative transient
    // failures can't monotonically exhaust maxReconnectAttempts.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(adapter.reconnectAttempts).toBe(0)
  })

  it('does not reconnect after disconnect() (REGRESSION channel-adapters-2)', async () => {
    vi.useFakeTimers()
    const adapter = createAdapter()
    mockBot.start.mockReset()
    mockBot.start.mockRejectedValue(new Error('409: Conflict'))

    await adapter.connect()
    await vi.advanceTimersByTimeAsync(0) // a reconnect is now pending
    await adapter.disconnect() // shouldStop + clear the pending reconnect timer

    const callsAfterDisconnect = mockBot.start.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mockBot.start.mock.calls.length).toBe(callsAfterDisconnect) // no further reconnect
  })

  it('sendMessage() sends text with HTML by default', async () => {
    const adapter = createAdapter()
    await adapter.connect()
    await adapter.sendMessage('123', 'Hello')

    expect(mockBot.api.sendMessage).toHaveBeenCalledWith('123', 'Hello', { parse_mode: 'HTML' })
  })

  it('sendMessage() converts markdown to Telegram HTML via library', async () => {
    const adapter = createAdapter()
    await adapter.connect()
    await adapter.sendMessage('123', '**bold price**')

    const call = mockBot.api.sendMessage.mock.calls[0]
    expect(call[0]).toBe('123')
    expect(call[2]).toEqual({ parse_mode: 'HTML' })
    expect(call[1]).toContain('<b>')
    expect(call[1]).not.toBe('**bold price**')
  })

  it('sendMessage() falls back to plain text on HTML parse error', async () => {
    const adapter = createAdapter()
    await adapter.connect()

    mockBot.api.sendMessage.mockRejectedValueOnce(new Error("Bad Request: can't parse"))

    await adapter.sendMessage('123', 'Hello')

    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(2)
    // Second call should be plain text fallback
    expect(mockBot.api.sendMessage.mock.calls[1][1]).toBe('Hello')
  })

  it('sendMessage() chunks long messages', async () => {
    vi.useFakeTimers()
    const adapter = createAdapter()
    await adapter.connect()

    const longText = 'A'.repeat(5000)
    const sendPromise = adapter.sendMessage('123', longText)

    // Flush all pending timers (inter-chunk delays) regardless of count
    await vi.runAllTimersAsync()
    await sendPromise

    // Splitting is by converted visible length (planTelegramSend). A single
    // break-less line offers no block or row boundary, so the oversized-block
    // fallback hard-cuts it into several parts instead of the old raw 4096 split.
    const parts = mockBot.api.sendMessage.mock.calls.map((call) => call[1] as string)
    expect(parts.length).toBeGreaterThan(1)
    // Nothing is dropped or duplicated across the parts.
    expect(parts.join('')).toBe(longText)
    // Every part stays within Telegram's 4096-char ceiling.
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(CHUNK_MAX)
  })

  it('sendFile() sends a document built from the decoded buffer and filename', async () => {
    const adapter = createAdapter()
    await adapter.connect()

    const data = Buffer.from('file-bytes').toString('base64')
    await adapter.sendFile('123', { filename: 'report.pdf', data, media_type: 'application/pdf', size: 10 })

    expect(mockBot.api.sendDocument).toHaveBeenCalledTimes(1)
    const [chatId, inputFile] = mockBot.api.sendDocument.mock.calls[0]
    expect(chatId).toBe('123')
    expect(inputFile).toBeInstanceOf(InputFile)
    expect(inputFile.filename).toBe('report.pdf')
    expect(inputFile.data.toString()).toBe('file-bytes')
  })

  it('sendImage() uses sendPhoto for JPEG/PNG/WebP under the photo size limit', async () => {
    const adapter = createAdapter()
    await adapter.connect()

    const data = Buffer.from('fakepng').toString('base64')
    await adapter.sendImage('123', { filename: 'shot.png', data, media_type: 'image/png', size: 7 })

    expect(mockBot.api.sendPhoto).toHaveBeenCalledTimes(1)
    expect(mockBot.api.sendDocument).not.toHaveBeenCalled()
    const [chatId, inputFile] = mockBot.api.sendPhoto.mock.calls[0]
    expect(chatId).toBe('123')
    expect(inputFile).toBeInstanceOf(InputFile)
    expect((inputFile as InstanceType<typeof InputFile>).filename).toBe('shot.png')
  })

  it('sendImage() falls back to sendDocument for GIF', async () => {
    const adapter = createAdapter()
    await adapter.connect()

    const data = Buffer.from('fakegif').toString('base64')
    await adapter.sendImage('123', { filename: 'anim.gif', data, media_type: 'image/gif', size: 7 })

    expect(mockBot.api.sendDocument).toHaveBeenCalledTimes(1)
    expect(mockBot.api.sendPhoto).not.toHaveBeenCalled()
  })

  it('sendImage() falls back to sendDocument when payload exceeds the photo limit', async () => {
    const adapter = createAdapter()
    await adapter.connect()

    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 1)
    const data = big.toString('base64')
    await adapter.sendImage('123', {
      filename: 'huge.png',
      data,
      media_type: 'image/png',
      size: big.length
    })

    expect(mockBot.api.sendDocument).toHaveBeenCalledTimes(1)
    expect(mockBot.api.sendPhoto).not.toHaveBeenCalled()
  })

  it('sendTypingIndicator() sends typing action', async () => {
    const adapter = createAdapter()
    await adapter.connect()
    await adapter.sendTypingIndicator('123')

    expect(mockBot.api.sendChatAction).toHaveBeenCalledWith('123', 'typing')
  })

  it('auth middleware blocks unauthorized chats', async () => {
    const adapter = createAdapter({ allowed_chat_ids: ['123'] })
    await adapter.connect()

    // Extract the auth middleware
    const middleware = mockBot.use.mock.calls[0][0] as (ctx: any, next: () => Promise<void>) => Promise<void>

    const next = vi.fn()

    // Unauthorized chat
    await middleware({ chat: { id: 999 } }, next)
    expect(next).not.toHaveBeenCalled()

    // Authorized chat
    next.mockClear()
    await middleware({ chat: { id: 123 } }, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('command handler emits command events', async () => {
    const adapter = createAdapter()
    await adapter.connect()

    const commandSpy = vi.fn()
    adapter.on('command', commandSpy)

    // Find the 'new' command handler (first bot.command call)
    const commandHandler = mockBot.command.mock.calls[0][1] as (ctx: any) => void

    commandHandler({
      chat: { id: 123 },
      from: { id: 456, first_name: 'TestUser' }
    })

    expect(commandSpy).toHaveBeenCalledWith({
      chatId: '123',
      userId: '456',
      userName: 'TestUser',
      command: 'new',
      messageId: ''
    })
  })

  it('stop command handler emits command events', async () => {
    const adapter = createAdapter()
    await adapter.connect()

    const commandSpy = vi.fn()
    adapter.on('command', commandSpy)

    const stopCall = mockBot.command.mock.calls.find((call) => call[0] === 'stop')
    expect(stopCall).toBeDefined()
    const commandHandler = stopCall![1] as (ctx: any) => void

    commandHandler({
      chat: { id: 123 },
      from: { id: 456, first_name: 'TestUser' }
    })

    expect(commandSpy).toHaveBeenCalledWith({
      chatId: '123',
      userId: '456',
      userName: 'TestUser',
      command: 'stop',
      messageId: ''
    })
  })

  it('message handler emits message events', async () => {
    const adapter = createAdapter()
    await adapter.connect()

    const messageSpy = vi.fn()
    adapter.on('message', messageSpy)

    const textCall = mockBot.on.mock.calls.find((call) => call[0] === 'message:text')
    expect(textCall).toBeDefined()
    const messageHandler = textCall![1] as (ctx: any) => void

    messageHandler({
      chat: { id: 123 },
      from: { id: 456, first_name: 'TestUser' },
      message: { message_id: 42, text: 'Hello bot' }
    })

    expect(messageSpy).toHaveBeenCalledWith({
      chatId: '123',
      userId: '456',
      userName: 'TestUser',
      text: 'Hello bot',
      messageId: '42'
    })
  })

  it('retries HTML sendMessage on network failure before giving up', async () => {
    const adapter = createAdapter()
    await adapter.connect()

    mockBot.api.sendMessage
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce({ message_id: 101 })

    await adapter.sendMessage('123', 'Hello **bold**')

    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(2)
    expect(mockBot.api.sendMessage).toHaveBeenNthCalledWith(1, '123', expect.stringContaining('<b>bold</b>'), {
      parse_mode: 'HTML'
    })
    expect(mockBot.api.sendMessage).toHaveBeenNthCalledWith(2, '123', expect.stringContaining('<b>bold</b>'), {
      parse_mode: 'HTML'
    })
  })

  it('falls back to plain text immediately on parse entities error', async () => {
    const { GrammyError } = await import('grammy')
    const adapter = createAdapter()
    await adapter.connect()

    const parseError = new GrammyError(
      'Bad Request',
      { ok: false, error_code: 400, description: "Bad Request: can't parse entities: unclosed tag" },
      'sendMessage',
      {}
    )
    mockBot.api.sendMessage.mockRejectedValueOnce(parseError).mockResolvedValueOnce({ message_id: 102 })

    await adapter.sendMessage('123', 'Hello **bold**')

    expect(mockBot.api.sendMessage).toHaveBeenCalledTimes(2)
    expect(mockBot.api.sendMessage).toHaveBeenNthCalledWith(1, '123', expect.stringContaining('<b>bold</b>'), {
      parse_mode: 'HTML'
    })
    expect(mockBot.api.sendMessage).toHaveBeenNthCalledWith(2, '123', 'Hello **bold**', {})
  })

  it('reboot command handler emits command events', async () => {
    const adapter = createAdapter()
    await adapter.connect()

    const commandSpy = vi.fn()
    adapter.on('command', commandSpy)

    const rebootCall = mockBot.command.mock.calls.find((call) => call[0] === 'reboot')
    expect(rebootCall).toBeDefined()
    const commandHandler = rebootCall![1] as (ctx: any) => void

    commandHandler({
      chat: { id: 123 },
      from: { id: 456, first_name: 'TestUser' }
    })

    expect(commandSpy).toHaveBeenCalledWith({
      chatId: '123',
      userId: '456',
      userName: 'TestUser',
      command: 'reboot',
      messageId: ''
    })
  })
})
