import { randomUUID } from 'node:crypto'

import { agentTable } from '@data/db/schemas/agent'
import { agentSessionTable } from '@data/db/schemas/agentSession'
import { agentSessionMessageTable } from '@data/db/schemas/agentSessionMessage'
import { agentWorkspaceTable } from '@data/db/schemas/agentWorkspace'
import { appStateTable } from '@data/db/schemas/appState'
import type { DbOrTx, DbType } from '@data/db/types'
import type { RuntimeForkAnchor } from '@main/ai/runtime/fork'
import { BROWSER_TOOL_GROUP } from '@shared/ai/browserTools'
import { asc, eq, like } from 'drizzle-orm'

const MIGRATION_KEY_PREFIX = 'agent-runtime-migration:'
const HISTORY_VERSION_KEY_PREFIX = 'agent-runtime-history-version:'
const HISTORY_REPAIR_DONE_KEY = 'agent-runtime-history-repair'
/**
 * v2: imported Pi context keeps post-compaction parts, carries the DSH-retained compaction summary
 * and marks omitted rows. Sessions imported by v1 are rebuilt once (see retiredSessionHistory).
 */
export const RETIRED_SESSION_HISTORY_VERSION = 2
/** Private (never published) row marker: the row was left out of the imported Pi context. */
export const HISTORY_IMPORT_OMITTED_KEY = 'historyImportOmitted'
const PI_FILE_SHELL_TOOLS = new Set(['read', 'edit', 'write', 'bash'])

export interface RetiredAgentSessionMigration {
  sessionId: string
  resumeToken: string
}

/** Queue before any reader validates AgentType; retain native tokens until fork recovery finishes. */
export function queueRetiredAgentRuntimeMigration(db: DbType): void {
  db.transaction(
    (tx) => {
      const agents = tx.select().from(agentTable).where(eq(agentTable.type, 'dsh')).all()
      for (const agent of agents) {
        const configuration = { ...agent.configuration }
        if (configuration.permission_mode === 'plan') configuration.permission_mode = 'default'
        const disabledTools = [
          ...new Set(
            agent.disabledTools.flatMap((name) => {
              if (name === BROWSER_TOOL_GROUP) return [name]
              const nativeName = name.toLowerCase()
              if (PI_FILE_SHELL_TOOLS.has(nativeName)) return [nativeName]
              if (nativeName === 'read_image') return ['read']
              if (nativeName === 'pwsh') return ['bash']
              // Our Pi connection already resolves DSH-style `mcp__<server>__<tool>` ids (name, id and
              // Pi-key spellings), so they are carried over verbatim instead of a legacy marker.
              return name.startsWith('mcp__') ? [name] : []
            })
          )
        ]
        for (const session of tx
          .select()
          .from(agentSessionTable)
          .where(eq(agentSessionTable.agentId, agent.id))
          .all()) {
          tx.insert(appStateTable)
            .values({
              key: `${MIGRATION_KEY_PREFIX}${session.id}`,
              value: { sessionId: session.id, resumeToken: randomUUID() } satisfies RetiredAgentSessionMigration
            })
            .onConflictDoNothing()
            .run()
        }
        tx.update(agentTable)
          .set({ type: 'pi', configuration, disabledTools, updatedAt: agent.updatedAt })
          .where(eq(agentTable.id, agent.id))
          .run()
      }
    },
    { behavior: 'immediate' }
  )
}

export function listRetiredAgentSessionMigrations(db: DbOrTx): RetiredAgentSessionMigration[] {
  return db
    .select()
    .from(appStateTable)
    .where(like(appStateTable.key, `${MIGRATION_KEY_PREFIX}%`))
    .all()
    .map((row) => row.value as RetiredAgentSessionMigration)
}

export function listAgentSessionIds(db: DbOrTx): string[] {
  return db
    .select({ id: agentSessionTable.id })
    .from(agentSessionTable)
    .all()
    .map((row) => row.id)
}

export function getRetiredAgentSessionMigration(
  db: DbOrTx,
  sessionId: string
): RetiredAgentSessionMigration | undefined {
  return db
    .select()
    .from(appStateTable)
    .where(eq(appStateTable.key, `${MIGRATION_KEY_PREFIX}${sessionId}`))
    .get()?.value as RetiredAgentSessionMigration | undefined
}

export function getRetiredSessionHistoryVersion(db: DbOrTx, sessionId: string): number | undefined {
  const value = db
    .select()
    .from(appStateTable)
    .where(eq(appStateTable.key, `${HISTORY_VERSION_KEY_PREFIX}${sessionId}`))
    .get()?.value as { version?: number } | undefined
  return value?.version
}

function setRetiredSessionHistoryVersion(tx: DbOrTx, sessionId: string): void {
  const value = { version: RETIRED_SESSION_HISTORY_VERSION }
  tx.insert(appStateTable)
    .values({ key: `${HISTORY_VERSION_KEY_PREFIX}${sessionId}`, value })
    .onConflictDoUpdate({ target: appStateTable.key, set: { value } })
    .run()
}

export function isRetiredSessionHistoryRepairDone(db: DbOrTx): boolean {
  const value = db.select().from(appStateTable).where(eq(appStateTable.key, HISTORY_REPAIR_DONE_KEY)).get()?.value as
    | { version?: number }
    | undefined
  return (value?.version ?? 0) >= RETIRED_SESSION_HISTORY_VERSION
}

export function markRetiredSessionHistoryRepairDone(tx: DbOrTx): void {
  const value = { version: RETIRED_SESSION_HISTORY_VERSION }
  tx.insert(appStateTable)
    .values({ key: HISTORY_REPAIR_DONE_KEY, value })
    .onConflictDoUpdate({ target: appStateTable.key, set: { value } })
    .run()
}

/** A session that needs no rebuild (not imported, or nothing to repair) is still marked current. */
export function markRetiredSessionHistoryCurrent(tx: DbOrTx, sessionId: string): void {
  setRetiredSessionHistoryVersion(tx, sessionId)
}

type MessageRowData = typeof agentSessionMessageTable.$inferSelect.data

function withImportState(
  row: { id: string; data: MessageRowData },
  anchors: ReadonlyMap<string, RuntimeForkAnchor>,
  omittedMessageIds: ReadonlySet<string>
): MessageRowData {
  const data = { ...row.data } as MessageRowData & Record<string, unknown>
  delete data.runtimeAnchor
  delete data.nativeSessionId
  delete data[HISTORY_IMPORT_OMITTED_KEY]
  const anchor = anchors.get(row.id)
  if (anchor) data.runtimeAnchor = anchor
  else if (omittedMessageIds.has(row.id)) data[HISTORY_IMPORT_OMITTED_KEY] = true
  return data
}

export function readRetiredAgentSessionHistory(db: DbOrTx, sessionId: string) {
  const session = db
    .select({ path: agentWorkspaceTable.path })
    .from(agentSessionTable)
    .innerJoin(agentWorkspaceTable, eq(agentSessionTable.workspaceId, agentWorkspaceTable.id))
    .where(eq(agentSessionTable.id, sessionId))
    .get()
  if (!session) return undefined
  const messages = db
    .select()
    .from(agentSessionMessageTable)
    .where(eq(agentSessionMessageTable.sessionId, sessionId))
    .orderBy(asc(agentSessionMessageTable.createdAt), asc(agentSessionMessageTable.id))
    .all()
  return { workspacePath: session.path, messages }
}

export function commitRetiredAgentSessionMigration(
  tx: DbOrTx,
  migration: RetiredAgentSessionMigration,
  anchors: ReadonlyMap<string, RuntimeForkAnchor>,
  expectedHistory: ReturnType<typeof readRetiredAgentSessionHistory>,
  pendingMessageIds: ReadonlySet<string>,
  omittedMessageIds: ReadonlySet<string> = new Set()
): void {
  if (getRetiredAgentSessionMigration(tx, migration.sessionId)?.resumeToken !== migration.resumeToken)
    throw new Error('Retired session migration changed')
  if (JSON.stringify(readRetiredAgentSessionHistory(tx, migration.sessionId)) !== JSON.stringify(expectedHistory))
    throw new Error('Retired session history changed during migration')
  for (const row of tx
    .select()
    .from(agentSessionMessageTable)
    .where(eq(agentSessionMessageTable.sessionId, migration.sessionId))
    .all()) {
    tx.update(agentSessionMessageTable)
      .set({
        data: withImportState(row, anchors, omittedMessageIds),
        status: pendingMessageIds.has(row.id) ? 'pending' : row.status,
        runtimeResumeToken: migration.resumeToken,
        updatedAt: row.updatedAt
      })
      .where(eq(agentSessionMessageTable.id, row.id))
      .run()
  }
  tx.delete(appStateTable)
    .where(eq(appStateTable.key, `${MIGRATION_KEY_PREFIX}${migration.sessionId}`))
    .run()
  setRetiredSessionHistoryVersion(tx, migration.sessionId)
}

/**
 * Commit a rebuilt import prefix for an already-migrated session: only the rows that were part of
 * the original import are touched (anchors / omitted marker); statuses, tokens and rows created
 * after the migration are left as they are.
 */
export function commitRetiredSessionHistoryRepair(
  tx: DbOrTx,
  sessionId: string,
  importedMessageIds: ReadonlySet<string>,
  anchors: ReadonlyMap<string, RuntimeForkAnchor>,
  omittedMessageIds: ReadonlySet<string>,
  expectedHistory: ReturnType<typeof readRetiredAgentSessionHistory>
): void {
  if (JSON.stringify(readRetiredAgentSessionHistory(tx, sessionId)) !== JSON.stringify(expectedHistory))
    throw new Error('Retired session history changed during repair')
  for (const row of tx
    .select()
    .from(agentSessionMessageTable)
    .where(eq(agentSessionMessageTable.sessionId, sessionId))
    .all()) {
    if (!importedMessageIds.has(row.id)) continue
    tx.update(agentSessionMessageTable)
      .set({ data: withImportState(row, anchors, omittedMessageIds), updatedAt: row.updatedAt })
      .where(eq(agentSessionMessageTable.id, row.id))
      .run()
  }
  setRetiredSessionHistoryVersion(tx, sessionId)
}
