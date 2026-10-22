import { describe, expect, it } from 'vitest'

import { CursorToolLineParser, cursorToolToBubbleArgs, describeCursorToolLine } from '../cursorToolLines'

describe('CursorToolLineParser', () => {
  it('emits only complete [tool] lines across split deltas', () => {
    const p = new CursorToolLineParser()
    expect(p.push('r1', '思考中\n[tool] shell(stream): python3 a.py --help\n[tool] rea')).toEqual([
      { label: 'shell(stream)', summary: 'python3 a.py --help' }
    ])
    expect(p.push('r1', 'd: /Users/x/SKILL.md\n')).toEqual([{ label: 'read', summary: '/Users/x/SKILL.md' }])
  })

  it('keeps separate buffers per reasoning id', () => {
    const p = new CursorToolLineParser()
    expect(p.push('r1', '[tool] gr')).toEqual([])
    expect(p.push('r2', '[tool] grep: foo in /a/b.mjs\n')).toEqual([{ label: 'grep', summary: 'foo in /a/b.mjs' }])
  })

  it('ignores [tool] text that is not at line start and unknown labels', () => {
    const p = new CursorToolLineParser()
    expect(p.push('r1', '普通文字 [tool] 不在行首\n')).toEqual([])
    expect(p.push('r1', '[tool] teleport: somewhere\n')).toEqual([])
    expect(p.push('r1', '[tool] shell(bg): npm run dev\n')).toEqual([{ label: 'shell(bg)', summary: 'npm run dev' }])
  })

  it('drops a partial line when the reasoning block ends', () => {
    const p = new CursorToolLineParser()
    p.push('r1', '[tool] read: /a')
    p.end('r1')
    expect(p.push('r1', '\n')).toEqual([])
  })
})

describe('cursorToolToBubbleArgs', () => {
  it('maps labels onto existing tool names', () => {
    expect(cursorToolToBubbleArgs('shell(bg)', 'npm run dev')).toEqual(['bash', { command: 'npm run dev' }, ''])
    expect(cursorToolToBubbleArgs('read', '/a/b.md')).toEqual(['view', { path: '/a/b.md' }, ''])
    expect(cursorToolToBubbleArgs('write', '/a/c.mjs')).toEqual(['edit', { path: '/a/c.mjs' }, ''])
    expect(cursorToolToBubbleArgs('grep', 'foo in /a/b.mjs')).toEqual([
      'grep',
      { pattern: 'foo', path: '/a/b.mjs' },
      ''
    ])
    expect(cursorToolToBubbleArgs('grep', 'foo')).toEqual(['grep', { pattern: 'foo' }, ''])
    expect(cursorToolToBubbleArgs('fetch', 'https://x.com/a')).toEqual(['web_fetch', { url: 'https://x.com/a' }, ''])
    expect(cursorToolToBubbleArgs('ls', '/a')).toEqual(['ls', { path: '/a' }, ''])
    expect(cursorToolToBubbleArgs('mcp', 'notion search')).toEqual(['mcp notion search', null, ''])
  })

  it('backs truncated summaries off to the last whole word or path segment', () => {
    expect(cursorToolToBubbleArgs('shell(stream)', 'python3 a/card_cli.py fill --card 20261022_2023...')).toEqual([
      'bash',
      { command: 'python3 a/card_cli.py fill --card …' },
      ''
    ])
    expect(cursorToolToBubbleArgs('shell(stream)', 'cd /Users/x/skills/amazing-dra...')).toEqual([
      'bash',
      { command: 'cd /Users/x/skills/…' },
      ''
    ])
    expect(cursorToolToBubbleArgs('read', '/Users/x/amazing-draw/撞...')).toEqual([
      'view',
      { path: '/Users/x/amazing-draw' },
      '/…'
    ])
    expect(cursorToolToBubbleArgs('grep', 'a|b in /Users/x/amazing-draw/s...')).toEqual([
      'grep',
      { pattern: 'a|b', path: '/Users/x/amazing-draw' },
      '/…'
    ])
  })
})

describe('describeCursorToolLine', () => {
  it('renders bubble lines consistent with real tool calls', () => {
    expect(describeCursorToolLine({ label: 'shell(stream)', summary: 'ls ~/Projects' })).toEqual({
      toolName: 'bash',
      description: 'ls ~/Projects'
    })
    expect(describeCursorToolLine({ label: 'read', summary: '/Users/x/amazing-draw/撞...' })?.description).toBe(
      'view amazing-draw/…'
    )
    expect(describeCursorToolLine({ label: 'grep', summary: 'foo in /a/b.mjs' })?.description).toBe('grep "foo" b.mjs')
    expect(describeCursorToolLine({ label: 'fetch', summary: 'https://x.com/a' })?.description).toBe('fetch x.com')
    expect(describeCursorToolLine({ label: 'mcp', summary: 'notion search' })?.description).toBe('mcp notion search')
  })
})
