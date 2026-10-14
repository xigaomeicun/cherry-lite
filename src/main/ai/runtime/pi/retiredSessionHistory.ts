import { createHash } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { application } from '@application'
import {
  commitRetiredAgentSessionMigration,
  commitRetiredSessionHistoryRepair,
  getRetiredAgentSessionMigration,
  getRetiredSessionHistoryVersion,
  isRetiredSessionHistoryRepairDone,
  listAgentSessionIds,
  listRetiredAgentSessionMigrations,
  markRetiredSessionHistoryCurrent,
  markRetiredSessionHistoryRepairDone,
  readRetiredAgentSessionHistory,
  RETIRED_SESSION_HISTORY_VERSION
} from '@data/services/retiredAgentRuntimeMigration'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { loggerService } from '@logger'
import { buildAgentUserContent } from '@main/ai/runtime/agentUserContent'
import { type RuntimeForkAnchor, RuntimeForkAnchorSchema } from '@main/ai/runtime/fork'
import type { AgentSessionMessageEntity } from '@shared/data/api/schemas/agentSessionMessages'

import { loadPiSdk } from './piSdk'
import { resolveResumeTokenSessionFile } from './piSessionFile'
import { readRetiredDshCompactionSummary, type RetiredDshCompactionSummary } from './retiredDshSummary'

const logger = loggerService.withContext('retiredSessionHistory')
const pending = new Map<string, Promise<void>>()

/** ~75-100K tokens: leaves the Pi model room to work; Pi's own compaction takes over from here. */
const HISTORY_CHAR_BUDGET = 300_000
const TOOL_FIELD_MAX_CHARS = 600
const IMPORT_SOURCE = 'cherry-history'
const IMPORT_FILE_PREFIX = '1970-01-01T00-00-00-000Z_'
/** A DSH summary and a Cherry compaction anchor describe the same compaction within this window. */
const COMPACTION_MATCH_WINDOW_MS = 60_000

type HistoryRow = NonNullable<ReturnType<typeof readRetiredAgentSessionHistory>>['messages'][number]
type PiSdk = Awaited<ReturnType<typeof loadPiSdk>>
type PiEntry = SessionEntry

export async function migrateRetiredSessionHistories(): Promise<void> {
  const db = application.get('DbService').getDb()
  for (const migration of listRetiredAgentSessionMigrations(db)) {
    try {
      await ensureRetiredSessionHistory(migration.sessionId)
    } catch (error) {
      logger.error('Retired session history migration remains pending', { sessionId: migration.sessionId, error })
    }
  }
  if (isRetiredSessionHistoryRepairDone(db)) return
  let failed = false
  for (const sessionId of listAgentSessionIds(db)) {
    try {
      await ensureRetiredSessionHistory(sessionId)
    } catch (error) {
      failed = true
      logger.error('Retired session history repair remains pending', { sessionId, error })
    }
  }
  if (!failed && listRetiredAgentSessionMigrations(db).length === 0) {
    application.get('DbService').withWriteTx((tx) => markRetiredSessionHistoryRepairDone(tx))
  }
}

/**
 * A pending migration must never become a fresh Pi conversation, including on retry or fork.
 * Sessions imported by an older version are rebuilt once (keyed by the history version marker).
 */
export function ensureRetiredSessionHistory(sessionId: string): Promise<void> {
  const db = application.get('DbService').getDb()
  const run = getRetiredAgentSessionMigration(db, sessionId)
    ? importHistory
    : !isRetiredSessionHistoryRepairDone(db) &&
        (getRetiredSessionHistoryVersion(db, sessionId) ?? 0) < RETIRED_SESSION_HISTORY_VERSION
      ? repairHistory
      : undefined
  if (!run) return Promise.resolve()
  const existing = pending.get(sessionId)
  if (existing) return existing
  const running = run(sessionId).finally(() => pending.delete(sessionId))
  pending.set(sessionId, running)
  return running
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
  const summary = await readSummary(history.workspacePath, history.messages)
  const built = buildImport(sdk, history.workspacePath, migration.resumeToken, history.messages, summary, new Set())
  const sessions = application.getPath('feature.agents.pi.sessions')
  await mkdir(sessions, { recursive: true })
  const file = path.join(sessions, `${IMPORT_FILE_PREFIX}${migration.resumeToken}.jsonl`)
  const header = sdk.SessionManager.inMemory(history.workspacePath, { id: migration.resumeToken }).getHeader()
  await writeValidated(sdk, file, sessions, history.workspacePath, migration.resumeToken, [header, ...built.entries])
  application
    .get('DbService')
    .withWriteTx((tx) =>
      commitRetiredAgentSessionMigration(
        tx,
        migration,
        built.anchors,
        history,
        built.pendingMessageIds,
        built.omittedMessageIds
      )
    )
  logger.info('Imported retired session history', { sessionId, ...built.stats })
}

function isImportedEntry(entry: PiEntry): boolean {
  if (entry.type === 'custom_message') return entry.customType === IMPORT_SOURCE
  return (
    entry.type === 'message' &&
    entry.message.role === 'assistant' &&
    (entry.message as { provider?: string }).provider === IMPORT_SOURCE
  )
}

/**
 * Rebuild the imported prefix of an already-migrated session from the full Cherry transcript
 * (never from the current Pi prefix), keeping every Pi entry appended after the import untouched
 * except for re-parenting onto the rebuilt prefix. Entry ids are deterministic, so a crash between
 * the file rename and the database commit is repaired identically on retry.
 */
async function repairHistory(sessionId: string): Promise<void> {
  const dbService = application.get('DbService')
  const db = dbService.getDb()
  if ((getRetiredSessionHistoryVersion(db, sessionId) ?? 0) >= RETIRED_SESSION_HISTORY_VERSION) return
  const history = readRetiredAgentSessionHistory(db, sessionId)
  if (!history) return
  const markCurrent = () => dbService.withWriteTx((tx) => markRetiredSessionHistoryCurrent(tx, sessionId))
  const token = history.messages.findLast((row) => row.runtimeResumeToken)?.runtimeResumeToken
  if (!token) return markCurrent()
  const sessions = application.getPath('feature.agents.pi.sessions')
  const file = resolveResumeTokenSessionFile(token, sessions)
  if (!file) return markCurrent()
  const sdk = await loadPiSdk()
  const current = sdk.SessionManager.open(file, sessions, history.workspacePath)
  const header = current.getHeader()
  const entries = current.getEntries()
  let last = entries.findLastIndex(isImportedEntry)
  // v1 may have imported nothing (e.g. the session ended on a DSH compaction); its file is still ours.
  if (!header || (last < 0 && !path.basename(file).startsWith(IMPORT_FILE_PREFIX))) return markCurrent()

  const rowByLeaf = new Map<string, HistoryRow>()
  for (const row of history.messages) {
    const anchor = RuntimeForkAnchorSchema.safeParse(row.data.runtimeAnchor)
    const checkpoint = anchor.data?.checkpoint as { runtime?: string; runtimeSessionId?: string; leafId?: string }
    if (checkpoint?.runtime === 'pi' && checkpoint.runtimeSessionId === token && checkpoint.leafId)
      rowByLeaf.set(checkpoint.leafId, row)
  }
  // The first assistant row anchored after the imported prefix starts the post-migration turns.
  let cutoff = Number.POSITIVE_INFINITY
  for (const entry of entries.slice(last + 1)) {
    const row = rowByLeaf.get(entry.id)
    if (row?.role === 'assistant') cutoff = Math.min(cutoff, row.createdAt)
  }
  // An import may end with a user prompt whose reply had no text; it carries its row's timestamp.
  const importedUserTimes = new Set(
    history.messages.filter((row) => row.role === 'user' && row.createdAt < cutoff).map((row) => row.createdAt)
  )
  while (last + 1 < entries.length) {
    const next = entries[last + 1]
    if (
      next.type !== 'message' ||
      next.message.role !== 'user' ||
      !importedUserTimes.has((next.message as { timestamp?: number }).timestamp ?? -1)
    )
      break
    last++
  }
  const prefixIds = new Set(entries.slice(0, last + 1).map((entry) => entry.id))
  const tail = entries.slice(last + 1)
  const importedRows = history.messages.filter((row) => row.createdAt < cutoff)
  const summary = await readSummary(history.workspacePath, importedRows)
  const built = buildImport(
    sdk,
    history.workspacePath,
    token,
    importedRows,
    summary,
    new Set(tail.map((entry) => entry.id))
  )
  const newIds = new Set(built.entries.map((entry) => entry.id))
  const newLeaf = built.entries.at(-1)?.id ?? null
  const remap = (id: string | null | undefined, fallback: string | null) => {
    if (!id || !prefixIds.has(id) || newIds.has(id)) return id
    const row = rowByLeaf.get(id)
    const mapped = row ? built.anchors.get(row.id)?.checkpoint : undefined
    return (mapped as { leafId?: string } | undefined)?.leafId ?? fallback
  }
  const remapped = tail.map((entry) => {
    const copy = { ...entry } as PiEntry & Record<string, unknown>
    copy.parentId = remap(entry.parentId, newLeaf) ?? null
    if (typeof copy.firstKeptEntryId === 'string')
      copy.firstKeptEntryId = remap(copy.firstKeptEntryId, built.entries[0]?.id ?? newLeaf)
    if (typeof copy.targetId === 'string') copy.targetId = remap(copy.targetId, newLeaf)
    if (typeof copy.fromId === 'string') copy.fromId = remap(copy.fromId, newLeaf)
    return copy as PiEntry
  })
  await writeValidated(sdk, file, sessions, history.workspacePath, token, [header, ...built.entries, ...remapped])
  dbService.withWriteTx((tx) =>
    commitRetiredSessionHistoryRepair(
      tx,
      sessionId,
      new Set(importedRows.map((row) => row.id)),
      built.anchors,
      built.omittedMessageIds,
      history
    )
  )
  logger.info('Rebuilt retired session history', {
    sessionId,
    preservedEntries: tail.length,
    replacedEntries: prefixIds.size,
    ...built.stats
  })
}

async function writeValidated(
  sdk: PiSdk,
  file: string,
  sessions: string,
  cwd: string,
  sessionId: string,
  lines: readonly unknown[]
): Promise<void> {
  const temporary = `${file}.tmp`
  try {
    await writeFile(temporary, lines.map((entry) => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 })
    const reopened = sdk.SessionManager.open(temporary, sessions, cwd)
    reopened.buildContextEntries()
    if (reopened.getSessionId() !== sessionId || reopened.getEntries().length !== lines.length - 1) {
      throw new Error('Retired session history validation failed')
    }
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function readSummary(
  workspacePath: string,
  rows: readonly HistoryRow[]
): Promise<RetiredDshCompactionSummary | undefined> {
  const preferred = new Set<string>()
  for (const row of rows) {
    if (row.runtimeResumeToken) preferred.add(row.runtimeResumeToken)
    if (typeof row.data.nativeSessionId === 'string') preferred.add(row.data.nativeSessionId)
  }
  try {
    return await readRetiredDshCompactionSummary(
      application.getPath('feature.agents.dsh.sessions'),
      workspacePath,
      preferred
    )
  } catch (error) {
    logger.warn('Retired DSH compaction summary unavailable', { workspacePath, error })
    return undefined
  }
}

interface ImportBuild {
  entries: PiEntry[]
  anchors: Map<string, RuntimeForkAnchor>
  pendingMessageIds: Set<string>
  omittedMessageIds: Set<string>
  stats: {
    contextChars: number
    importedRows: number
    omittedRows: number
    summaryChars: number
    truncatedChars: number
  }
}

/** Queued prompts are persisted before their assistant placeholders, so order them by boundary. */
function orderHistory(rows: readonly HistoryRow[]) {
  const pendingMessageIds = new Set<string>()
  const ordered: HistoryRow[] = []
  let queued: HistoryRow[] = []
  let boundaryExclusions = new Set<string>()
  for (const row of rows) {
    if (row.role !== 'assistant') {
      queued.push(row)
      continue
    }
    const anchor = RuntimeForkAnchorSchema.safeParse(row.data.runtimeAnchor)
    boundaryExclusions = new Set(anchor.data?.excludedMessageIds ?? [])
    // Our DSH history records interrupted turns as `paused`/`error`; those prompts were already
    // consumed by DSH, so only a still-live assistant placeholder leaves its prompts pending.
    // Re-queueing them would silently re-send old prompts (and channel replies) on first resume.
    if ((row.status === 'pending' || row.status === 'streaming') && !anchor.success) {
      for (const message of queued) {
        if (message.role === 'user' && message.status === 'success' && !message.deliveryStatus) {
          pendingMessageIds.add(message.id)
        }
      }
    }
    ordered.push(...queued.filter((message) => !boundaryExclusions.has(message.id)), row)
    queued = queued.filter((message) => boundaryExclusions.has(message.id))
  }
  // Saving a FIFO input is not a consumption receipt; keep unacknowledged tail inputs pending.
  for (const message of queued) {
    if (message.role === 'user' && message.status === 'success' && !message.deliveryStatus) {
      pendingMessageIds.add(message.id)
    }
  }
  ordered.push(...queued.filter((message) => !boundaryExclusions.has(message.id)))
  const isExcluded = (row: HistoryRow) =>
    pendingMessageIds.has(row.id) ||
    row.status === 'pending' ||
    row.status === 'streaming' ||
    Boolean(row.deliveryStatus && row.deliveryStatus !== 'consumed')
  return { ordered, pendingMessageIds, isExcluded }
}

interface CompactionAnchor {
  rowIndex: number
  partIndex: number
  partCount: number
  completedAt?: number
  preTokens?: number
  postTokens?: number
}

function lastDoneCompactionAnchor(rows: readonly HistoryRow[]): CompactionAnchor | undefined {
  let found: CompactionAnchor | undefined
  rows.forEach((row, rowIndex) => {
    const parts = row.data.parts ?? []
    parts.forEach((part, partIndex) => {
      if (part.type !== 'data-compaction-anchor') return
      // `compacting` / `skipped` anchors did not replace the model context.
      const data = (part as unknown as { data?: Record<string, unknown> }).data
      if (data?.status !== 'done') return
      const completedAt = typeof data.completedAt === 'string' ? Date.parse(data.completedAt) : Number.NaN
      found = {
        rowIndex,
        partIndex,
        partCount: parts.length,
        completedAt: Number.isFinite(completedAt) ? completedAt : undefined,
        preTokens: typeof data.preTokens === 'number' ? data.preTokens : undefined,
        postTokens: typeof data.postTokens === 'number' ? data.postTokens : undefined
      }
    })
  })
  return found
}

function sameCompaction(summary: RetiredDshCompactionSummary, anchor: CompactionAnchor): boolean {
  if (anchor.completedAt !== undefined && Math.abs(summary.time - anchor.completedAt) <= COMPACTION_MATCH_WINDOW_MS)
    return true
  return (
    anchor.preTokens !== undefined &&
    anchor.preTokens === summary.preTokens &&
    anchor.postTokens !== undefined &&
    anchor.postTokens === summary.postTokens
  )
}

/**
 * Where verbatim import starts. With a matching DSH summary (or only a Cherry anchor), it starts
 * right after the anchor part — the anchor is often pushed into the in-progress assistant turn, so
 * the parts after it in the same row are post-compaction content. A DSH summary newer than every
 * Cherry anchor (DSH compacted without Cherry recording it) starts at the first row still updated
 * after that compaction.
 */
function resolveBoundary(
  rows: readonly HistoryRow[],
  summary: RetiredDshCompactionSummary | undefined
): { rowIndex: number; partStart: number; summary?: RetiredDshCompactionSummary } {
  const anchor = lastDoneCompactionAnchor(rows)
  const afterAnchor = (usable?: RetiredDshCompactionSummary) =>
    anchor!.partIndex >= anchor!.partCount - 1
      ? { rowIndex: anchor!.rowIndex + 1, partStart: 0, summary: usable }
      : { rowIndex: anchor!.rowIndex, partStart: anchor!.partIndex + 1, summary: usable }
  if (summary && anchor && sameCompaction(summary, anchor)) return afterAnchor(summary)
  if (summary && (!anchor || (anchor.completedAt !== undefined && summary.time > anchor.completedAt))) {
    const index = rows.findIndex((row) => row.updatedAt >= summary.time)
    return { rowIndex: index < 0 ? rows.length : index, partStart: 0, summary }
  }
  if (anchor) return afterAnchor()
  return { rowIndex: 0, partStart: 0 }
}

function buildImport(
  sdk: PiSdk,
  cwd: string,
  token: string,
  rows: readonly HistoryRow[],
  dshSummary: RetiredDshCompactionSummary | undefined,
  reservedIds: ReadonlySet<string>
): ImportBuild {
  const { ordered, pendingMessageIds, isExcluded } = orderHistory(rows)
  const boundary = resolveBoundary(ordered, dshSummary)
  const summary = boundary.summary
  const summaryText = summary ? summaryEntryText(summary) : ''

  // Build text from the tail backwards and stop once the budget is full: earlier rows are never
  // stringified.
  let remaining = HISTORY_CHAR_BUDGET - summaryText.length
  const texts = new Map<string, string>()
  let windowStart = ordered.length
  let truncatedChars = 0
  for (let index = ordered.length - 1; index >= boundary.rowIndex; index--) {
    const row = ordered[index]
    if (isExcluded(row)) continue
    let text = historicalText(row, index === boundary.rowIndex ? boundary.partStart : 0)
    if (text.length > remaining) {
      if (texts.size > 0 && [...texts.values()].some(Boolean)) break
      const keep = Math.max(0, remaining)
      truncatedChars = text.length - keep
      text =
        `[Imported from the retired DSH runtime: the first ${truncatedChars} characters of this message were ` +
        `truncated to fit the import budget]\n\n${text.slice(text.length - keep)}`
      texts.set(row.id, text)
      windowStart = index
      break
    }
    remaining -= text.length
    texts.set(row.id, text)
    windowStart = index
  }

  const omittedMessageIds = new Set<string>()
  for (const [index, row] of ordered.entries())
    if (index < windowStart && !isExcluded(row)) omittedMessageIds.add(row.id)
  const partialBoundary = windowStart === boundary.rowIndex && boundary.partStart > 0

  const manager = sdk.SessionManager.inMemory(cwd, { id: token })
  if (summary) {
    manager.appendCustomMessageEntry(IMPORT_SOURCE, summaryText, false, {
      source: 'dsh-compaction-summary',
      compactionId: summary.compactionId,
      dshSessionId: summary.dshSessionId
    })
  }
  if (omittedMessageIds.size > 0 || partialBoundary) {
    manager.appendCustomMessageEntry(IMPORT_SOURCE, omissionNote(omittedMessageIds.size, Boolean(summary)), false)
  }
  const leafByRow = new Map<string, string>()
  for (const [index, row] of ordered.entries()) {
    if (isExcluded(row) || index < windowStart) continue
    const text = texts.get(row.id) ?? ''
    if (text && row.role === 'user') {
      manager.appendMessage({ role: 'user', content: [{ type: 'text', text }], timestamp: row.createdAt })
    } else if (text && row.role === 'assistant') {
      manager.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text }],
        timestamp: row.createdAt,
        api: 'openai-completions',
        provider: IMPORT_SOURCE,
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
      manager.appendCustomMessageEntry(IMPORT_SOURCE, text, false)
    }
    const leafId = manager.getLeafId()
    if (leafId && row.role === 'assistant') leafByRow.set(row.id, leafId)
  }

  // Deterministic ids keep a retried rebuild identical and never collide with preserved entries.
  const idMap = new Map<string, string>()
  const used = new Set(reservedIds)
  const entries = manager.getEntries().map((entry, index) => {
    let attempt = 0
    let id: string
    do {
      id = createHash('sha256').update(`${token}\0retired-import-v2\0${index}\0${attempt++}`).digest('hex').slice(0, 8)
    } while (used.has(id))
    used.add(id)
    idMap.set(entry.id, id)
    return { ...entry, id, parentId: entry.parentId ? (idMap.get(entry.parentId) ?? null) : null } as PiEntry
  })

  const anchors = new Map<string, RuntimeForkAnchor>()
  const cumulativeExcluded: string[] = []
  for (const row of ordered) {
    if (isExcluded(row)) {
      cumulativeExcluded.push(row.id)
      continue
    }
    const leafId = leafByRow.get(row.id)
    if (!leafId) continue
    anchors.set(row.id, {
      checkpoint: { runtime: 'pi', runtimeSessionId: token, leafId: idMap.get(leafId)! },
      excludedMessageIds: [
        ...new Set([
          ...cumulativeExcluded,
          ...(RuntimeForkAnchorSchema.safeParse(row.data.runtimeAnchor).data?.excludedMessageIds ?? [])
        ])
      ]
    })
  }
  const contextChars = summaryText.length + [...texts.values()].reduce((total, text) => total + text.length, 0)
  return {
    entries,
    anchors,
    pendingMessageIds,
    omittedMessageIds,
    stats: {
      contextChars,
      importedRows: texts.size,
      omittedRows: omittedMessageIds.size,
      summaryChars: summaryText.length,
      truncatedChars
    }
  }
}

function summaryEntryText(summary: RetiredDshCompactionSummary): string {
  return (
    '[DSH-retained compaction summary — imported from the retired DSH runtime]\n' +
    `The DSH runtime wrote this summary when it compacted the earlier part of this conversation ` +
    `(compaction ${summary.compactionId || 'unknown'}, ${new Date(summary.time).toISOString()}). ` +
    'It is historical context recorded by the previous runtime, not a message from the user.\n\n' +
    `<dsh-compaction-summary>\n${summary.text}\n</dsh-compaction-summary>`
  )
}

function omissionNote(count: number, hasSummary: boolean): string {
  return hasSummary
    ? `[Imported from the retired DSH runtime] ${count} earlier messages of this conversation are omitted here: ` +
        'they precede the DSH compaction summarized above (or exceed the import budget). They remain visible ' +
        'in the Cherry transcript; ask the user if exact earlier details are needed.'
    : `[Imported from the retired DSH runtime] ${count} earlier messages of this conversation are omitted here. ` +
        'That earlier conversation exists only in the Cherry records; no compaction summary of it is available ' +
        'in this context. Ask the user if earlier details are needed.'
}

function historicalText(row: HistoryRow, partStart = 0): string {
  const parts = (row.data.parts ?? []).slice(partStart)
  const content = buildAgentUserContent({
    ...row,
    data: { ...row.data, parts },
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
  } as AgentSessionMessageEntity)
  const tools = parts.flatMap((part) => {
    if (part.type !== 'dynamic-tool' && !part.type.startsWith('tool-')) return []
    return [summarizeToolPart(part as unknown as Record<string, unknown>)]
  })
  return [content, ...tools.map((tool) => `Historical tool record (already executed):\n${tool}`)]
    .filter(Boolean)
    .join('\n\n')
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated ${text.length - max} chars]` : text
}

/** Bounded per field before serializing: full DSH payloads (file dumps, snapshots) are huge. */
function clipField(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return clipText(value, TOOL_FIELD_MAX_CHARS)
  let budget = TOOL_FIELD_MAX_CHARS * 2
  const serialized = JSON.stringify(value, (_key, nested: unknown) => {
    if (budget <= 0) return undefined
    if (typeof nested === 'string') {
      const clipped = clipText(nested, Math.min(TOOL_FIELD_MAX_CHARS, Math.max(budget, 16)))
      budget -= clipped.length
      return clipped
    }
    if (Array.isArray(nested) && nested.length > 20) return [...nested.slice(0, 20), `… ${nested.length - 20} more`]
    return nested
  })
  return serialized === undefined ? undefined : clipText(serialized, TOOL_FIELD_MAX_CHARS)
}

function summarizeToolPart(part: Record<string, unknown>): string {
  return JSON.stringify({
    tool: part.toolName ?? part.type,
    state: part.state,
    input: clipField(part.input),
    output: clipField(part.output),
    errorText: clipField(part.errorText)
  })
}
