import { BUBBLE_MAX_CHARS, describeToolCall } from './toolBubbleDescribe'

export type TelegramBubbleApi = {
  sendMessage(text: string): Promise<number>
  editMessageText(messageId: number, text: string): Promise<void>
  deleteMessage(messageId: number): Promise<void>
}

export type TelegramBubbleLogger = {
  warn(message: string, meta?: Record<string, unknown>): void
  debug(message: string, meta?: Record<string, unknown>): void
}

type ActiveTool = {
  name: string
  description: string
}

export class TelegramToolBubbleController {
  private readonly activeTools = new Map<string, ActiveTool>()
  private bubbleMessageId: number | null = null
  private readonly allBubbleIds = new Set<number>()
  private lastCompletedToolDesc: string | null = null
  private bubbleActive = false
  private bubbleEpoch = 0
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private flushInProgress = false
  private reflushNeeded = false
  private dismissTimers: ReturnType<typeof setTimeout>[] = []
  private readonly scheduledBubbleSnapshot = new Set<number>()
  private readonly pendingBubbleDeletes = new Set<number>()

  private readonly debounceMs = 300
  private readonly dismissDelays = [1000, 3000, 9000, 30000]

  constructor(
    public readonly chatId: string,
    private readonly api: TelegramBubbleApi,
    private readonly log: TelegramBubbleLogger
  ) {}

  onStart(toolCallId: string, toolName: string, input?: unknown): void {
    const desc = describeToolCall(
      toolName,
      input && typeof input === 'object' ? (input as Record<string, unknown>) : null
    )

    if (!desc) {
      if (this.activeTools.has(toolCallId)) {
        this.activeTools.delete(toolCallId)
        this.scheduleBubbleUpdate()
      }
      return
    }

    this.bubbleActive = true
    this.activeTools.set(toolCallId, { name: toolName, description: desc })
    this.scheduleBubbleUpdate()
  }

  onDone(toolCallId: string): void {
    const active = this.activeTools.get(toolCallId)
    if (active) {
      this.lastCompletedToolDesc = active.description
      this.activeTools.delete(toolCallId)
      this.scheduleBubbleUpdate()
    }
  }

  private scheduleBubbleUpdate(): void {
    if (!this.bubbleActive) return
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      void this.flushBubble()
    }, this.debounceMs)
  }

  private composeBubbleText(): string | null {
    const lines: string[] = []
    for (const info of this.activeTools.values()) {
      if (info.description) {
        lines.push(`● ${info.description}`)
      }
    }

    let text: string
    if (lines.length === 0) {
      if (!this.lastCompletedToolDesc) return null
      text = `● ${this.lastCompletedToolDesc}`
    } else {
      text = lines.join('\n')
    }

    if (text.length > BUBBLE_MAX_CHARS) {
      text = `${text.slice(0, BUBBLE_MAX_CHARS - 1)}…`
    }
    return text
  }

  private trackBubbleMsg(messageId: number): void {
    this.bubbleMessageId = messageId
    this.allBubbleIds.add(messageId)
  }

  private untrackBubbleMsg(messageId: number): void {
    if (this.bubbleMessageId === messageId) {
      this.bubbleMessageId = null
    }
    this.allBubbleIds.delete(messageId)
  }

  private async flushBubble(): Promise<void> {
    this.debounceTimer = null
    if (!this.bubbleActive) return

    if (this.flushInProgress) {
      this.reflushNeeded = true
      return
    }

    this.flushInProgress = true
    const epochAtStart = this.bubbleEpoch

    try {
      const text = this.composeBubbleText()
      if (!text) return
      if (!this.bubbleActive || epochAtStart !== this.bubbleEpoch) return

      if (this.bubbleMessageId != null) {
        const msgId = this.bubbleMessageId
        try {
          await this.api.editMessageText(msgId, text)
          if (!this.bubbleActive || epochAtStart !== this.bubbleEpoch) {
            await this.api.deleteMessage(msgId).catch(() => {})
            this.untrackBubbleMsg(msgId)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (/message is not modified/i.test(msg)) {
            if (!this.bubbleActive || epochAtStart !== this.bubbleEpoch) {
              await this.api.deleteMessage(msgId).catch(() => {})
              this.untrackBubbleMsg(msgId)
            }
          } else if (/message to edit not found/i.test(msg)) {
            this.untrackBubbleMsg(msgId)
            if (this.bubbleActive && epochAtStart === this.bubbleEpoch) {
              try {
                const newId = await this.api.sendMessage(text)
                if (!this.bubbleActive || epochAtStart !== this.bubbleEpoch) {
                  await this.api.deleteMessage(newId).catch(() => {})
                } else {
                  this.trackBubbleMsg(newId)
                }
              } catch (sendErr) {
                this.log.warn('telegram-bubble: send after edit-miss failed', {
                  chatId: this.chatId,
                  error: sendErr instanceof Error ? sendErr.message : String(sendErr)
                })
              }
            }
          } else {
            this.log.warn('telegram-bubble: editMessageText failed', {
              chatId: this.chatId,
              messageId: msgId,
              error: msg
            })
          }
        }
      } else {
        try {
          const newId = await this.api.sendMessage(text)
          if (!this.bubbleActive || epochAtStart !== this.bubbleEpoch) {
            await this.api.deleteMessage(newId).catch(() => {})
          } else {
            this.trackBubbleMsg(newId)
          }
        } catch (sendErr) {
          this.log.warn('telegram-bubble: sendMessage failed', {
            chatId: this.chatId,
            error: sendErr instanceof Error ? sendErr.message : String(sendErr)
          })
        }
      }
    } finally {
      this.flushInProgress = false
      if (this.reflushNeeded && this.bubbleActive && epochAtStart === this.bubbleEpoch) {
        this.reflushNeeded = false
        this.scheduleBubbleUpdate()
      } else {
        this.reflushNeeded = false
      }
    }
  }

  async dismiss(immediate = false): Promise<void> {
    if (this.pendingBubbleDeletes.size > 0) {
      const retrySnapshot = new Set(this.pendingBubbleDeletes)
      void this.purgeSnapshot(retrySnapshot)
    }

    this.bubbleActive = false
    this.reflushNeeded = false
    this.bubbleEpoch += 1

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    this.activeTools.clear()
    this.lastCompletedToolDesc = null

    for (const t of this.dismissTimers) {
      clearTimeout(t)
    }
    this.dismissTimers = []

    for (const id of this.allBubbleIds) {
      this.scheduledBubbleSnapshot.add(id)
    }
    const snapshot = new Set(this.scheduledBubbleSnapshot)
    this.allBubbleIds.clear()
    this.bubbleMessageId = null

    if (immediate) {
      await this.purgeSnapshot(snapshot)
      return
    }

    for (const delay of this.dismissDelays) {
      this.dismissTimers.push(
        setTimeout(() => {
          void this.purgeSnapshot(snapshot)
        }, delay)
      )
    }
  }

  private async purgeSnapshot(snapshot: Set<number>): Promise<void> {
    if (!snapshot || snapshot.size === 0) return

    for (const msgId of [...snapshot]) {
      try {
        await this.api.deleteMessage(msgId)
        snapshot.delete(msgId)
        this.scheduledBubbleSnapshot.delete(msgId)
        this.pendingBubbleDeletes.delete(msgId)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/message to delete not found|message can't be deleted|message_id_invalid/i.test(msg)) {
          snapshot.delete(msgId)
          this.scheduledBubbleSnapshot.delete(msgId)
          this.pendingBubbleDeletes.delete(msgId)
        } else {
          this.pendingBubbleDeletes.add(msgId)
        }
      }
    }
  }

  dispose(): void {
    void this.dismiss(true)
  }
}
