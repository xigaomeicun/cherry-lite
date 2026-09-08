import { loggerService } from '@logger'
import {
  askUserPending,
  type ChannelAdapter,
  escHtml,
  normalizeToolKey,
  sanitizeChannelOutput,
  type SendMessageOptions,
  toolPermSent
} from '@main/ai/channels'
import { toolApprovalRegistry } from '@main/ai/toolApproval/ToolApprovalRegistry'
import type { UniqueModelId } from '@shared/data/types/model'
import type { UIMessageChunk } from 'ai'

import type { StreamDoneResult, StreamErrorResult, StreamListener, StreamPausedResult } from '../types'

const logger = loggerService.withContext('ChannelAdapterListener')
const INCOMPLETE_CITATION_MARKER_PATTERN = /[ \t]?\[(?:c(?:i(?:t(?:e(?::[\w-]*)?)?)?)?)?$/

/** IM-channel sink (Discord / Slack / Feishu / Telegram / etc). */
export class ChannelAdapterListener implements StreamListener {
  readonly id: string
  private accumulatedText = ''
  private exitPlanCardSent = false

  constructor(
    private readonly adapter: ChannelAdapter,
    private readonly platformChatId: string,
    /**
     * Skip the generic `Error: …` channel message on failure. Scheduled-task runs
     * deliver a richer `[Task failed] …` summary themselves (see `runAgentTask`), so
     * leaving this on would double-notify every subscribed channel.
     */
    private readonly suppressErrorMessage = false,
    /** Response context for the inbound message, including thread placement where supported. */
    private readonly responseOptions?: SendMessageOptions
  ) {
    const responseKey = this.responseOptions?.replyToMessageId ?? 'unthreaded'
    this.id = `channel:${adapter.channelId}:${this.platformChatId}:${responseKey}`
  }

  /** Deliver a final message using the inbound message's response context. */
  private deliver(text: string): Promise<void> {
    return this.adapter.sendMessage(this.platformChatId, text, this.responseOptions)
  }

  private updateStream(text: string): Promise<void> {
    return this.adapter.onTextUpdate(this.platformChatId, text, this.responseOptions)
  }

  private completeStream(text: string): Promise<boolean> {
    return this.adapter.onStreamComplete(this.platformChatId, text, this.responseOptions)
  }

  // oxlint-disable-next-line no-unused-vars
  onChunk(chunk: UIMessageChunk, _sourceModelId?: UniqueModelId): void {
    if (chunk.type === 'text-delta' && chunk.delta) {
      this.accumulatedText += chunk.delta
      // Best-effort streaming update; adapter chooses to throttle. Sanitize here — this is
      // the live delivery path that reaches the IM platform, so secrets (keys/tokens) must
      // be redacted before they leave.
      const { text } = sanitizeChannelOutput(this.accumulatedText)
      const update = this.updateStream(text.replace(INCOMPLETE_CITATION_MARKER_PATTERN, ''))
      void update.catch(() => {})
    }

    if (chunk.type === 'tool-approval-request' && this.adapter.channelType === 'telegram') {
      this.sendTelegramApprovalCard(chunk)
    }
  }

  private sendTelegramApprovalCard(chunk: UIMessageChunk & { type: 'tool-approval-request' }): void {
    const approvalId = chunk.approvalId
    if (!approvalId) return

    const details = toolApprovalRegistry.peekDetails(approvalId)
    const toolNameRaw = details?.toolName ?? ''
    const toolKey = normalizeToolKey(toolNameRaw)
    const input = (details?.originalInput ?? {}) as Record<string, unknown>

    if (toolKey === 'exitplanmode' && !this.exitPlanCardSent) {
      this.exitPlanCardSent = true
      void this.adapter
        .sendMessage(
          this.platformChatId,
          '📋 <b>计划已就绪</b>\n\n模型已提交 <code>exit_plan_mode</code>，源码尚未改动。请确认：',
          {
            ...this.responseOptions,
            parseMode: 'html',
            replyMarkup: {
              inline_keyboard: [
                [
                  { text: '✅ 批准执行', callback_data: `xplan:approve:${approvalId}` },
                  { text: '✏️ 继续调整', callback_data: `xplan:revise:${approvalId}` },
                  { text: '❌ 放弃任务', callback_data: `xplan:cancel:${approvalId}` }
                ]
              ]
            }
          }
        )
        .catch((err) => logger.error('Failed to send exit_plan_mode card', { err }))
      return
    }

    if (toolKey === 'askuserquestion' || toolKey === 'builtinaskuserquestion') {
      const questions = Array.isArray(input.questions) ? input.questions : []
      if (questions.length === 0 || askUserPending.has(approvalId)) return

      askUserPending.set(approvalId, {
        input: input as {
          questions: Array<{
            question?: string
            header?: string
            options?: Array<{ label?: string; description?: string }>
          }>
          answers?: Record<string, unknown>
        },
        answers: { ...((input.answers as Record<string, unknown>) || {}) },
        qIndex: 0
      })

      const q = questions[0] as {
        question?: string
        header?: string
        options?: Array<{ label?: string; description?: string }>
      }
      const options = Array.isArray(q.options) ? q.options : []
      const circles = ['①', '②', '③', '④']
      let cardText = '💬 <b>请选择</b>'
      if (questions.length > 1) cardText += ` <i>(1/${questions.length})</i>`
      cardText += `\n\n${escHtml(q.question || q.header || '请选择')}`
      const rows: Array<Array<{ text: string; callback_data: string }>> = []
      for (let oi = 0; oi < options.length && oi < 4; oi++) {
        const label = String(options[oi].label || `选项${oi + 1}`).slice(0, 60)
        cardText += `\n\n<b>${circles[oi]}</b> ${escHtml(label)}`
        if (options[oi].description) {
          cardText += `\n<i>${escHtml(String(options[oi].description).slice(0, 120))}</i>`
        }
        rows.push([{ text: `${circles[oi]} ${label}`.slice(0, 64), callback_data: `asku:${approvalId}:${oi}` }])
      }
      void this.adapter
        .sendMessage(this.platformChatId, cardText, {
          ...this.responseOptions,
          parseMode: 'html',
          replyMarkup: { inline_keyboard: rows }
        })
        .catch((err) => logger.error('Failed to send AskUserQuestion card', { err }))
      return
    }

    if (!toolKey || toolKey === 'exitplanmode') return
    if (toolPermSent.has(approvalId)) return
    toolPermSent.add(approvalId)

    let cardText = `⚠️ <b>AI 申请操作权限</b>\n\n🔹 <b>工具</b>: <code>${escHtml(toolNameRaw || toolKey)}</code>`
    try {
      let detail = ''
      if (typeof input.command === 'string') detail = input.command
      else if (typeof input.file_path === 'string') detail = input.file_path
      else if (typeof input.path === 'string') detail = input.path
      else if (typeof input.filePath === 'string') detail = input.filePath
      else if (typeof input.url === 'string') detail = input.url
      else if (Object.keys(input).length > 0) detail = JSON.stringify(input)
      if (detail) {
        if (detail.length > 1500) detail = `${detail.slice(0, 1500)}\n... (已截断)`
        cardText += `\n🔹 <b>详情</b>:\n<pre>${escHtml(detail)}</pre>`
      }
    } catch {
      // ignore serialization failures
    }
    cardText += '\n\n请问是否授权该操作？'
    void this.adapter
      .sendMessage(this.platformChatId, cardText, {
        ...this.responseOptions,
        parseMode: 'html',
        replyMarkup: {
          inline_keyboard: [
            [
              { text: '✅ 允许', callback_data: `tapr:ok:${approvalId}` },
              { text: '❌ 拒绝', callback_data: `tapr:no:${approvalId}` }
            ]
          ]
        }
      })
      .catch((err) => logger.error('Failed to send tool permission card', { err }))
  }

  async onDone(result: StreamDoneResult): Promise<void> {
    const text = sanitizeChannelOutput(this.accumulatedText).text.trim()
    if (!text) {
      logger.warn('ChannelAdapterListener.onDone with empty text', {
        channelId: this.adapter.channelId,
        chatId: this.platformChatId,
        status: result.status
      })
      return
    }

    try {
      // Adapter finalizes its streaming UI first (e.g. close Feishu card).
      const handled = await this.completeStream(text)
      if (!handled) {
        await this.deliver(text)
      }
    } catch (err) {
      logger.error('Failed to deliver message to channel', {
        channelId: this.adapter.channelId,
        chatId: this.platformChatId,
        err
      })
    }
  }

  // oxlint-disable-next-line no-unused-vars
  async onPaused(_result: StreamPausedResult): Promise<void> {
    const text = sanitizeChannelOutput(this.accumulatedText).text.trim()
    if (!text) return

    try {
      const handled = await this.completeStream(text)
      if (!handled) {
        await this.deliver(text + '\n\n_(stopped)_')
      }
    } catch (err) {
      logger.error('Failed to deliver paused message to channel', {
        channelId: this.adapter.channelId,
        chatId: this.platformChatId,
        err
      })
    }
  }

  async onError(result: StreamErrorResult): Promise<void> {
    if (this.suppressErrorMessage) return
    try {
      await this.deliver(`Error: ${result.error.message ?? 'Unknown error'}`)
    } catch (err) {
      logger.error('Failed to deliver error to channel', {
        channelId: this.adapter.channelId,
        chatId: this.platformChatId,
        err
      })
    }
  }

  isAlive(): boolean {
    return this.adapter.connected
  }
}
