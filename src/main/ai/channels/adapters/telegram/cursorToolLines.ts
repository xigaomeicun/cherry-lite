/**
 * Cursor-account models served by the local CPA gateway run Cursor's own tools inside the
 * gateway, so the client never sees `tool_calls`. The cursor-for-cpa plugin instead writes one
 * `\n[tool] <label>: <summary>\n` line into the streamed reasoning per tool call. This module
 * turns those lines into Telegram tool-bubble descriptions (ported from Copilot Bridge
 * `lib/cursor-tool-lines.mjs`). It is display-only: nothing here is persisted or replayed.
 */
import { compactBubbleLine, describeToolCall } from './toolBubbleDescribe'

export const CURSOR_TOOL_LINE_RE = /^\[tool\] (\w+(?:\(\w+\))?): (.*)$/

const KNOWN_LABELS = new Set(['read', 'ls', 'grep', 'write', 'delete', 'fetch', 'shell', 'mcp'])

export type CursorToolLine = { label: string; summary: string }

/** Concatenate streamed reasoning deltas per reasoning id and emit only complete `[tool]` lines. */
export class CursorToolLineParser {
  private readonly buffers = new Map<string, string>()

  push(reasoningId: string | undefined, delta: string): CursorToolLine[] {
    const key = reasoningId || '_'
    const parts = ((this.buffers.get(key) ?? '') + (delta ?? '')).split('\n')
    this.buffers.set(key, parts.pop() ?? '')
    const out: CursorToolLine[] = []
    for (const line of parts) {
      const m = CURSOR_TOOL_LINE_RE.exec(line.trim())
      if (!m) continue
      const base = m[1].replace(/\(.*\)$/, '')
      if (!KNOWN_LABELS.has(base)) continue
      out.push({ label: m[1], summary: m[2].trim() })
    }
    return out
  }

  /** Drop any partial line for a finished reasoning block (or all blocks). */
  end(reasoningId?: string): void {
    if (reasoningId === undefined) this.buffers.clear()
    else this.buffers.delete(reasoningId || '_')
  }
}

const TRUNC_RE = /(?:\.\.\.|…)$/

/** The plugin hard-truncates summaries with "..."; back off to the last whole word / path segment. */
function trimToWhole(text: string): { text: string; cut: boolean } {
  const raw = String(text || '').trim()
  if (!TRUNC_RE.test(raw)) return { text: raw, cut: false }
  const head = raw
    .replace(TRUNC_RE, '')
    .replace(/[^\s/]*$/, '')
    .replace(/\s+$/, '')
  return { text: head, cut: true }
}

function withEllipsis(text: string): string {
  if (!text) return '…'
  return text.endsWith('/') ? `${text}…` : `${text} …`
}

function pathArg(p: string): { path: string; suffix: string } {
  const { text, cut } = trimToWhole(p)
  if (!cut) return { path: text, suffix: '' }
  const path = text.replace(/\/+$/, '')
  return { path, suffix: path ? '/…' : ' …' }
}

/**
 * Map a Cursor label to the `[toolName, args, suffix]` triple fed to `describeToolCall`, so the
 * bubble line looks the same as for real tool calls. `suffix` marks a truncated path (`/…`).
 */
export function cursorToolToBubbleArgs(
  label: string,
  summary: string
): [string, Record<string, unknown> | null, string] {
  const base = String(label || '').replace(/\(.*\)$/, '')
  const s = String(summary || '')
  switch (base) {
    case 'shell': {
      const { text, cut } = trimToWhole(s)
      return ['bash', { command: cut ? withEllipsis(text) : text }, '']
    }
    case 'read': {
      const { path, suffix } = pathArg(s)
      return ['view', { path }, suffix]
    }
    case 'write': {
      const { path, suffix } = pathArg(s)
      return ['edit', { path }, suffix]
    }
    case 'grep': {
      const m = /^(.*?) in (.+)$/.exec(s)
      if (!m) {
        const { text, cut } = trimToWhole(s)
        return ['grep', { pattern: text }, cut ? ' …' : '']
      }
      const { path, suffix } = pathArg(m[2])
      return ['grep', { pattern: m[1], path }, suffix]
    }
    case 'fetch':
      return ['web_fetch', { url: trimToWhole(s).text }, '']
    case 'ls':
    case 'delete': {
      const { path, suffix } = pathArg(s)
      return [base, { path }, suffix]
    }
    default: {
      const { text, cut } = trimToWhole(s)
      return [text ? `${base} ${cut ? withEllipsis(text) : text}` : base, null, '']
    }
  }
}

/** Bubble text for one parsed `[tool]` line; null when it would render nothing. */
export function describeCursorToolLine(line: CursorToolLine): { toolName: string; description: string } | null {
  const [toolName, args, suffix] = cursorToolToBubbleArgs(line.label, line.summary)
  const desc = args ? describeToolCall(toolName, args) : compactBubbleLine(toolName)
  if (!desc) return null
  return { toolName, description: `${desc}${suffix}` }
}
