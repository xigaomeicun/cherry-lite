import path from 'node:path'

export const BUBBLE_LINE_MAX = 300
export const BUBBLE_MAX_CHARS = 900

/**
 * Normalize tool name:
 * Strips mcp__ prefix, replaces __ with /, and converts to lowercase.
 * e.g. "mcp__cherry-tools__web_search" -> "cherry-tools/web_search" -> "web_search"
 */
export function normalizeToolName(name: string): string {
  if (!name) return ''
  const stripped = name.replace(/^mcp__/, '')
  const lastPart = stripped.includes('__') ? stripped.split('__').pop()! : stripped
  return lastPart.toLowerCase().trim()
}

/**
 * Collapse multiple whitespaces and newlines into a single space, hard-capping length.
 */
export function compactBubbleLine(text: string, maxLen = BUBBLE_LINE_MAX): string {
  if (!text) return ''
  const singleLine = text
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (singleLine.length <= maxLen) return singleLine
  return `${singleLine.slice(0, maxLen - 1)}…`
}

const SILENT_TOOLS = new Set([
  'store_memory',
  'memory',
  'agent-memory',
  'agent_memory',
  'persistent_memory',
  'report_intent',
  'read_agent',
  'write_agent',
  'list_agents',
  'read_bash',
  'write_bash',
  'stop_bash'
])

/**
 * Generate human-readable status line for active tool execution.
 * Returns null if the tool should run silently without lighting up the progress bubble.
 */
export function describeToolCall(toolName: string, args?: Record<string, unknown> | null): string | null {
  if (!toolName) return null
  const normName = normalizeToolName(toolName)

  if (SILENT_TOOLS.has(normName) || normName.endsWith('memory')) {
    return null
  }

  if (!args || typeof args !== 'object') {
    return compactBubbleLine(normName.replace(/_/g, ' '))
  }

  try {
    const rawFile =
      args.TargetFile || args.AbsolutePath || args.path || args.filePath || args.file_path || args.file || ''
    const fileParam = typeof rawFile === 'string' ? rawFile : ''
    const fileBase = fileParam ? path.basename(fileParam) : ''

    switch (normName) {
      case 'bash':
      case 'powershell':
      case 'shell': {
        const cmd = String(args.command || '')
        const first =
          cmd
            .split('\n')
            .map((l) => l.trim())
            .find(Boolean) || cmd
        return compactBubbleLine(first)
      }

      case 'grep': {
        const pat = String(args.pattern || '')
        const glob = args.glob ? ` ${args.glob}` : fileBase ? ` ${fileBase}` : ''
        return compactBubbleLine(`grep "${pat}"${glob}`)
      }

      case 'glob': {
        const pat = String(args.pattern || '')
        return compactBubbleLine(`glob ${pat}`)
      }

      case 'view':
      case 'view_file':
      case 'read_file':
      case 'read': {
        return fileBase ? `view ${fileBase}` : 'view'
      }

      case 'edit':
      case 'replace_file_content':
      case 'multi_replace_file_content':
      case 'write_file':
      case 'write_to_file':
      case 'write':
      case 'search_replace':
      case 'strreplace': {
        return fileBase ? `edit ${fileBase}` : 'edit'
      }

      case 'create': {
        return fileBase ? `create ${fileBase}` : 'create'
      }

      case 'task':
      case 'taskcreate':
      case 'taskupdate': {
        const desc = args.description || args.agent_type || args.subject || ''
        return desc ? compactBubbleLine(`task: ${desc}`) : 'task'
      }

      case 'web_fetch':
      case 'webfetch':
      case 'fetch': {
        const urlStr = typeof args.url === 'string' ? args.url : ''
        try {
          return `fetch ${new URL(urlStr).hostname}`
        } catch {
          return 'fetch'
        }
      }

      case 'web_search':
      case 'websearch':
      case 'search': {
        const query = typeof args.query === 'string' ? args.query : ''
        return query ? compactBubbleLine(`search ${query}`) : 'search'
      }

      case 'sql': {
        const desc = args.description || 'sql'
        return compactBubbleLine(String(desc))
      }

      case 'skill': {
        return args.skill ? `skill: ${args.skill}` : 'skill'
      }

      case 'ask_user':
      case 'askuserquestion':
      case 'builtinaskuserquestion': {
        return 'waiting for input'
      }

      default: {
        const cleanName = normName.replace(/_/g, ' ')
        if (fileBase) {
          return compactBubbleLine(`${cleanName} ${fileBase}`)
        }
        return compactBubbleLine(cleanName)
      }
    }
  } catch {
    return compactBubbleLine(normName.replace(/_/g, ' '))
  }
}
