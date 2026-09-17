import type { AgentSessionMessageEntity } from '@shared/data/api/schemas/agentSessionMessages'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildPriorConversationTranscript,
  hasPriorHistoryBeenSeeded,
  markPriorHistorySeeded,
  prepareTurnMessageWithPriorHistory
} from '../agentSessionPriorHistory'

const mocks = vi.hoisted(() => ({
  listSessionMessages: vi.fn(),
  select: vi.fn(),
  from: vi.fn(),
  where: vi.fn(),
  limit: vi.fn(),
  all: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  onConflictDoUpdate: vi.fn(),
  run: vi.fn()
}))

vi.mock('@data/services/AgentSessionMessageService', () => ({
  agentSessionMessageService: {
    listSessionMessages: mocks.listSessionMessages
  }
}))

vi.mock('@application', () => ({
  application: {
    get: vi.fn((key: string) => {
      if (key === 'DbService') {
        return {
          getDb: () => ({
            select: mocks.select,
            insert: mocks.insert
          })
        }
      }
      return undefined
    })
  }
}))

describe('agentSessionPriorHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mocks.select.mockReturnValue({ from: mocks.from })
    mocks.from.mockReturnValue({ where: mocks.where })
    mocks.where.mockReturnValue({ limit: mocks.limit })
    mocks.limit.mockReturnValue({ all: mocks.all })

    mocks.insert.mockReturnValue({ values: mocks.values })
    mocks.values.mockReturnValue({ onConflictDoUpdate: mocks.onConflictDoUpdate })
    mocks.onConflictDoUpdate.mockReturnValue({ run: mocks.run })
  })

  describe('buildPriorConversationTranscript', () => {
    it('returns null for an empty array of messages', () => {
      expect(buildPriorConversationTranscript([])).toBeNull()
    })

    it('formats user and assistant messages with attachments', () => {
      const messages: AgentSessionMessageEntity[] = [
        {
          id: 'msg-1',
          sessionId: 's-1',
          role: 'user',
          status: 'success',
          data: {
            parts: [
              { type: 'text', text: '请检查脚本' },
              { type: 'file', url: 'file:///tmp/install.sh', filename: 'install.sh', mimeType: 'text/x-sh' }
            ]
          },
          createdAt: 1000
        } as unknown as AgentSessionMessageEntity,
        {
          id: 'msg-2',
          sessionId: 's-1',
          role: 'assistant',
          status: 'success',
          data: {
            parts: [{ type: 'text', text: '脚本检查完成，逻辑完备。' }]
          },
          createdAt: 2000
        } as unknown as AgentSessionMessageEntity
      ]

      const transcript = buildPriorConversationTranscript(messages)
      expect(transcript).not.toBeNull()
      expect(transcript).toContain('<prior_conversation>')
      expect(transcript).toContain('【用户】\n请检查脚本\n[附件: install.sh]')
      expect(transcript).toContain('【智能体】\n脚本检查完成，逻辑完备。')
      expect(transcript).toContain('</prior_conversation>')
    })

    it('truncates very long history with an omission notice', () => {
      const longText = 'A'.repeat(25_000)
      const messages: AgentSessionMessageEntity[] = [
        {
          id: 'msg-1',
          sessionId: 's-1',
          role: 'user',
          status: 'success',
          data: { parts: [{ type: 'text', text: longText }] },
          createdAt: 1000
        } as unknown as AgentSessionMessageEntity,
        {
          id: 'msg-2',
          sessionId: 's-1',
          role: 'assistant',
          status: 'success',
          data: { parts: [{ type: 'text', text: longText }] },
          createdAt: 2000
        } as unknown as AgentSessionMessageEntity
      ]

      const transcript = buildPriorConversationTranscript(messages)
      expect(transcript).not.toBeNull()
      expect(transcript).toContain('[更早的历史对话已省略]')
    })
  })

  describe('hasPriorHistoryBeenSeeded and markPriorHistorySeeded', () => {
    it('reports true when seeded row exists in app_state', () => {
      mocks.all.mockReturnValueOnce([{ key: 'agentSession:historySeeded:s-1:agent-a' }])
      const db = { select: mocks.select }
      expect(hasPriorHistoryBeenSeeded(db as never, 's-1', 'agent-a')).toBe(true)
    })

    it('reports false when seeded row does not exist in app_state', () => {
      mocks.all.mockReturnValueOnce([])
      const db = { select: mocks.select }
      expect(hasPriorHistoryBeenSeeded(db as never, 's-1', 'agent-a')).toBe(false)
    })

    it('inserts or updates seeded marker with metadata', () => {
      const db = { insert: mocks.insert }
      markPriorHistorySeeded(db as never, 's-1', 'agent-a', { priorMessageCount: 5 })
      expect(mocks.insert).toHaveBeenCalled()
      expect(mocks.values).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'agentSession:historySeeded:s-1:agent-a',
          value: expect.objectContaining({ priorMessageCount: 5 })
        })
      )
      expect(mocks.run).toHaveBeenCalled()
    })
  })

  describe('prepareTurnMessageWithPriorHistory', () => {
    const userMessage: AgentSessionMessageEntity = {
      id: 'current-msg',
      sessionId: 's-1',
      role: 'user',
      status: 'success',
      data: {
        parts: [{ type: 'text', text: '你能看到历史消息吗' }]
      },
      createdAt: 3000
    } as unknown as AgentSessionMessageEntity

    it('returns userMessage untouched when already seeded', () => {
      mocks.all.mockReturnValueOnce([{ key: 'agentSession:historySeeded:s-1:agent-dsh' }])

      const result = prepareTurnMessageWithPriorHistory({
        sessionId: 's-1',
        agentId: 'agent-dsh',
        userMessage
      })

      expect(result).toBe(userMessage)
      expect(mocks.listSessionMessages).not.toHaveBeenCalled()
    })

    it('returns userMessage untouched and marks seeded when there are no prior messages', () => {
      mocks.all.mockReturnValueOnce([]) // not seeded
      mocks.listSessionMessages.mockReturnValueOnce({
        items: [userMessage]
      })

      const result = prepareTurnMessageWithPriorHistory({
        sessionId: 's-1',
        agentId: 'agent-dsh',
        userMessage
      })

      expect(result).toBe(userMessage)
      expect(mocks.run).toHaveBeenCalled() // marks seeded
    })

    it('prepends prior conversation transcript when unseeded prior messages exist', () => {
      mocks.all.mockReturnValueOnce([]) // not seeded
      const priorUser: AgentSessionMessageEntity = {
        id: 'msg-old-1',
        sessionId: 's-1',
        role: 'user',
        status: 'success',
        data: { parts: [{ type: 'text', text: '审查 install.sh' }] },
        createdAt: 1000
      } as unknown as AgentSessionMessageEntity
      const priorAssistant: AgentSessionMessageEntity = {
        id: 'msg-old-2',
        sessionId: 's-1',
        role: 'assistant',
        status: 'success',
        data: { parts: [{ type: 'text', text: '审查完成，全套链路清爽。' }] },
        createdAt: 2000
      } as unknown as AgentSessionMessageEntity

      mocks.listSessionMessages.mockReturnValueOnce({
        items: [userMessage, priorAssistant, priorUser]
      })

      const result = prepareTurnMessageWithPriorHistory({
        sessionId: 's-1',
        agentId: 'agent-dsh',
        userMessage
      })

      expect(result).not.toBe(userMessage)
      const textPart = result.data?.parts?.find((p) => p.type === 'text') as { type: 'text'; text: string }
      expect(textPart.text).toContain('<prior_conversation>')
      expect(textPart.text).toContain('审查 install.sh')
      expect(textPart.text).toContain('审查完成，全套链路清爽。')
      expect(textPart.text).toContain('你能看到历史消息吗')
      expect(mocks.run).toHaveBeenCalled() // marks seeded
    })
  })
})
