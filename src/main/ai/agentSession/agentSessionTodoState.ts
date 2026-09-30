import { application } from '@application'
import { appStateTable } from '@data/db/schemas/appState'
import { agentSessionMessageService } from '@data/services/AgentSessionMessageService'
import { loggerService } from '@logger'
import type { AgentSessionMessageEntity } from '@shared/data/api/schemas/agentSessionMessages'
import { eq } from 'drizzle-orm'

const logger = loggerService.withContext('AgentSessionTodoState')

/** One `app_state` row per Session; newest state wins, so the key carries no revision. */
const TODO_STATE_KEY_PREFIX = 'agentSession:todoState:'
/** A reminder longer than the list itself stops being read; cap the enumeration. */
const MAX_REMINDER_ITEMS = 12
const MAX_REMINDER_CONTENT = 160

export type AgentTodoStatus = 'pending' | 'in_progress' | 'completed'

export interface AgentTodoItem {
  content: string
  status: AgentTodoStatus
}

/** Host-owned mirror of the model's task list, so a turn can never end silently on an open list. */
export interface AgentTodoState {
  items: AgentTodoItem[]
  /** When the model last rewrote the list. */
  updatedAt: number
  /** Unfinished items when the last turn ended; `0` means the list was closed. */
  unclosed: number
  unclosedAt?: number
}

export function todoStateKey(sessionId: string): string {
  return `${TODO_STATE_KEY_PREFIX}${sessionId}`
}

/**
 * Tool names arrive normalized differently per runtime (`todo_write` from DSH, `TodoWrite` from the
 * Claude Code SDK) and a future upstream may rewrite the separator, so compare without punctuation.
 */
export function isTodoToolName(name: unknown): boolean {
  return typeof name === 'string' && name.toLowerCase().replace(/[^a-z]/g, '') === 'todowrite'
}

function normalizeStatus(raw: unknown): AgentTodoStatus {
  if (raw === 'completed' || raw === 'done') return 'completed'
  if (raw === 'in_progress' || raw === 'in-progress' || raw === 'running') return 'in_progress'
  // Unknown values stay open on purpose: a status we cannot read must never look like progress.
  return 'pending'
}

/** The newest todo list carried by one message, or `null` when it wrote no list. */
export function readTodoSnapshotFromParts(parts: unknown): AgentTodoItem[] | null {
  if (!Array.isArray(parts)) return null
  let snapshot: AgentTodoItem[] | null = null
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const candidate = part as { toolName?: unknown; type?: unknown; state?: unknown; input?: unknown }
    if (candidate.type !== 'dynamic-tool' && candidate.type !== 'tool') continue
    if (candidate.state !== 'output-available') continue
    if (!isTodoToolName(candidate.toolName)) continue
    const input = candidate.input
    if (!input || typeof input !== 'object' || !Array.isArray((input as { todos?: unknown }).todos)) continue
    const items: AgentTodoItem[] = []
    for (const todo of (input as { todos: unknown[] }).todos) {
      if (!todo || typeof todo !== 'object') continue
      const content = (todo as { content?: unknown }).content
      if (typeof content !== 'string' || !content.trim()) continue
      items.push({ content: content.trim(), status: normalizeStatus((todo as { status?: unknown }).status) })
    }
    snapshot = items
  }
  return snapshot
}

export function unfinishedTodos(items: readonly AgentTodoItem[]): AgentTodoItem[] {
  return items.filter((item) => item.status !== 'completed')
}

function truncate(text: string): string {
  return text.length > MAX_REMINDER_CONTENT ? `${text.slice(0, MAX_REMINDER_CONTENT - 1)}…` : text
}

/**
 * Injected at the front of every turn whose list is still open. Written for the model, not the
 * user: it names the exact closing moves so "leave it pending and report done" stops being an
 * option the harness tolerates.
 */
export function buildUnfinishedTodoReminder(state: AgentTodoState): string | null {
  const open = unfinishedTodos(state.items)
  if (open.length === 0) return null
  const listed = open.slice(0, MAX_REMINDER_ITEMS).map((item) => `- [${item.status}] ${truncate(item.content)}`)
  if (open.length > listed.length) listed.push(`- …另有 ${open.length - listed.length} 项`)
  return [
    '<unfinished_todos>',
    `上一轮结束时，任务清单仍有 ${open.length} 项未闭环（清单共 ${state.items.length} 项）。`,
    '在结束本轮之前必须处理它们：已完成 → 标 completed；不再需要 → 从清单里删掉（＝显式放弃）；',
    '绝不允许留着 pending / in_progress 就宣称完成。清单是最新状态，不要凭记忆重建。',
    ...listed,
    '</unfinished_todos>'
  ].join('\n')
}

export function readTodoState(sessionId: string): AgentTodoState | null {
  const [row] = application
    .get('DbService')
    .getDb()
    .select({ value: appStateTable.value })
    .from(appStateTable)
    .where(eq(appStateTable.key, todoStateKey(sessionId)))
    .limit(1)
    .all()
  if (!row || !row.value || typeof row.value !== 'object') return null
  const value = row.value as Partial<AgentTodoState>
  if (!Array.isArray(value.items)) return null
  return {
    items: value.items as AgentTodoItem[],
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    unclosed: typeof value.unclosed === 'number' ? value.unclosed : 0,
    ...(typeof value.unclosedAt === 'number' ? { unclosedAt: value.unclosedAt } : {})
  }
}

export function writeTodoState(sessionId: string, state: AgentTodoState): void {
  const now = Date.now()
  application
    .get('DbService')
    .getDb()
    .insert(appStateTable)
    .values({ key: todoStateKey(sessionId), value: state })
    .onConflictDoUpdate({ target: appStateTable.key, set: { value: state, updatedAt: now } })
    .run()
}

/**
 * Runs at turn end: adopt the list this turn wrote (if any) and record how open it is. A turn that
 * wrote no list keeps the stored one — the list outlives the turn that created it, which is the
 * whole point of mirroring it here instead of trusting the newest tool call in the transcript.
 */
export function recordTurnTodoState(sessionId: string, assistantMessageId: string): AgentTodoState | null {
  try {
    const previous = readTodoState(sessionId)
    let snapshot: AgentTodoItem[] | null = null
    try {
      snapshot = readTodoSnapshotFromParts(
        agentSessionMessageService.getSessionMessage(sessionId, assistantMessageId).data?.parts
      )
    } catch {
      // The row can already be gone when a turn is superseded (edit-resend, delete) — keep the
      // stored list rather than clearing it on a missing row.
      snapshot = null
    }
    const items = snapshot ?? previous?.items ?? []
    if (items.length === 0) return null

    const unclosed = unfinishedTodos(items).length
    const wroteList = snapshot !== null && snapshot !== previous?.items
    const state: AgentTodoState = {
      items,
      updatedAt: wroteList ? Date.now() : (previous?.updatedAt ?? Date.now()),
      unclosed,
      ...(unclosed > 0 ? { unclosedAt: Date.now() } : {})
    }
    writeTodoState(sessionId, state)
    if (unclosed > 0) {
      logger.warn('Agent turn ended with unfinished todos', {
        sessionId,
        assistantMessageId,
        unclosed,
        total: items.length,
        wroteList
      })
    }
    return state
  } catch (error) {
    // Bookkeeping must never fail a turn that already produced its answer.
    logger.warn('Failed to record the session todo state', { sessionId, assistantMessageId, error })
    return null
  }
}

/** Appends the open-list reminder to the outgoing message; a closed or absent list changes nothing. */
export function prepareTurnMessageWithTodoReminder<T extends AgentSessionMessageEntity>(
  sessionId: string,
  userMessage: T
): T {
  let reminder: string | null = null
  try {
    const state = readTodoState(sessionId)
    reminder = state ? buildUnfinishedTodoReminder(state) : null
  } catch (error) {
    logger.warn('Failed to read the session todo state', { sessionId, error })
    return userMessage
  }
  if (!reminder) return userMessage

  const parts = [...(userMessage.data?.parts ?? [])]
  parts.push({ type: 'text', text: reminder } as (typeof parts)[number])
  return { ...userMessage, data: { ...userMessage.data, parts } }
}
