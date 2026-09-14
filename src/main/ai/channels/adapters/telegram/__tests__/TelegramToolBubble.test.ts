import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type TelegramBubbleApi, type TelegramBubbleLogger, TelegramToolBubbleController } from '../TelegramToolBubble'

describe('TelegramToolBubbleController', () => {
  let sentMessages: Array<{ text: string; id: number }> = []
  let editedMessages: Array<{ id: number; text: string }> = []
  let deletedMessages: number[] = []
  let nextMsgId = 100

  let api: TelegramBubbleApi
  let logger: TelegramBubbleLogger
  let controller: TelegramToolBubbleController

  beforeEach(() => {
    vi.useFakeTimers()
    sentMessages = []
    editedMessages = []
    deletedMessages = []
    nextMsgId = 100

    api = {
      sendMessage: vi.fn(async (text: string) => {
        const id = ++nextMsgId
        sentMessages.push({ id, text })
        return id
      }),
      editMessageText: vi.fn(async (messageId: number, text: string) => {
        editedMessages.push({ id: messageId, text })
      }),
      deleteMessage: vi.fn(async (messageId: number) => {
        deletedMessages.push(messageId)
      })
    }

    logger = {
      warn: vi.fn(),
      debug: vi.fn()
    }

    controller = new TelegramToolBubbleController('123456', api, logger)
  })

  afterEach(() => {
    controller.dispose()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('debounces tool-start events and sends a bubble message', async () => {
    controller.onStart('call-1', 'bash', { command: 'npm test' })
    expect(api.sendMessage).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(300)

    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    expect(sentMessages[0].text).toBe('● npm test')
  })

  it('edits existing bubble message when a second tool starts', async () => {
    controller.onStart('call-1', 'bash', { command: 'npm test' })
    await vi.advanceTimersByTimeAsync(300)
    expect(sentMessages.length).toBe(1)

    controller.onStart('call-2', 'read_file', { path: '/tmp/report.json' })
    await vi.advanceTimersByTimeAsync(300)

    expect(api.editMessageText).toHaveBeenCalledWith(sentMessages[0].id, '● npm test\n● view report.json')
  })

  it('displays last completed tool when all active tools complete', async () => {
    controller.onStart('call-1', 'bash', { command: 'npm test' })
    await vi.advanceTimersByTimeAsync(300)

    controller.onDone('call-1')
    await vi.advanceTimersByTimeAsync(300)

    expect(api.editMessageText).toHaveBeenLastCalledWith(sentMessages[0].id, '● npm test')
  })

  it('purges bubbles across delay waves on dismiss', async () => {
    controller.onStart('call-1', 'bash', { command: 'git status' })
    await vi.advanceTimersByTimeAsync(300)
    const msgId = sentMessages[0].id

    await controller.dismiss(false)
    expect(deletedMessages).not.toContain(msgId)

    // First wave (1000ms)
    await vi.advanceTimersByTimeAsync(1000)
    expect(deletedMessages).toContain(msgId)
  })

  it('purges immediately on immediate dismiss or dispose', async () => {
    controller.onStart('call-1', 'bash', { command: 'git pull' })
    await vi.advanceTimersByTimeAsync(300)
    const msgId = sentMessages[0].id

    await controller.dismiss(true)
    expect(deletedMessages).toContain(msgId)
  })

  it('tolerates "message is not modified" without failing or re-sending', async () => {
    controller.onStart('call-1', 'bash', { command: 'git pull' })
    await vi.advanceTimersByTimeAsync(300)

    api.editMessageText = vi.fn().mockRejectedValueOnce(new Error('Bad Request: message is not modified'))
    controller.onStart('call-1', 'bash', { command: 'git pull' })
    await vi.advanceTimersByTimeAsync(300)

    expect(api.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('re-sends bubble when edit fails with "message to edit not found"', async () => {
    controller.onStart('call-1', 'bash', { command: 'git pull' })
    await vi.advanceTimersByTimeAsync(300)
    expect(sentMessages.length).toBe(1)

    api.editMessageText = vi.fn().mockRejectedValueOnce(new Error('Bad Request: message to edit not found'))
    controller.onStart('call-2', 'glob', { pattern: '*.ts' })
    await vi.advanceTimersByTimeAsync(300)

    expect(sentMessages.length).toBe(2)
    expect(sentMessages[1].text).toContain('glob *.ts')
  })
})
