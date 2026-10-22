import { describe, expect, it } from 'vitest'

import { buildCitationsGuidance } from '../citationsGuidance'

describe('buildCitationsGuidance', () => {
  it('returns undefined when neither web nor kb is available', () => {
    expect(buildCitationsGuidance({ web: false, kb: false })).toBeUndefined()
  })

  it('mentions only web tools when kb is unavailable', () => {
    const out = buildCitationsGuidance({ web: true, kb: false })
    expect(out).toContain('mcp__cherry-tools__web_search')
    expect(out).toContain('mcp__cherry-tools__web_fetch')
    expect(out).not.toContain('mcp__cherry-tools__kb_search')
    expect(out).toContain('[cite:ID]')
  })

  it('never mentions the removed kb tools (cherry-lite), even when kb is requested', () => {
    expect(buildCitationsGuidance({ web: false, kb: true })).toBeUndefined()
    const out = buildCitationsGuidance({ web: true, kb: true })
    expect(out).toContain('mcp__cherry-tools__web_search')
    expect(out).not.toContain('kb_search')
    expect(out).not.toContain('kb_read')
  })
})
