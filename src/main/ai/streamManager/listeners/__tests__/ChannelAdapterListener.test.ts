import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { ChannelAdapter } from '@main/ai/channels/ChannelAdapter'
import { markOutboundImageDelivered, resetOutboundImageDeliveryForTests } from '@main/ai/channels/outboundImageDelivery'
import { t } from '@main/i18n'
import type { UIMessageChunk } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StreamDoneResult, StreamPausedResult } from '../../types'
import { ChannelAdapterListener } from '../ChannelAdapterListener'

const SECRET = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'

function makeAdapter(overrides: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    channelId: 'ch-1',
    connected: true,
    isStreamListenerAlive: () => true,
    onStreamError: vi.fn().mockResolvedValue(false),
    onTextUpdate: vi.fn().mockResolvedValue(undefined),
    onStreamComplete: vi.fn().mockResolvedValue(false),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendImage: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    onToolProgress: vi.fn().mockResolvedValue(undefined),
    dismissToolProgress: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as ChannelAdapter
}

function delta(text: string): UIMessageChunk {
  return { type: 'text-delta', id: 't', delta: text } as UIMessageChunk
}

describe('ChannelAdapterListener', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('accumulates text-delta via .delta and redacts secrets before live onTextUpdate', () => {
    const adapter = makeAdapter()
    const listener = new ChannelAdapterListener(adapter, 'chat-1')

    listener.onChunk(delta('here is the key: '))
    listener.onChunk(delta(SECRET))

    const lastCall = vi.mocked(adapter.onTextUpdate).mock.calls.at(-1)
    expect(lastCall?.[0]).toBe('chat-1')
    expect(lastCall?.[1]).toContain('[REDACTED]')
    expect(lastCall?.[1]).not.toContain(SECRET)
  })

  it('redacts secrets in the final delivery on onDone', async () => {
    const adapter = makeAdapter({ onStreamComplete: vi.fn().mockResolvedValue(false) })
    const listener = new ChannelAdapterListener(adapter, 'chat-1')

    listener.onChunk(delta(`final answer ${SECRET} done`))
    await listener.onDone({ status: 'success' } as StreamDoneResult)

    // onStreamComplete (finalize UI) gets the sanitized text; sendMessage falls back since it returned false.
    expect(vi.mocked(adapter.onStreamComplete).mock.calls[0][1]).not.toContain(SECRET)
    expect(vi.mocked(adapter.sendMessage).mock.calls[0][1]).not.toContain(SECRET)
    expect(vi.mocked(adapter.sendMessage).mock.calls[0][1]).toContain('[REDACTED]')
  })

  it('withholds an incomplete citation marker from live updates', () => {
    const adapter = makeAdapter()
    const listener = new ChannelAdapterListener(adapter, 'chat-1')

    listener.onChunk(delta('Claim '))
    listener.onChunk(delta('[ci'))
    listener.onChunk(delta('te:source-'))
    listener.onChunk(delta('1]'))
    listener.onChunk(delta(' confirmed'))

    const updates = vi.mocked(adapter.onTextUpdate).mock.calls.map(([, text]) => text)
    expect(updates).toEqual(['Claim ', 'Claim', 'Claim', 'Claim', 'Claim confirmed'])
  })

  it('does not withhold a trailing bracket sequence once it is ruled out as a citation', () => {
    const adapter = makeAdapter()
    const listener = new ChannelAdapterListener(adapter, 'chat-1')

    listener.onChunk(delta('Array [city'))

    expect(adapter.onTextUpdate).toHaveBeenCalledWith('chat-1', 'Array [city', undefined)
  })

  it('preserves an incomplete citation-like suffix in the final delivery', async () => {
    const adapter = makeAdapter()
    const listener = new ChannelAdapterListener(adapter, 'chat-1')

    listener.onChunk(delta('Literal [cite:unfinished'))
    await listener.onDone({ status: 'success' } as StreamDoneResult)

    expect(adapter.sendMessage).toHaveBeenCalledWith('chat-1', 'Literal [cite:unfinished', undefined)
  })

  it('finalizes an empty turn without sending an empty fallback', async () => {
    const adapter = makeAdapter()
    const listener = new ChannelAdapterListener(adapter, 'chat-1')

    await listener.onDone({ status: 'success' } as StreamDoneResult)

    expect(adapter.onStreamComplete).toHaveBeenCalledOnce()
    expect(adapter.sendMessage).not.toHaveBeenCalled()
  })

  it('appends a stopped suffix on onPaused and falls back to sendMessage when onStreamComplete is false', async () => {
    const adapter = makeAdapter({ onStreamComplete: vi.fn().mockResolvedValue(false) })
    const listener = new ChannelAdapterListener(adapter, 'chat-1')

    listener.onChunk(delta('partial answer'))
    await listener.onPaused({ status: 'paused' } as StreamPausedResult)

    // onStreamComplete (finalize UI) gets the plain text; sendMessage falls back
    // since it returned false, and carries the truncation suffix.
    expect(vi.mocked(adapter.onStreamComplete).mock.calls[0][1]).toBe('partial answer')
    expect(vi.mocked(adapter.sendMessage).mock.calls[0][1]).toBe(`partial answer\n\n_(${t('common.channel_stopped')})_`)
  })

  it('finalizes an empty paused turn without sending an empty fallback', async () => {
    const adapter = makeAdapter()
    const listener = new ChannelAdapterListener(adapter, 'chat-1')

    await listener.onPaused({ status: 'paused' } as StreamPausedResult)

    expect(adapter.onStreamComplete).toHaveBeenCalledOnce()
    expect(adapter.sendMessage).not.toHaveBeenCalled()
  })

  it('routes tool-input-available and tool-output-available to onToolProgress', () => {
    const adapter = makeAdapter()
    const listener = new ChannelAdapterListener(adapter, 'chat-1')

    listener.onChunk({
      type: 'tool-input-available',
      toolCallId: 'call-1',
      toolName: 'bash',
      input: { command: 'ls -la' }
    } as unknown as UIMessageChunk)

    expect(adapter.onToolProgress).toHaveBeenCalledWith(
      'chat-1',
      {
        kind: 'start',
        toolCallId: 'call-1',
        toolName: 'bash',
        input: { command: 'ls -la' }
      },
      undefined
    )

    listener.onChunk({
      type: 'tool-output-available',
      toolCallId: 'call-1',
      output: 'total 0'
    } as unknown as UIMessageChunk)

    expect(adapter.onToolProgress).toHaveBeenCalledWith(
      'chat-1',
      {
        kind: 'done',
        toolCallId: 'call-1',
        ok: true
      },
      undefined
    )
  })

  it('dismisses tool progress on onDone, onPaused, and onError before final delivery', async () => {
    const adapter = makeAdapter({ onStreamComplete: vi.fn().mockResolvedValue(false) })
    const listener = new ChannelAdapterListener(adapter, 'chat-1')

    listener.onChunk(delta('result'))
    await listener.onDone({ status: 'success' } as StreamDoneResult)

    expect(adapter.dismissToolProgress).toHaveBeenCalledWith('chat-1', undefined)

    await listener.onPaused({ status: 'paused' } as StreamPausedResult)
    expect(adapter.dismissToolProgress).toHaveBeenCalledTimes(2)

    await listener.onError({ error: new Error('boom') } as any)
    expect(adapter.dismissToolProgress).toHaveBeenCalledTimes(3)
  })

  describe('outbound local images', () => {
    let workspace: string
    let outside: string

    beforeEach(async () => {
      resetOutboundImageDeliveryForTests()
      workspace = await mkdtemp(path.join(tmpdir(), 'cal-ws-'))
      outside = await mkdtemp(path.join(tmpdir(), 'cal-out-'))
    })

    afterEach(async () => {
      await rm(workspace, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    })

    it('sends workspace images via sendImage then delivers cleaned text on onDone', async () => {
      const imagePath = path.join(workspace, 'out.png')
      await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

      const adapter = makeAdapter({ onStreamComplete: vi.fn().mockResolvedValue(false) })
      const listener = new ChannelAdapterListener(adapter, 'chat-1', false, undefined, workspace)

      listener.onChunk(delta(`Chart:\n\n![${imagePath}](${imagePath})\n\nDone.`))
      await listener.onDone({ status: 'success' } as StreamDoneResult)

      expect(adapter.sendImage).toHaveBeenCalledTimes(1)
      const sent = vi.mocked(adapter.sendImage).mock.calls[0]
      expect(sent[0]).toBe('chat-1')
      expect(sent[1]).toMatchObject({ filename: 'out.png', media_type: 'image/png' })
      expect(adapter.sendMessage).toHaveBeenCalledWith('chat-1', 'Chart:\n\nDone.', undefined)
      expect(vi.mocked(adapter.sendMessage).mock.calls[0][1]).not.toContain(imagePath)
    })

    it('skips path→photo when workspacePath is unset', async () => {
      const adapter = makeAdapter({ onStreamComplete: vi.fn().mockResolvedValue(false) })
      const listener = new ChannelAdapterListener(adapter, 'chat-1')

      listener.onChunk(delta('![/ws/out.png](/ws/out.png)'))
      await listener.onDone({ status: 'success' } as StreamDoneResult)

      expect(adapter.sendImage).not.toHaveBeenCalled()
      expect(adapter.sendMessage).toHaveBeenCalledWith('chat-1', '![/ws/out.png](/ws/out.png)', undefined)
    })

    it('keeps failed paths in the text body and does not block text delivery', async () => {
      const outsideImage = path.join(outside, 'secret.png')
      await writeFile(outsideImage, Buffer.from('outside'))

      const adapter = makeAdapter({ onStreamComplete: vi.fn().mockResolvedValue(false) })
      const listener = new ChannelAdapterListener(adapter, 'chat-1', false, undefined, workspace)

      listener.onChunk(delta(`Hi\n\n![${outsideImage}](${outsideImage})`))
      await listener.onDone({ status: 'success' } as StreamDoneResult)

      expect(adapter.sendImage).not.toHaveBeenCalled()
      const delivered = vi.mocked(adapter.sendMessage).mock.calls[0][1] as string
      expect(delivered).toContain('Hi')
      expect(delivered).toContain(outsideImage)
    })

    it('delivers absolute images under an additional allowed root (CPA agent assets)', async () => {
      const assetsRoot = await mkdtemp(path.join(tmpdir(), 'cal-assets-'))
      try {
        const imagePath = path.join(assetsRoot, 'cute-girlfriend-23.jpg')
        await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))

        const adapter = makeAdapter({ onStreamComplete: vi.fn().mockResolvedValue(false) })
        // Pass assetsRoot explicitly; production defaults to ~/.agents/workspace.
        const listener = new ChannelAdapterListener(adapter, 'chat-1', false, undefined, workspace, [assetsRoot])

        listener.onChunk(delta(imagePath))
        await listener.onDone({ status: 'success' } as StreamDoneResult)

        expect(adapter.sendImage).toHaveBeenCalledTimes(1)
        expect(vi.mocked(adapter.sendImage).mock.calls[0][1]).toMatchObject({
          filename: 'cute-girlfriend-23.jpg',
          media_type: 'image/jpeg'
        })
        // Path-only body becomes empty after successful photo delivery.
        expect(adapter.sendMessage).not.toHaveBeenCalled()
        expect(adapter.onStreamComplete).toHaveBeenCalledWith('chat-1', '', undefined)
      } finally {
        await rm(assetsRoot, { recursive: true, force: true })
      }
    })

    it('does not upload images during streaming onTextUpdate', async () => {
      const imagePath = path.join(workspace, 'out.png')
      await writeFile(imagePath, Buffer.from('png'))

      const adapter = makeAdapter()
      const listener = new ChannelAdapterListener(adapter, 'chat-1', false, undefined, workspace)

      listener.onChunk(delta(`![${imagePath}](${imagePath})`))

      expect(adapter.sendImage).not.toHaveBeenCalled()
      expect(adapter.onTextUpdate).toHaveBeenCalled()
    })

    it('skips sendImage when notify already delivered the same realpath', async () => {
      const imagePath = path.join(workspace, 'dup.png')
      await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      const { realpath } = await import('node:fs/promises')
      const canonical = await realpath(imagePath)
      markOutboundImageDelivered('ch-1', 'chat-1', canonical)

      const adapter = makeAdapter({ onStreamComplete: vi.fn().mockResolvedValue(false) })
      const listener = new ChannelAdapterListener(adapter, 'chat-1', false, undefined, workspace)

      listener.onChunk(delta(`See\n\n![${imagePath}](${imagePath})\n\nDone.`))
      await listener.onDone({ status: 'success' } as StreamDoneResult)

      expect(adapter.sendImage).not.toHaveBeenCalled()
      expect(adapter.sendMessage).toHaveBeenCalledWith('chat-1', 'See\n\nDone.', undefined)
    })

    it('marks delivered realpath after a successful sendImage', async () => {
      const imagePath = path.join(workspace, 'mark.png')
      await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      const { realpath } = await import('node:fs/promises')
      const canonical = await realpath(imagePath)

      const adapter = makeAdapter({ onStreamComplete: vi.fn().mockResolvedValue(false) })
      const listener = new ChannelAdapterListener(adapter, 'chat-1', false, undefined, workspace)

      listener.onChunk(delta(`![${imagePath}](${imagePath})`))
      await listener.onDone({ status: 'success' } as StreamDoneResult)

      expect(adapter.sendImage).toHaveBeenCalledTimes(1)

      // Second listener on the same chat must not re-send.
      const adapter2 = makeAdapter({ onStreamComplete: vi.fn().mockResolvedValue(false) })
      const listener2 = new ChannelAdapterListener(adapter2, 'chat-1', false, undefined, workspace)
      listener2.onChunk(delta(`again\n\n![${imagePath}](${imagePath})`))
      await listener2.onDone({ status: 'success' } as StreamDoneResult)

      expect(adapter2.sendImage).not.toHaveBeenCalled()
      const { hasOutboundImageDelivered } = await import('@main/ai/channels/outboundImageDelivery')
      expect(hasOutboundImageDelivered('ch-1', 'chat-1', canonical)).toBe(true)
    })
  })

  it('delivers a terminal response only once even when terminal callbacks repeat', async () => {
    const adapter = makeAdapter()
    const listener = new ChannelAdapterListener(adapter, 'chat-1')
    listener.onChunk(delta('Answer'))
    await listener.onDone({ status: 'success' })
    await listener.onDone({ status: 'success' })
    await listener.onError({ status: 'error', error: { stack: '', name: 'Error', message: 'late error' } })
    expect(vi.mocked(adapter.sendMessage).mock.calls.map(([, text]) => text)).toEqual(['Answer'])
  })

  it('uses an adapter error reply instead of also sending a generic message', async () => {
    const adapter = makeAdapter({ onStreamError: vi.fn().mockResolvedValue(true) })
    const listener = new ChannelAdapterListener(adapter, 'chat-1')
    await listener.onError({ status: 'error', error: { stack: '', name: 'Error', message: SECRET } })
    expect(vi.mocked(adapter.onStreamError).mock.calls[0][1]).toContain('[REDACTED]')
    expect(vi.mocked(adapter.onStreamError).mock.calls[0][1]).not.toContain(SECRET)
    expect(adapter.sendMessage).not.toHaveBeenCalled()
  })

  it('cleans up suppressed task errors without sending a second failure summary', async () => {
    const adapter = makeAdapter()
    const listener = new ChannelAdapterListener(adapter, 'chat-1', true)
    await listener.onError({ status: 'error', error: { stack: '', name: 'Error', message: 'failed' } })
    expect(adapter.onStreamError).toHaveBeenCalledWith('chat-1', 'failed', undefined, { suppressDelivery: true })
    expect(adapter.sendMessage).not.toHaveBeenCalled()
  })

  it('keeps a live adapter subscription during transport loss but drops a retired adapter', () => {
    let alive = true
    const listener = new ChannelAdapterListener(
      makeAdapter({ connected: false, isStreamListenerAlive: () => alive }),
      'chat-1'
    )
    expect(listener.isAlive()).toBe(true)
    alive = false
    expect(listener.isAlive()).toBe(false)
  })
})
