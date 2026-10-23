import { buildToolResponseFromPart } from '@renderer/components/chat/messages/tools/toolResponse'
import type { CherryMessagePart } from '@shared/data/types/message'
import { describe, expect, it } from 'vitest'

import { agentInlineResultPresentationRegistry } from '../agentInlineResultPresentationRegistry'

const navigatePart = {
  type: 'dynamic-tool',
  toolCallId: 'navigate-1',
  toolName: 'mcp__assistant__navigate',
  providerExecuted: true,
  state: 'output-available',
  input: { path: '/settings/provider', query: { id: 'provider-1' } },
  callProviderMetadata: {
    cherry: {
      transport: 'claude-agent',
      tool: { type: 'mcp', name: 'navigate', serverId: 'assistant', serverName: 'assistant' }
    }
  },
  output: {
    content: 'Navigate link created: /settings/provider?id=provider-1',
    metadata: { type: 'mcp', name: 'navigate', serverId: 'assistant', serverName: 'assistant' }
  }
} as CherryMessagePart

const inlineResultParts = [
  navigatePart,
  {
    type: 'dynamic-tool',
    toolCallId: 'create-agent',
    toolName: 'mcp__assistant__create_agent',
    state: 'output-available',
    input: {},
    output: {
      ok: true,
      agentId: 'agent-created',
      name: 'Reviewer',
      model: 'anthropic::claude-sonnet'
    }
  },
  {
    type: 'dynamic-tool',
    toolCallId: 'prepare-report',
    toolName: 'mcp__assistant__prepare_diagnostic_report',
    state: 'output-available',
    input: {},
    output: { ok: true, description: 'Editable diagnostic report draft' }
  }
] as CherryMessagePart[]

describe('agentInlineResultPresentationRegistry', () => {
  it.each(inlineResultParts)('classifies and renders an agent-owned inline result', (part) => {
    const toolResponse = buildToolResponseFromPart(part)

    expect(toolResponse).not.toBeNull()
    expect(agentInlineResultPresentationRegistry.isResultPart(part)).toBe(true)
    expect(agentInlineResultPresentationRegistry.renderResult(toolResponse!)).toBeDefined()
  })

  it('leaves provider navigate classification and rendering to its existing dispatch', () => {
    const metadata = { type: 'provider', name: 'mcp__assistant__navigate' }
    const part = {
      ...navigatePart,
      callProviderMetadata: { cherry: { tool: metadata } },
      output: { content: 'Navigate link created: /settings/provider?id=provider-1', metadata }
    } as CherryMessagePart
    const response = buildToolResponseFromPart(part)
    expect(response?.tool.type).toBe('provider')
    expect(agentInlineResultPresentationRegistry.isResultPart(part)).toBe(false)
    expect(agentInlineResultPresentationRegistry.renderResult(response!)).toBeUndefined()
  })

  it('leaves ordinary tool results to the generic message presentation', () => {
    const part = {
      type: 'dynamic-tool',
      toolCallId: 'read',
      toolName: 'Read',
      state: 'output-available',
      input: {},
      output: 'contents'
    } as CherryMessagePart
    const toolResponse = buildToolResponseFromPart(part)

    expect(toolResponse).not.toBeNull()
    expect(agentInlineResultPresentationRegistry.isResultPart(part)).toBe(false)
    expect(agentInlineResultPresentationRegistry.renderResult(toolResponse!)).toBeUndefined()
  })
})
