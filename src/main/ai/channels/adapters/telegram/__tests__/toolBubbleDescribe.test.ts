import { describe, expect, it } from 'vitest'

import { BUBBLE_LINE_MAX, compactBubbleLine, describeToolCall, normalizeToolName } from '../toolBubbleDescribe'

describe('toolBubbleDescribe', () => {
  describe('normalizeToolName', () => {
    it('strips mcp prefix and extracts tool name', () => {
      expect(normalizeToolName('mcp__cherry-tools__web_search')).toBe('web_search')
      expect(normalizeToolName('mcp__bash')).toBe('bash')
      expect(normalizeToolName('Bash')).toBe('bash')
      expect(normalizeToolName('')).toBe('')
    })
  })

  describe('compactBubbleLine', () => {
    it('collapses whitespaces and newlines', () => {
      expect(compactBubbleLine('ls   -la \n  /tmp\t-h')).toBe('ls -la /tmp -h')
    })

    it('hard-caps long lines with ellipsis', () => {
      const long = 'a'.repeat(BUBBLE_LINE_MAX + 50)
      const result = compactBubbleLine(long)
      expect(result.length).toBe(BUBBLE_LINE_MAX)
      expect(result.endsWith('…')).toBe(true)
    })
  })

  describe('describeToolCall', () => {
    it('silences internal and memory tools', () => {
      expect(describeToolCall('store_memory', { content: 'hello' })).toBeNull()
      expect(describeToolCall('mcp__agent-memory__memory', { action: 'update' })).toBeNull()
      expect(describeToolCall('read_bash')).toBeNull()
    })

    it('describes bash commands using the first non-empty line', () => {
      expect(
        describeToolCall('bash', {
          command: '\n  git status -s\n  git diff'
        })
      ).toBe('git status -s')
    })

    it('describes view/read and edit tools with basename only', () => {
      expect(describeToolCall('read_file', { path: '/Users/test/workspace/src/index.ts' })).toBe('view index.ts')
      expect(describeToolCall('edit', { filePath: '/etc/nginx/nginx.conf' })).toBe('edit nginx.conf')
    })

    it('describes search, fetch, and grep tools', () => {
      expect(describeToolCall('web_search', { query: 'Cherry Studio Telegram bubble' })).toBe(
        'search Cherry Studio Telegram bubble'
      )
      expect(describeToolCall('web_fetch', { url: 'https://github.com/CherryHQ/cherry-studio' })).toBe(
        'fetch github.com'
      )
      expect(describeToolCall('grep', { pattern: 'bubble', glob: '*.ts' })).toBe('grep "bubble" *.ts')
    })

    it('falls back gracefully on unknown tools with or without file argument', () => {
      expect(describeToolCall('custom_runner', { file: '/data/models/weights.bin' })).toBe('custom runner weights.bin')
      expect(describeToolCall('custom_runner')).toBe('custom runner')
    })
  })
})
