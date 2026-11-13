import { randomUUID } from 'node:crypto'

import { setupTestDatabase } from '@test-helpers/db'
import { asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { agentSessionTable } from '@data/db/schemas/agentSession'
import { agentSessionMessageTable, type InsertAgentSessionMessageRow } from '@data/db/schemas/agentSessionMessage'
import { agentWorkspaceTable } from '@data/db/schemas/agentWorkspace'

import { AgentSessionMessageTreeSeeder } from '../AgentSessionMessageTreeSeeder'

describe('AgentSessionMessageTreeSeeder', () => {
  const dbh = setupTestDatabase()
  const seeder = new AgentSessionMessageTreeSeeder()

  function session(activeNodeId?: string | null) {
    const id = randomUUID()
    dbh.db
      .insert(agentWorkspaceTable)
      .values({ id: `ws-${id}`, name: 'Work', path: '/w', type: 'user', orderKey: 'a0' })
      .run()
    dbh.db
      .insert(agentSessionTable)
      .values({ id, workspaceId: `ws-${id}`, name: 'History', orderKey: 'a0', activeNodeId })
      .run()
    return id
  }

  function message(sessionId: string, values: Partial<InsertAgentSessionMessageRow> = {}) {
    const id = randomUUID()
    dbh.db
      .insert(agentSessionMessageTable)
      .values({
        id,
        sessionId,
        role: 'user',
        status: 'success',
        data: { parts: [{ type: 'text', text: 'm' }] },
        ...values
      })
      .run()
    return id
  }

  function orderedParents(sessionId: string) {
    return dbh.db
      .select({ id: agentSessionMessageTable.id, parentId: agentSessionMessageTable.parentId })
      .from(agentSessionMessageTable)
      .where(eq(agentSessionMessageTable.sessionId, sessionId))
      .orderBy(asc(agentSessionMessageTable.createdAt), asc(agentSessionMessageTable.id))
      .all()
  }

  it('chains a flat archive under a lazily-created root head', () => {
    const sid = session()
    const m1 = message(sid)
    const m2 = message(sid, { role: 'assistant' })
    const rootId = message(sid, { role: 'root' })
    dbh.db.update(agentSessionTable).set({ activeNodeId: rootId }).where(eq(agentSessionTable.id, sid)).run()

    seeder.run(dbh.db)

    const rows = orderedParents(sid)
    expect(rows.find((r) => r.id === m1)?.parentId).toBe(rootId)
    expect(rows.find((r) => r.id === m2)?.parentId).toBe(m1)
    expect(dbh.db.select().from(agentSessionTable).where(eq(agentSessionTable.id, sid)).get()?.activeNodeId).toBe(m2)
  })

  it('leaves a session with a real message head untouched', () => {
    const sid = session()
    const m1 = message(sid)
    const m2 = message(sid, { role: 'assistant', parentId: m1 })
    dbh.db.update(agentSessionTable).set({ activeNodeId: m2 }).where(eq(agentSessionTable.id, sid)).run()

    seeder.run(dbh.db)

    expect(orderedParents(sid).find((r) => r.id === m1)?.parentId).toBeNull()
    expect(dbh.db.select().from(agentSessionTable).where(eq(agentSessionTable.id, sid)).get()?.activeNodeId).toBe(m2)
  })

  it('skips a root-headed session whose archive is already linked', () => {
    const sid = session()
    const rootId = message(sid, { role: 'root' })
    const m1 = message(sid, { parentId: rootId })
    dbh.db.update(agentSessionTable).set({ activeNodeId: rootId }).where(eq(agentSessionTable.id, sid)).run()

    seeder.run(dbh.db)

    expect(dbh.db.select().from(agentSessionTable).where(eq(agentSessionTable.id, sid)).get()?.activeNodeId).toBe(
      rootId
    )
    expect(orderedParents(sid).find((r) => r.id === m1)?.parentId).toBe(rootId)
  })
})
