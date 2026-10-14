import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { application } from '@application'
import {
  commitRetiredAgentSessionMigration,
  getRetiredAgentSessionMigration,
  listRetiredAgentSessionMigrations,
  readRetiredAgentSessionHistory
} from '@data/services/retiredAgentRuntimeMigration'
import { loggerService } from '@logger'
import { buildAgentUserContent } from '@main/ai/runtime/agentUserContent'
import { type RuntimeForkAnchor, RuntimeForkAnchorSchema } from '@main/ai/runtime/fork'
import type { AgentSessionMessageEntity } from '@shared/data/api/schemas/agentSessionMessages'

import { loadPiSdk } from './piSdk'

const logger = loggerService.withContext('retiredSessionHistory')
const pending = new Map<string, Promise<void>>()

export async function migrateRetiredSessionHistories(): Promise<void> {
  const db = application.get('DbService').getDb()
  for (const migration of listRetiredAgentSessionMigrations(db)) {
    try {
      await ensureRetiredSessionHistory(migration.sessionId)
    } catch (error) {
      logger.error('Retired session history migration remains pending', { sessionId: migration.sessionId, error })
    }
  }
}

/** A pending migration must never become a fresh Pi conversation, including on retry or fork. */
export function ensureRetiredSessionHistory(sessionId: string): Promise<void> {
  if (!getRetiredAgentSessionMigration(application.get('DbService').getDb(), sessionId)) return Promise.resolve()
  const existing = pending.get(sessionId)
  if (existing) return existing
  const migrating = importHistory(sessionId).finally(() => pending.delete(sessionId))
  pending.set(sessionId, migrating)
  return migrating
}

async function importHistory(sessionId: string): Promise<void> {
  const db = application.get('DbService').getDb()
  const migration = getRetiredAgentSessionMigration(db, sessionId)
  if (!migration) return
  const history = readRetiredAgentSessionHistory(db, sessionId)
  if (!history) {
    application
      .get('DbService')
      .withWriteTx((tx) => commitRetiredAgentSessionMigration(tx, migration, new Map(), history, new Set()))
    return
  }
  const sdk = await loadPiSdk()
  const manager = sdk.SessionManager.inMemory(history.workspacePath, { id: migration.resumeToken })
  const anchors = new Map<string, RuntimeForkAnchor>()
  const excludedMessageIds: string[] = []
  const pendingMessageIds = new Set<string>()
  const orderedMessages: typeof history.messages = []
  let queuedMessages: typeof history.messages = []
  let boundaryExclusions = new Set<string>()
  // Queued prompts are persisted before their assistant placeholders, so timestamps alone
  // cannot recover which prompts had entered the model context at a historical boundary.
  for (const row of history.messages) {
    if (row.role !== 'assistant') {
      queuedMessages.push(row)
      continue
    }
    const anchor = RuntimeForkAnchorSchema.safeParse(row.data.runtimeAnchor)
    boundaryExclusions = new Set(anchor.data?.excludedMessageIds ?? [])
    // Our DSH history records interrupted turns as `paused`/`error`; those prompts were already
    // consumed by DSH, so only a still-live assistant placeholder leaves its prompts pending.
    // Re-queueing them would silently re-send old prompts (and channel replies) on first resume.
    if ((row.status === 'pending' || row.status === 'streaming') && !anchor.success) {
      for (const message of queuedMessages) {
        if (message.role === 'user' && message.status === 'success' && !message.deliveryStatus) {
          pendingMessageIds.add(message.id)
        }
      }
    }
    orderedMessages.push(...queuedMessages.filter((message) => !boundaryExclusions.has(message.id)), row)
    queuedMessages = queuedMessages.filter((message) => boundaryExclusions.has(message.id))
  }
  // Saving a FIFO input is not a consumption receipt; keep unacknowledged tail inputs pending.
  for (const message of queuedMessages) {
    if (message.role === 'user' && message.status === 'success' && !message.deliveryStatus) {
      pendingMessageIds.add(message.id)
    }
  }
  orderedMessages.push(...queuedMessages.filter((message) => !boundaryExclusions.has(message.id)))
  const isExcluded = (row: (typeof orderedMessages)[number]) =>
    pendingMessageIds.has(row.id) ||
    row.status === 'pending' ||
    row.status === 'streaming' ||
    Boolean(row.deliveryStatus && row.deliveryStatus !== 'consumed')
  const texts = new Map<string, string>()
  for (const row of orderedMessages) if (!isExcluded(row)) texts.set(row.id, historicalText(row))
  const importStart = resolveImportStart(orderedMessages, texts)
  let omissionNoted = false
  for (const [index, row] of orderedMessages.entries()) {
    if (isExcluded(row)) {
      excludedMessageIds.push(row.id)
      continue
    }
    // Earlier rows were already compacted by DSH or exceed the import budget: they stay visible in
    // Cherry but enter the model context only through this note (and are not fork points).
    if (index < importStart) continue
    if (!omissionNoted && importStart > 0) {
      omissionNoted = true
      manager.appendCustomMessageEntry(
        'cherry-history',
        `[Imported from the retired DSH runtime] ${importStart} earlier messages of this conversation are ` +
          'omitted here (already compacted by DSH or beyond the import budget). They remain visible in the ' +
          'Cherry transcript; ask the user if earlier details are needed.',
        false
      )
    }
    const text = texts.get(row.id) ?? ''
    if (text && row.role === 'user') {
      manager.appendMessage({ role: 'user', content: [{ type: 'text', text }], timestamp: row.createdAt })
    } else if (text && row.role === 'assistant') {
      manager.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text }],
        timestamp: row.createdAt,
        api: 'openai-completions',
        provider: 'cherry-history',
        model: 'imported-history',
        stopReason: 'stop',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        }
      })
    } else if (text) {
      manager.appendCustomMessageEntry('cherry-history', text, false)
    }
    const leafId = manager.getLeafId()
    if (leafId && row.role === 'assistant') {
      anchors.set(row.id, {
        checkpoint: { runtime: 'pi', runtimeSessionId: migration.resumeToken, leafId },
        excludedMessageIds: [
          ...new Set([
            ...excludedMessageIds,
            ...(RuntimeForkAnchorSchema.safeParse(row.data.runtimeAnchor).data?.excludedMessageIds ?? [])
          ])
        ]
      })
    }
  }
  const sessions = application.getPath('feature.agents.pi.sessions')
  await mkdir(sessions, { recursive: true })
  const file = path.join(sessions, `1970-01-01T00-00-00-000Z_${migration.resumeToken}.jsonl`)
  const temporary = `${file}.tmp`
  try {
    await writeFile(
      temporary,
      [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      { mode: 0o600 }
    )
    const reopened = sdk.SessionManager.open(temporary, sessions, history.workspacePath)
    if (
      reopened.getSessionId() !== migration.resumeToken ||
      reopened.getEntries().length !== manager.getEntries().length
    ) {
      throw new Error('Retired session history validation failed')
    }
    await rename(temporary, file)
    application
      .get('DbService')
      .withWriteTx((tx) => commitRetiredAgentSessionMigration(tx, migration, anchors, history, pendingMessageIds))
  } finally {
    await rm(temporary, { force: true })
  }
}

/** ~75-100K tokens: leaves the Pi model room to work; Pi's own compaction takes over from here. */
const HISTORY_CHAR_BUDGET = 300_000
const TOOL_RECORD_MAX_CHARS = 1_200

type HistoryRow = NonNullable<ReturnType<typeof readRetiredAgentSessionHistory>>['messages'][number]

function historicalText(row: HistoryRow): string {
  const content = buildAgentUserContent({
    ...row,
    role: row.role as AgentSessionMessageEntity['role'],
    status: row.status as AgentSessionMessageEntity['status'],
    delivery:
      row.delivery && row.deliveryStatus
        ? {
            ...row.delivery,
            status: row.deliveryStatus,
            inReplyTo: row.deliveryInReplyTo,
            turnRef: row.deliveryTurnRef
          }
        : null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString()
  })
  const tools = (row.data.parts ?? []).flatMap((part) => {
    if (part.type !== 'dynamic-tool' && !part.type.startsWith('tool-')) return []
    return [summarizeToolPart(part as unknown as Record<string, unknown>)]
  })
  return [content, ...tools.map((tool) => `Historical tool record (already executed):\n${tool}`)]
    .filter(Boolean)
    .join('\n\n')
}

/** Full DSH tool payloads (file dumps, browser snapshots) would blow far past any context window. */
function summarizeToolPart(part: Record<string, unknown>): string {
  const json = JSON.stringify({
    tool: part.toolName ?? part.type,
    state: part.state,
    input: part.input,
    output: part.output ?? part.errorText
  })
  return json.length > TOOL_RECORD_MAX_CHARS
    ? `${json.slice(0, TOOL_RECORD_MAX_CHARS)}… [truncated ${json.length - TOOL_RECORD_MAX_CHARS} chars]`
    : json
}

/** First row to import verbatim: after DSH's last completed compaction, then trimmed to the char budget. */
function resolveImportStart(rows: readonly HistoryRow[], texts: ReadonlyMap<string, string>): number {
  let start = 0
  rows.forEach((row, index) => {
    const compacted = (row.data.parts ?? []).some(
      (part) =>
        part.type === 'data-compaction-anchor' &&
        (part as unknown as { data?: { status?: string } }).data?.status === 'done'
    )
    if (compacted) start = index + 1
  })
  let remaining = HISTORY_CHAR_BUDGET
  let budgetStart = rows.length
  for (let index = rows.length - 1; index >= start; index--) {
    const size = texts.get(rows[index].id)?.length ?? 0
    if (size > remaining && budgetStart < rows.length) break
    remaining -= size
    budgetStart = index
  }
  return Math.max(start, budgetStart)
}
