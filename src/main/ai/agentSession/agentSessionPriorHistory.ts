import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { application } from '@application'
import { appStateTable } from '@data/db/schemas/appState'
import type { DbOrTx } from '@data/db/types'
import { agentSessionMessageService } from '@data/services/AgentSessionMessageService'
import type { AgentSessionMessageEntity } from '@shared/data/api/schemas/agentSessionMessages'
import { eq } from 'drizzle-orm'

const HISTORY_SEEDED_KEY_PREFIX = 'agentSession:historySeeded:'
const MAX_TRANSCRIPT_CHARS = 40_000

export function historySeededKey(sessionId: string, agentId: string): string {
  return `${HISTORY_SEEDED_KEY_PREFIX}${sessionId}:${agentId}`
}

export function hasPriorHistoryBeenSeeded(tx: Pick<DbOrTx, 'select'>, sessionId: string, agentId: string): boolean {
  const [row] = tx
    .select({ key: appStateTable.key })
    .from(appStateTable)
    .where(eq(appStateTable.key, historySeededKey(sessionId, agentId)))
    .limit(1)
    .all()

  return row !== undefined
}

export function markPriorHistorySeeded(
  tx: DbOrTx,
  sessionId: string,
  agentId: string,
  metadata?: Record<string, unknown>
): void {
  tx.insert(appStateTable)
    .values({
      key: historySeededKey(sessionId, agentId),
      value: { seededAt: Date.now(), ...(metadata ?? {}) }
    })
    .onConflictDoUpdate({
      target: appStateTable.key,
      set: {
        value: { seededAt: Date.now(), ...(metadata ?? {}) },
        updatedAt: Date.now()
      }
    })
    .run()
}

function extractTextFromParts(message: AgentSessionMessageEntity): string {
  return (
    message.data?.parts
      ?.filter((part): part is { type: 'text'; text: string } => part.type === 'text' && 'text' in part)
      .map((part) => part.text)
      .join('\n') ?? ''
  )
}

function extractAttachmentNames(message: AgentSessionMessageEntity): string[] {
  const names: string[] = []
  for (const part of message.data?.parts ?? []) {
    if (part.type === 'file') {
      if (part.filename) {
        names.push(part.filename)
      } else if (part.url?.startsWith('file://')) {
        try {
          names.push(path.basename(fileURLToPath(part.url)))
        } catch {
          names.push(part.url)
        }
      }
    }
  }
  return names
}

function formatMessageForTranscript(message: AgentSessionMessageEntity): string | null {
  const text = extractTextFromParts(message).trim()
  const attachments = extractAttachmentNames(message)
  if (!text && attachments.length === 0) return null

  const roleLabel = message.role === 'user' ? '【用户】' : '【智能体】'
  const attachmentLine = attachments.length > 0 ? `\n[附件: ${attachments.join(', ')}]` : ''

  return `${roleLabel}\n${text}${attachmentLine}`
}

export function buildPriorConversationTranscript(messages: readonly AgentSessionMessageEntity[]): string | null {
  const formatted: string[] = []
  for (const message of messages) {
    const item = formatMessageForTranscript(message)
    if (item) formatted.push(item)
  }
  if (formatted.length === 0) return null

  let totalChars = 0
  const selected: string[] = []
  for (let i = formatted.length - 1; i >= 0; i--) {
    const item = formatted[i]
    if (totalChars + item.length > MAX_TRANSCRIPT_CHARS && selected.length > 0) {
      selected.unshift('...\n[更早的历史对话已省略]\n...')
      break
    }
    selected.unshift(item)
    totalChars += item.length
  }

  return [
    '[系统上下文提示：以下为本会话此前在其他智能体中进行的历史对话记录。该会话现已移交给你，请基于以下历史背景继续协助用户：]',
    '',
    '<prior_conversation>',
    selected.join('\n\n'),
    '</prior_conversation>'
  ].join('\n')
}

export function prepareTurnMessageWithPriorHistory(input: {
  sessionId: string
  agentId: string
  userMessage: AgentSessionMessageEntity
}): AgentSessionMessageEntity {
  const db = application.get('DbService').getDb()
  if (hasPriorHistoryBeenSeeded(db, input.sessionId, input.agentId)) {
    return input.userMessage
  }

  // Fetch prior messages
  const page = agentSessionMessageService.listSessionMessages(input.sessionId, { limit: 100 })
  const priorMessages = page.items.filter((m) => m.id !== input.userMessage.id && m.status !== 'pending').reverse()

  // Always mark seeded so we do not repeat this check or injection on subsequent turns
  markPriorHistorySeeded(db, input.sessionId, input.agentId, {
    priorMessageCount: priorMessages.length
  })

  if (priorMessages.length === 0) {
    return input.userMessage
  }

  const transcript = buildPriorConversationTranscript(priorMessages)
  if (!transcript) {
    return input.userMessage
  }

  const parts = [...(input.userMessage.data?.parts ?? [])]
  const firstTextIndex = parts.findIndex((p) => p.type === 'text')
  if (firstTextIndex >= 0) {
    const originalText = (parts[firstTextIndex] as { type: 'text'; text: string }).text
    parts[firstTextIndex] = {
      type: 'text',
      text: `${transcript}\n\n${originalText}`
    }
  } else {
    parts.unshift({ type: 'text', text: transcript })
  }

  return {
    ...input.userMessage,
    data: {
      ...input.userMessage.data,
      parts
    }
  }
}
