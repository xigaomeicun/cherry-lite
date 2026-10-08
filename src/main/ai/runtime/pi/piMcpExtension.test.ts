import { describe, expect, it } from 'vitest'

import { buildPiMcpToolName, toPiMcpServerKey } from './piMcpExtension'

describe('toPiMcpServerKey', () => {
  const NOTION_SERVER = {
    id: 'b96bc771-d4f0-49f0-bc55-f3feaa90c063',
    name: 'Notion'
  }

  it('slugifies standard server names for readability and compact wire length', () => {
    expect(toPiMcpServerKey(NOTION_SERVER)).toBe('notion')
    expect(toPiMcpServerKey({ id: '1234', name: 'GitHub' })).toBe('github')
    expect(toPiMcpServerKey({ id: '1234', name: 'cherry-tools' })).toBe('cherry_tools')
    expect(toPiMcpServerKey('agent-memory')).toBe('agent_memory')
  })

  it('falls back to short server id when name cannot produce an ASCII slug', () => {
    expect(toPiMcpServerKey({ id: 'b96bc771-d4f0-49f0-bc55-f3feaa90c063', name: '飞书机器人' })).toBe('s_b96bc771')
    expect(toPiMcpServerKey({ id: 'b96bc771-d4f0-49f0-bc55-f3feaa90c063', name: '' })).toBe('s_b96bc771')
  })

  it('disambiguates colliding server names within the same agent session', () => {
    const first = toPiMcpServerKey(NOTION_SERVER)
    const second = toPiMcpServerKey(
      { id: 'c44c8b8f-1234-5678-abcd-123456789abc', name: 'Notion' },
      (candidate) => candidate === first
    )
    expect(first).toBe('notion')
    expect(second).toBe('notion_c44c')
  })
})

describe('buildPiMcpToolName with Notion tools', () => {
  const NOTION_SERVER = {
    id: 'b96bc771-d4f0-49f0-bc55-f3feaa90c063',
    name: 'Notion'
  }

  const NOTION_TOOLS = [
    'notion-create-pages',
    'notion-update-page',
    'notion-fetch',
    'notion-search',
    'notion-create-database',
    'notion-update-data-source',
    'notion-query-data-sources',
    'notion-query-multiple-data-sources',
    'notion-get-tool-access',
    'notion-check-mcp-next-steps',
    'notion-create-attachment',
    'notion-download-attachment',
    'notion-create-file-upload',
    'notion-get-file-download-urls',
    'notion-create-comment',
    'notion-get-comments',
    'notion-duplicate-page',
    'notion-restore-pages',
    'notion-memory-search',
    'notion-query-meeting-notes',
    'notion-create-view',
    'notion-update-view',
    'notion-create-folder',
    'notion-update-folder',
    'notion-search-agents',
    'notion-spawn-session',
    'notion-get-session-status',
    'notion-send-message-to-session',
    'notion-wait-session',
    'notion-stop-session',
    'notion-list-session-events',
    'notion-read-session-event',
    'notion-get-async-task',
    'notion-get-users',
    'notion-get-teams',
    'notion-list-private-pages',
    'notion-list-shared-pages',
    'notion-list-favorite-pages',
    'notion-list-recent-pages',
    'notion-upload-skill',
    'notion-download-skill',
    'notion-convert-page-to-skill',
    'notion-show-advanced-analysis-next-steps'
  ]

  it('keeps every single Notion tool readable and within Pi 64-char limit without truncation', () => {
    for (const tool of NOTION_TOOLS) {
      const name = buildPiMcpToolName(NOTION_SERVER, tool)
      expect(name).toBe(`mcp__notion__${tool.replace(/[^A-Za-z0-9_]/g, '_')}`)
      expect(name.length).toBeLessThanOrEqual(64)
      // Must NOT contain sha256 hash tail (which would indicate truncation)
      expect(name).not.toMatch(/_[0-9a-f]{8}$/)
    }
  })

  it('specifically preserves the exact tools from the user report', () => {
    expect(buildPiMcpToolName(NOTION_SERVER, 'notion-get-file-download-urls')).toBe(
      'mcp__notion__notion_get_file_download_urls'
    )
    expect(buildPiMcpToolName(NOTION_SERVER, 'notion-check-mcp-next-steps')).toBe(
      'mcp__notion__notion_check_mcp_next_steps'
    )
    expect(buildPiMcpToolName(NOTION_SERVER, 'notion-download-attachment')).toBe(
      'mcp__notion__notion_download_attachment'
    )
    expect(buildPiMcpToolName(NOTION_SERVER, 'notion-get-tool-access')).toBe('mcp__notion__notion_get_tool_access')
  })
})
