import { describe, expect, it } from 'vitest'

import {
  balanceInlineTags,
  escapeInline,
  htmlVisibleLength,
  planTelegramSend,
  renderTelegramHtml,
  splitMarkdownByHtmlLimit
} from '../markdownTg'

/** 行内/块级标签是否严格嵌套；返回错误描述，合法返回 null */
function nestingError(html: string): string | null {
  const stack: string[] = []
  for (const t of html.matchAll(/<(\/?)(b|i|u|s|tg-spoiler|a|pre|code|blockquote)(\s[^>]*)?>/gi)) {
    const name = t[2].toLowerCase()
    if (!t[1]) stack.push(name)
    else {
      const top = stack.pop()
      if (top !== name) return `expected </${top}> found </${name}>`
    }
  }
  return stack.length ? `unclosed <${stack.join('>, <')}>` : null
}

function tableHeavy(rows: number): string {
  return (
    '## 一、概览\n\n| 关键属性 | 说明 |\n|---|---|\n' +
    Array.from({ length: rows }, (_, i) => `| **属性${i}** | 这是第${i}行的说明，包含一些中文内容与 **粗体** |`).join(
      '\n'
    ) +
    '\n\n---\n\n## 二、结论\n\n结尾段落。'
  )
}

/** Markdown 仍 < 4096 的前提下尽量多放行：线上「3811 字符 → 可见 4647」的形态 */
function denseTable(): string {
  let rows = 10
  while (tableHeavy(rows + 1).length < 4096) rows++
  return tableHeavy(rows)
}

describe('escapeInline / balanceInlineTags (crossing inline tags)', () => {
  it.each([
    '**粗体里 *斜体** 还没闭合*',
    '*斜体里 **粗体* 还没闭合**',
    '价格 **$4,500 万 *约** 合 3 亿*',
    '~~删除 **粗~~ 体**',
    '__下划 **粗__ 体**',
    '**a ~~b** c~~'
  ])('never emits crossing tags: %s', (md) => {
    expect(nestingError(escapeInline(md))).toBeNull()
  })

  it('repairs crossing: close inner, close target, reopen inner', () => {
    expect(balanceInlineTags('<b>a <i>b</b> c</i>')).toBe('<b>a <i>b</i></b><i> c</i>')
  })

  it('drops orphan closers, closes dangling openers, strips empty tags', () => {
    expect(balanceInlineTags('x</b>y')).toBe('xy')
    expect(balanceInlineTags('<b>x')).toBe('<b>x</b>')
    expect(balanceInlineTags('<b></b>x')).toBe('x')
  })

  it('leaves valid html untouched (incl. <br> / <blockquote>)', () => {
    const ok = '正常 <b>bold</b> <i>it</i> <a href="https://x.y">l</a> <br> <blockquote>q</blockquote>'
    expect(balanceInlineTags(ok)).toBe(ok)
  })

  it('does not change ordinary bold / italic / code', () => {
    expect(escapeInline('**b** *i* `c`')).toBe('<b>b</b> <i>i</i> <code>c</code>')
  })
})

describe('splitMarkdownByHtmlLimit (expansion-aware split)', () => {
  it('fixture really expands beyond 4096 after conversion', () => {
    const md = denseTable()
    expect(md.length).toBeLessThan(4096)
    expect(htmlVisibleLength(renderTelegramHtml(md))).toBeGreaterThan(4096)
  })

  it('every part stays within the limit and has balanced tags', () => {
    const parts = splitMarkdownByHtmlLimit(denseTable(), renderTelegramHtml)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) {
      const html = renderTelegramHtml(p)
      expect(htmlVisibleLength(html)).toBeLessThanOrEqual(4096)
      expect(nestingError(html)).toBeNull()
    }
  })

  it('splits big tables by row, repeats the header, keeps all rows', () => {
    const parts = splitMarkdownByHtmlLimit(tableHeavy(200), renderTelegramHtml)
    expect(parts.length).toBeGreaterThanOrEqual(3)
    for (const p of parts.slice(1)) {
      if (/^\|/m.test(p)) expect(p).toContain('| 关键属性 | 说明 |')
    }
    const joined = parts.join('\n')
    for (let i = 0; i < 200; i++) expect(joined).toContain(`属性${i}**`)
  })

  it('does not leave a lone heading as its own message', () => {
    const parts = splitMarkdownByHtmlLimit(tableHeavy(200), renderTelegramHtml)
    expect(parts[0].trim()).not.toBe('## 一、概览')
  })

  it('never splits inside a fenced code block', () => {
    const md = '说明\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\n' + '文字段落。'.repeat(900)
    const parts = splitMarkdownByHtmlLimit(md, renderTelegramHtml)
    expect(parts.some((p) => p.includes('const a = 1\n\nconst b = 2'))).toBe(true)
    for (const p of parts) expect(nestingError(renderTelegramHtml(p))).toBeNull()
  })

  it('keeps short messages in one piece', () => {
    expect(splitMarkdownByHtmlLimit('你好 **世界**', renderTelegramHtml)).toEqual(['你好 **世界**'])
  })
})

describe('planTelegramSend', () => {
  it('markdown: each piece is valid HTML under 4096, plain fallback is per piece', () => {
    const md = denseTable()
    const pieces = planTelegramSend(md)
    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) {
      expect(htmlVisibleLength(piece.html)).toBeLessThanOrEqual(4096)
      expect(nestingError(piece.html)).toBeNull()
      // 降级文本只含本段，绝不是整篇原文
      expect(piece.plain.length).toBeLessThan(md.length)
    }
  })

  it('markdown: drops whitespace-only input (nothing to send)', () => {
    expect(planTelegramSend('')).toEqual([])
    expect(planTelegramSend('  \n \n')).toEqual([])
  })

  it('rawHtml: passes through and chunks by raw length (legacy behaviour)', () => {
    const html = `<b>${'a'.repeat(5000)}</b>`
    const pieces = planTelegramSend(html, { rawHtml: true })
    expect(pieces.length).toBeGreaterThan(1)
    expect(pieces.map((p) => p.html).join('')).toContain('a'.repeat(100))
    expect(planTelegramSend('', { rawHtml: true })).toEqual([])
  })
})
