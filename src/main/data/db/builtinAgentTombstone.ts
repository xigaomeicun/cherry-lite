import type { BuiltinAgentRole } from '@shared/ai/builtinAgent'
import { eq } from 'drizzle-orm'

import { appStateTable } from './schemas/appState'
import type { DbOrTx } from './types'

/**
 * Durable record that the user deliberately deleted a built-in Agent.
 *
 * The delete endpoint removes the row for real, so the row itself carries no memory of the choice.
 * Without a tombstone every "ensure the built-in Agent exists" path (the seeders and the
 * `ensureBuiltinAgent` repair flow behind the in-app feedback entry) would silently recreate it on
 * the next run — the deletion would look like it worked and then quietly undo itself.
 *
 * Scope note: this tracks USER intent only. Repairing a row that went missing for any other reason
 * (external corruption, a future soft-delete) stays the seeders' / ensure's business, so the key is
 * written from the delete path alone and never from the seeders.
 */
const BUILTIN_AGENT_DELETED_KEY_PREFIX = 'builtinAgent:userDeleted:'

function tombstoneKey(builtinRole: BuiltinAgentRole): string {
  return `${BUILTIN_AGENT_DELETED_KEY_PREFIX}${builtinRole}`
}

/** Record that the user deleted this built-in Agent, so no ensure path may recreate it. */
export function markBuiltinAgentDeletedTx(tx: DbOrTx, builtinRole: BuiltinAgentRole): void {
  tx.insert(appStateTable)
    .values({ key: tombstoneKey(builtinRole), value: { deletedAt: Date.now() } })
    .onConflictDoUpdate({
      target: appStateTable.key,
      set: { value: { deletedAt: Date.now() }, updatedAt: Date.now() }
    })
    .run()
}

/** True when the user has deleted this built-in Agent. */
export function isBuiltinAgentDeletedTx(tx: Pick<DbOrTx, 'select'>, builtinRole: BuiltinAgentRole): boolean {
  const [row] = tx
    .select({ key: appStateTable.key })
    .from(appStateTable)
    .where(eq(appStateTable.key, tombstoneKey(builtinRole)))
    .limit(1)
    .all()

  return row !== undefined
}
