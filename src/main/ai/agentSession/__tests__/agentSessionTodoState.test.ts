import { randomUUID } from 'node:crypto'

import { agentSessionTable } from '@data/db/schemas/agentSession'
import { agentWorkspaceTable } from '@data/db/schemas/agentWorkspace'
import { agentSessionMessageService } from '@data/services/AgentSessionMessageService'
import { setupTestDatabase } from '@test-helpers/db'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  type AgentTodoItem,
  buildUnfinishedTodoReminder,
  isTodoToolName,
  prepareTurnMessageWithTodoReminder,
  readTodoSnapshotFromParts,
  readTodoState,
  recordTurnTodoState,
  todoStateKey,
  unfinishedTodos,
  writeTodoState
} from '../agentSessionTodoState'

const SESSION_ID = randomUUID()
const MISSING_ID = randomUUID()

const todoPart = (todos: unknown, toolName = 'todo_write', state = 'output-available') => ({
  type: 'dynamic-tool',
  toolCallId: 'call-1',
  toolName,
  state,
  input: { todos }
})

const item = (content: string, status: string) => ({ content, status })
const state = (items: AgentTodoItem[]) => ({ items, updatedAt: 1, unclosed: 0 })

describe('agentSessionTodoState', () => {
  const dbh = setupTestDatabase()

  function seedSession(id = SESSION_ID) {
    dbh.db
      .insert(agentWorkspaceTable)
      .values({ id: `ws-${id}`, name: 'ws', path: '/tmp/ws', type: 'user', orderKey: id })
      .run()
    dbh.db
      .insert(agentSessionTable)
      .values({ id, workspaceId: `ws-${id}`, name: 'Session', orderKey: 'a0' })
      .run()
  }

  function saveAssistant(id: string, parts: unknown[]) {
    agentSessionMessageService.saveMessage({
      sessionId: SESSION_ID,
      message: { id, role: 'assistant', status: 'success', data: { parts: parts as never } }
    })
  }

  beforeEach(() => {
    dbh.sqlite.exec('DELETE FROM app_state')
    dbh.sqlite.exec('DELETE FROM agent_session_message')
    dbh.sqlite.exec('DELETE FROM agent_session')
    dbh.sqlite.exec('DELETE FROM agent_workspace')
    seedSession()
  })

  describe('isTodoToolName', () => {
    it('accepts both runtime spellings and rejects lookalikes', () => {
      expect(isTodoToolName('todo_write')).toBe(true)
      expect(isTodoToolName('TodoWrite')).toBe(true)
      expect(isTodoToolName('todo-write')).toBe(true)
      expect(isTodoToolName('todo_read')).toBe(false)
      expect(isTodoToolName(undefined)).toBe(false)
    })
  })

  describe('readTodoSnapshotFromParts', () => {
    it('reads the newest list and treats an unreadable status as open', () => {
      const items = readTodoSnapshotFromParts([
        todoPart([item('first', 'completed')]),
        todoPart([item('first', 'completed'), item('second', 'mystery-status')], 'TodoWrite')
      ])
      expect(items).toEqual([
        { content: 'first', status: 'completed' },
        { content: 'second', status: 'pending' }
      ])
    })

    it('ignores unfinished tool calls, blank content and other tools', () => {
      expect(readTodoSnapshotFromParts([todoPart([item('x', 'pending')], 'todo_write', 'input-available')])).toBeNull()
      expect(readTodoSnapshotFromParts([todoPart([item('   ', 'pending')])])).toEqual([])
      expect(
        readTodoSnapshotFromParts([{ type: 'dynamic-tool', toolName: 'bash', state: 'output-available' }])
      ).toBeNull()
      expect(readTodoSnapshotFromParts(undefined)).toBeNull()
    })
  })

  describe('buildUnfinishedTodoReminder', () => {
    it('stays silent for a closed list', () => {
      expect(buildUnfinishedTodoReminder(state([{ content: 'done', status: 'completed' }]))).toBeNull()
      expect(buildUnfinishedTodoReminder(state([]))).toBeNull()
    })

    it('names the open items and both closing moves', () => {
      const reminder = buildUnfinishedTodoReminder(
        state([
          { content: 'ship it', status: 'in_progress' },
          { content: 'write docs', status: 'pending' },
          { content: 'already done', status: 'completed' }
        ])
      )!
      expect(reminder).toContain('<unfinished_todos>')
      expect(reminder).toContain('仍有 2 项未闭环')
      expect(reminder).toContain('- [in_progress] ship it')
      expect(reminder).toContain('- [pending] write docs')
      expect(reminder).not.toContain('already done')
    })

    it('caps the enumeration instead of pasting a whole backlog', () => {
      const items: AgentTodoItem[] = Array.from({ length: 20 }, (_, index) => ({
        content: `task ${index}`,
        status: 'pending'
      }))
      const reminder = buildUnfinishedTodoReminder(state(items))!
      expect(reminder).toContain('另有 8 项')
      expect((reminder.match(/- \[pending\]/g) ?? []).length).toBe(12)
    })
  })

  describe('turn state', () => {
    const firstId = randomUUID()
    const secondId = randomUUID()

    it('adopts the list a turn wrote and flags it when items stay open', () => {
      saveAssistant(firstId, [todoPart([item('a', 'completed'), item('b', 'pending')])])

      const recorded = recordTurnTodoState(SESSION_ID, firstId)!
      expect(recorded.unclosed).toBe(1)
      expect(readTodoState(SESSION_ID)).toMatchObject({ unclosed: 1, items: recorded.items })
      expect(dbh.sqlite.prepare('SELECT key FROM app_state').get()).toEqual({ key: todoStateKey(SESSION_ID) })
    })

    it('keeps the stored list when a later turn writes none', () => {
      saveAssistant(firstId, [todoPart([item('a', 'pending')])])
      const firstUpdatedAt = recordTurnTodoState(SESSION_ID, firstId)!.updatedAt

      saveAssistant(secondId, [])
      const recorded = recordTurnTodoState(SESSION_ID, secondId)!

      expect(recorded.items).toHaveLength(1)
      expect(recorded.unclosed).toBe(1)
      expect(recorded.updatedAt).toBe(firstUpdatedAt)
    })

    it('closes the list once the last item completes', () => {
      saveAssistant(firstId, [todoPart([item('a', 'in_progress')])])
      expect(recordTurnTodoState(SESSION_ID, firstId)!.unclosed).toBe(1)

      saveAssistant(secondId, [todoPart([item('a', 'completed')])])
      const recorded = recordTurnTodoState(SESSION_ID, secondId)!
      expect(recorded.unclosed).toBe(0)
      expect(buildUnfinishedTodoReminder(recorded)).toBeNull()
    })

    it('keeps the stored list when the turn row is already gone', () => {
      saveAssistant(firstId, [todoPart([item('a', 'pending')])])
      recordTurnTodoState(SESSION_ID, firstId)

      expect(recordTurnTodoState(SESSION_ID, MISSING_ID)?.unclosed).toBe(1)
    })

    it('reports nothing for a session that never wrote a list', () => {
      expect(recordTurnTodoState(MISSING_ID, MISSING_ID)).toBeNull()
      expect(readTodoState(MISSING_ID)).toBeNull()
    })
  })

  describe('prepareTurnMessageWithTodoReminder', () => {
    const userMessage = () =>
      ({
        id: randomUUID(),
        sessionId: SESSION_ID,
        role: 'user',
        status: 'success',
        data: { parts: [{ type: 'text', text: '继续' }] }
      }) as never

    const partsOf = (message: unknown) =>
      (message as { data: { parts: Array<{ type: string; text?: string }> } }).data.parts

    it('leaves the message alone while no list is open', () => {
      expect(partsOf(prepareTurnMessageWithTodoReminder(SESSION_ID, userMessage()))).toHaveLength(1)
    })

    it('appends the reminder while the list is open and stops once it closes', () => {
      writeTodoState(SESSION_ID, { items: [{ content: 'a', status: 'pending' }], updatedAt: 1, unclosed: 1 })
      const prepared = partsOf(prepareTurnMessageWithTodoReminder(SESSION_ID, userMessage()))
      expect(prepared.at(-1)?.text).toContain('<unfinished_todos>')
      expect(prepared[0]).toEqual({ type: 'text', text: '继续' })

      writeTodoState(SESSION_ID, { items: [{ content: 'a', status: 'completed' }], updatedAt: 2, unclosed: 0 })
      expect(partsOf(prepareTurnMessageWithTodoReminder(SESSION_ID, userMessage()))).toHaveLength(1)
    })
  })

  it('reports an empty list as nothing to remind', () => {
    expect(unfinishedTodos([])).toEqual([])
  })
})
