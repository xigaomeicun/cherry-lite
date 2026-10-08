import { buildFunctionCallToolName } from '@shared/ai/tools/mcpToolName'
import { describe, expect, it } from 'vitest'

import {
  buildLegacyPiMcpToolName,
  buildPiMcpToolName,
  expandPiDisabledMcpTools,
  piMcpServerIdentity,
  resolvePiMcpServerKeys
} from './piMcpNames'

const NOTION = { id: 'b96bc771-d4f0-49f0-bc55-f3feaa90c063', name: 'Notion' }
const OTHER_NOTION = { id: 'c44c8b8f-1234-5678-abcd-123456789abc', name: 'Notion' }

describe('buildLegacyPiMcpToolName', () => {
  it('reproduces the id Pi stored before server keys became slugs', () => {
    expect(buildLegacyPiMcpToolName(NOTION.id, 'notion-fetch')).toBe(
      'mcp__b96bc771_d4f0_49f0_bc55_f3feaa90c063__notion_fetch'
    )
  })

  it('reproduces the truncated id with its hash tail (the one users reported as unreadable)', () => {
    expect(buildLegacyPiMcpToolName(NOTION.id, 'notion-get-file-download-urls')).toBe(
      'mcp__b96bc771_d4f0_49f0_bc55_f3feaa90c063__notion_get_f_c44c8b8f'
    )
  })
})

describe('resolvePiMcpServerKeys', () => {
  it('keeps the plain slug for a unique server', () => {
    expect(resolvePiMcpServerKeys([NOTION]).get(NOTION.id)).toBe('notion')
  })

  it('gives same-named servers distinct keys regardless of iteration order', () => {
    const forward = resolvePiMcpServerKeys([NOTION, OTHER_NOTION])
    const backward = resolvePiMcpServerKeys([OTHER_NOTION, NOTION])

    expect(forward.get(NOTION.id)).toBe('notion')
    expect(forward.get(OTHER_NOTION.id)).toBe('notion_c44c')
    expect([...backward.entries()].sort()).toEqual([...forward.entries()].sort())
  })

  it('never lets a user server shadow a built-in Cherry server', () => {
    const user = { id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'skills' }
    const keys = resolvePiMcpServerKeys([user, { name: 'skills' }])

    expect(keys.get('skills')).toBe('skills')
    expect(keys.get(user.id)).toBe('skills_aaaa')
  })

  it('keeps every key inside the 20-char slug budget that buildPiMcpToolName re-applies', () => {
    // Same long name and the same leading id chars: only the later suffix lengths can tell them apart.
    const clashing = ['0000', '1111', '2222'].map((tail) => ({
      id: `abcd1234-${tail}-4000-8000-000000000000`,
      name: 'x'.repeat(40)
    }))
    const keys = resolvePiMcpServerKeys(clashing)

    for (const key of keys.values()) expect(key.length).toBeLessThanOrEqual(20)
    expect(new Set(keys.values()).size).toBe(clashing.length)
  })

  it('looks id-less servers up by name', () => {
    expect(piMcpServerIdentity({ name: 'cherry-tools' })).toBe('cherry-tools')
    expect(resolvePiMcpServerKeys([{ name: 'cherry-tools' }]).get('cherry-tools')).toBe('cherry_tools')
  })
})

describe('expandPiDisabledMcpTools', () => {
  const tools = ['notion-fetch', 'notion-search', 'notion-get-file-download-urls']

  it('keeps a tool blocked that was disabled under the UUID-namespaced id', () => {
    const disabled = new Set([
      buildLegacyPiMcpToolName(NOTION.id, 'notion-fetch'),
      buildLegacyPiMcpToolName(NOTION.id, 'notion-get-file-download-urls')
    ])

    expandPiDisabledMcpTools(disabled, NOTION, 'notion', tools)

    expect(disabled.has('mcp__notion__notion_fetch')).toBe(true)
    expect(disabled.has('mcp__notion__notion_get_file_download_urls')).toBe(true)
    expect(disabled.has('mcp__notion__notion_search')).toBe(false)
  })

  it('migrates the raw and function-call aliases as before', () => {
    const disabled = new Set([
      `mcp__${NOTION.id}__notion-search`,
      buildFunctionCallToolName(NOTION.name, 'notion-fetch')
    ])

    expandPiDisabledMcpTools(disabled, NOTION, 'notion', tools)

    expect(disabled.has('mcp__notion__notion_search')).toBe(true)
    expect(disabled.has('mcp__notion__notion_fetch')).toBe(true)
  })

  it('keeps already-current ids and does not block unrelated tools', () => {
    const disabled = new Set(['mcp__notion__notion_search'])

    expandPiDisabledMcpTools(disabled, NOTION, 'notion', tools)

    expect([...disabled].sort()).toEqual(['mcp__notion__notion_search'])
  })

  it('keeps a stored block working after the server is renamed', () => {
    const stored = new Set([buildLegacyPiMcpToolName(NOTION.id, 'notion-fetch')])

    // The stored id is UUID-keyed, so the key the server currently has is irrelevant to the match.
    expandPiDisabledMcpTools(stored, { ...NOTION, name: 'Company Wiki' }, 'company_wiki', tools)

    expect(stored.has('mcp__company_wiki__notion_fetch')).toBe(true)
  })

  it('uses the collision-resolved key for the second same-named server', () => {
    const disabled = new Set([buildLegacyPiMcpToolName(OTHER_NOTION.id, 'notion-fetch')])

    expandPiDisabledMcpTools(disabled, OTHER_NOTION, 'notion_c44c', tools)

    expect(disabled.has(buildPiMcpToolName('notion_c44c', 'notion-fetch'))).toBe(true)
    expect(disabled.has('mcp__notion__notion_fetch')).toBe(false)
  })
})
