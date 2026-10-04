import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { application } from '@application'
import { agentTable } from '@data/db/schemas/agent'
import { agentSessionTable } from '@data/db/schemas/agentSession'
import { agentSessionMessageTable } from '@data/db/schemas/agentSessionMessage'
import { agentWorkspaceTable } from '@data/db/schemas/agentWorkspace'
import { agentSessionMessageService } from '@data/services/AgentSessionMessageService'
import type { RuntimeForkCheckpoint, RuntimeForkInput, RuntimeForkResult } from '@main/ai/runtime/fork'
import { runtimeDriverRegistry } from '@main/ai/runtime/registry'
import { setupTestDatabase } from '@test-helpers/db'
import { asc, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentSessionForkOperations } from '../AgentSessionForkOperations'
import { resolveForkCheckpointWorkset } from '../checkpointWorkset'

const session = 'native-parent'
const anchor = (boundary: number, formatVersion: 0 | 4 = 4): RuntimeForkCheckpoint => ({
  runtime: 'dsh',
  runtimeSessionId: session,
  boundary,
  formatVersion
})

describe('resolveForkCheckpointWorkset', () => {
  it('keeps every checkpoint for runtimes that remap native ids', () => {
    const checkpoints = [anchor(1), anchor(2)]
    const work = resolveForkCheckpointWorkset('pi', checkpoints[1], checkpoints)
    expect(work.workset).toEqual(checkpoints)
    const remapped = [
      { runtime: 'pi', leafId: 'a' },
      { runtime: 'pi', leafId: 'b' }
    ]
    expect(work.expand(remapped, 'child')).toEqual(remapped)
  })

  it('sends only the DSH anchor when every earlier checkpoint is stable v4', () => {
    const checkpoints = [anchor(10), anchor(20), anchor(40), anchor(40)]
    const work = resolveForkCheckpointWorkset('dsh', checkpoints[2], checkpoints)
    expect(work.workset).toEqual([anchor(40)])
    const expanded = work.expand([{ ...anchor(40), runtimeSessionId: 'child', formatVersion: 4 }], 'child')
    expect(expanded.map((checkpoint) => checkpoint.boundary)).toEqual([10, 20, 40, 40])
    expect(expanded.every((checkpoint) => checkpoint.runtimeSessionId === 'child')).toBe(true)
  })

  it('keeps legacy, foreign, and past-anchor checkpoints in the worker set', () => {
    const legacy = anchor(3, 0)
    const foreign = { ...anchor(8), runtimeSessionId: 'other-session' }
    const past = anchor(50)
    const nearest = anchor(40)
    const stable = anchor(12)
    const checkpoints = [legacy, stable, foreign, past, nearest]
    const work = resolveForkCheckpointWorkset('dsh', nearest, checkpoints)
    expect(work.workset).toEqual([legacy, foreign, past, nearest])
    const remapped = work.workset.map((checkpoint, index) =>
      index === 0
        ? { ...checkpoint, boundary: 9, formatVersion: 4 as const, runtimeSessionId: 'child' }
        : { ...checkpoint, runtimeSessionId: 'child' }
    )
    const expanded = work.expand(remapped, 'child')
    expect(expanded[0]).toMatchObject({ boundary: 9, formatVersion: 4, runtimeSessionId: 'child' })
    expect(expanded[1]).toMatchObject({ boundary: 12, runtimeSessionId: 'child', formatVersion: 4 })
    expect(expanded[4]).toMatchObject({ boundary: 40, runtimeSessionId: 'child' })
  })

  it('refuses to stamp without a child resume token', () => {
    const checkpoints = [anchor(1), anchor(2)]
    const work = resolveForkCheckpointWorkset('dsh', checkpoints[1], checkpoints)
    expect(() => work.expand([anchor(2)], '  ')).toThrow('history_corrupt')
  })
})

describe('DSH edit fork checkpoint workset', () => {
  const dbh = setupTestDatabase()
  let directory: string
  let forkRoot: string
  let sessionId: string
  let publishedFile: string
  let seen: RuntimeForkCheckpoint[] | undefined
  let previous: ReturnType<typeof runtimeDriverRegistry.getAgentSessionDriver>

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'fork-workset-'))
    forkRoot = path.join(directory, 'forks')
    publishedFile = path.join(directory, 'native', 'child.jsonl')
    seen = undefined
    vi.spyOn(application, 'getPath').mockImplementation((_key, filename) =>
      filename ? path.join(forkRoot, filename) : forkRoot
    )
    const agentId = randomUUID()
    const workspaceId = randomUUID()
    sessionId = randomUUID()
    dbh.db
      .insert(agentTable)
      .values({ id: agentId, type: 'dsh', name: 'Agent', instructions: '', orderKey: 'a0' })
      .run()
    dbh.db
      .insert(agentWorkspaceTable)
      .values({ id: workspaceId, name: 'Workspace', path: directory, type: 'user', orderKey: 'a0' })
      .run()
    dbh.db
      .insert(agentSessionTable)
      .values({ id: sessionId, agentId, workspaceId, name: 'Source', orderKey: 'a0' })
      .run()
    previous = runtimeDriverRegistry.getAgentSessionDriver('dsh')
    runtimeDriverRegistry.register({
      type: 'dsh',
      capabilities: ['agent-session'],
      validateSession() {},
      async listAvailableTools() {
        return []
      },
      async connect() {
        throw new Error('Edit must snapshot before the connection is closed, not start a new one')
      },
      async fork(input: RuntimeForkInput): Promise<RuntimeForkResult> {
        seen = input.checkpoints
        const source = path.join(input.artifactDirectory, 'native.jsonl')
        await writeFile(source, 'native child history')
        return {
          resumeToken: 'native-child',
          publish: [{ source, target: publishedFile }],
          checkpoints: input.checkpoints.map((checkpoint) => ({ ...checkpoint, runtimeSessionId: 'native-child' }))
        }
      }
    })
  })

  afterEach(async () => {
    runtimeDriverRegistry.clearForTest()
    if (previous) runtimeDriverRegistry.register(previous)
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  })

  async function save(role: 'user' | 'assistant', text: string, boundary?: number, formatVersion?: 0 | 4) {
    return agentSessionMessageService.saveMessage({
      sessionId,
      runtimeResumeToken: role === 'assistant' ? session : null,
      runtimeAnchor:
        boundary === undefined
          ? undefined
          : { checkpoint: { runtime: 'dsh', runtimeSessionId: session, boundary, formatVersion: formatVersion ?? 4 } },
      message: { role, status: 'success', data: { parts: [{ type: 'text', text }] } }
    })
  }

  it('edits with the nearest v4 anchor and still stamps earlier checkpoints onto the child', async () => {
    await save('assistant', 'early', 10)
    await save('assistant', 'middle', 20)
    const target = await save('user', 'edit me')
    await save('assistant', 'later', 99)
    const version = agentSessionMessageService.readEditSnapshotTx(dbh.db, sessionId, target.id).version
    await new AgentSessionForkOperations().edit(
      sessionId,
      { messageId: target.id, version },
      async () => {},
      (tx, nativeSessionId) => {
        const saved = agentSessionMessageService.saveMessagesTx(tx, {
          sessionId,
          messages: [{ role: 'user', status: 'success', data: { parts: [{ type: 'text', text: 'New question' }] } }]
        })
        agentSessionMessageService.setEditRuntimeTx(tx, sessionId, saved[0].id, nativeSessionId)
        return saved[0].id
      }
    )
    expect(seen).toEqual([
      expect.objectContaining({ runtime: 'dsh', runtimeSessionId: session, boundary: 20, formatVersion: 4 })
    ])
    const stored = dbh.db
      .select()
      .from(agentSessionMessageTable)
      .where(eq(agentSessionMessageTable.sessionId, sessionId))
      .orderBy(asc(agentSessionMessageTable.createdAt), asc(agentSessionMessageTable.id))
      .all()
    const anchors = stored.flatMap((row) => {
      const checkpoint = (
        row.data as { runtimeAnchor?: { checkpoint?: { boundary?: number; runtimeSessionId?: string } } }
      ).runtimeAnchor?.checkpoint
      return checkpoint ? [checkpoint] : []
    })
    expect(anchors).toEqual([
      { runtime: 'dsh', runtimeSessionId: 'native-child', boundary: 10, formatVersion: 4 },
      { runtime: 'dsh', runtimeSessionId: 'native-child', boundary: 20, formatVersion: 4 }
    ])
    expect(await readFile(publishedFile, 'utf8')).toBe('native child history')
  })

  it('still sends a formatVersion 0 checkpoint through the driver', async () => {
    await save('assistant', 'legacy', 3, 0)
    await save('assistant', 'current', 20, 4)
    const target = await save('user', 'edit me')
    const version = agentSessionMessageService.readEditSnapshotTx(dbh.db, sessionId, target.id).version
    await new AgentSessionForkOperations().edit(
      sessionId,
      { messageId: target.id, version },
      async () => {},
      () => 'ok'
    )
    expect(seen?.map((checkpoint) => checkpoint.boundary)).toEqual([3, 20])
    expect(seen?.map((checkpoint) => checkpoint.formatVersion)).toEqual([0, 4])
  })
})
