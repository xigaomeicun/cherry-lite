/**
 * Convert a string to camelCase, ensuring it's a valid JavaScript identifier.
 *
 * - Normalizes to lowercase first, then capitalizes word boundaries
 * - Non-alphanumeric characters are treated as word separators
 * - Non-ASCII characters are dropped (ASCII-only output)
 * - If result starts with a digit, prefixes with underscore
 *
 * @example
 * toCamelCase('my-server') // 'myServer'
 * toCamelCase('MY_SERVER') // 'myServer'
 * toCamelCase('123tool')   // '_123tool'
 */
export function toCamelCase(str: string): string {
  let result = str
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+(.)/g, (_, char) => char.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, '')

  if (result && !/^[a-zA-Z_]/.test(result)) {
    result = '_' + result
  }

  return result
}

export type McpToolNameOptions = {
  /** Prefix added before the name (e.g., 'mcp__'). Must be JS-identifier-safe. */
  prefix?: string
  /** Delimiter between server and tool parts (e.g., '_' or '__'). Must be JS-identifier-safe. */
  delimiter?: string
  /** Maximum length of the final name. Suffix numbers for uniqueness are included in this limit. */
  maxLength?: number
  /** Mutable Set for collision detection. The final name will be added to this Set. */
  existingNames?: Set<string>
}

/**
 * Build a valid JavaScript function name from server and tool names.
 * Uses camelCase for both parts.
 *
 * @param serverName - The MCP server name (optional)
 * @param toolName - The tool name
 * @param options - Configuration options
 * @returns A valid JS identifier
 */
export function buildMcpToolName(
  serverName: string | undefined,
  toolName: string,
  options: McpToolNameOptions = {}
): string {
  const { prefix = '', delimiter = '_', maxLength, existingNames } = options

  const serverPart = serverName ? toCamelCase(serverName) : ''
  const toolPart = toCamelCase(toolName)
  const baseName = serverPart ? `${prefix}${serverPart}${delimiter}${toolPart}` : `${prefix}${toolPart}`

  if (!existingNames) {
    return maxLength ? truncateToLength(baseName, maxLength) : baseName
  }

  let name = maxLength ? truncateToLength(baseName, maxLength) : baseName
  let counter = 1

  while (existingNames.has(name)) {
    const suffix = String(counter)
    const truncatedBase = maxLength ? truncateToLength(baseName, maxLength - suffix.length) : baseName
    name = `${truncatedBase}${suffix}`
    counter++
  }

  existingNames.add(name)
  return name
}

function truncateToLength(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str
  }
  return str.slice(0, maxLength).replace(/_+$/, '')
}

/**
 * Generate a unique function name from server name and tool name.
 * Format: serverName_toolName (camelCase)
 *
 * @example
 * generateMcpToolFunctionName('github', 'search_issues') // 'github_searchIssues'
 */
export function generateMcpToolFunctionName(
  serverName: string | undefined,
  toolName: string,
  existingNames?: Set<string>
): string {
  return buildMcpToolName(serverName, toolName, { existingNames })
}

const FUNCTION_CALL_TOOL_NAME_MAX_LENGTH = 63
/** `_` + a fixed-width base36 hash of the server name, reserved on truncation. */
const SERVER_DISAMBIGUATOR_LENGTH = 7

/**
 * FNV-1a 32-bit hash of the server name as a fixed-width base36 string.
 * Identifier-safe (`[0-9a-z]`) so it can sit inside a JS-identifier tool name.
 */
function hashServerName(serverName: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < serverName.length; i++) {
    h ^= serverName.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36).padStart(SERVER_DISAMBIGUATOR_LENGTH, '0').slice(-SERVER_DISAMBIGUATOR_LENGTH)
}

/**
 * Builds the legacy name-based MCP tool id used by persisted source-policy
 * rules and the Claude Code adapter. AI SDK catalog identities must use the
 * main-process `buildMcpToolWireId`, which includes stable server identity.
 *
 * Format: `mcp__{server}__{tool}` (camelCase), max 63 chars.
 *
 * When the untruncated name exceeds the cap the tail is dropped — and for long
 * server names the `__` delimiter and part of the server segment go with it. A
 * server-derived suffix (`_<hash(serverName)>`) keeps legacy ids deterministic
 * and disambiguates long server display names.
 *
 * @example
 * buildFunctionCallToolName('github', 'search_issues') // 'mcp__github__searchIssues'
 */
export function buildFunctionCallToolName(serverName: string, toolName: string): string {
  const serverPart = serverName ? toCamelCase(serverName) : ''
  const toolPart = toCamelCase(toolName)
  const baseName = serverPart ? `mcp__${serverPart}__${toolPart}` : `mcp__${toolPart}`
  if (baseName.length <= FUNCTION_CALL_TOOL_NAME_MAX_LENGTH) {
    return baseName
  }
  const suffix = `_${hashServerName(serverName)}`
  const body = truncateToLength(baseName, FUNCTION_CALL_TOOL_NAME_MAX_LENGTH - suffix.length)
  return `${body}${suffix}`
}

export type McpFunctionCallToolNameParts = {
  serverPart: string
  toolPart: string
}

/**
 * Parse MCP tool-call names in the Claude/AI-SDK format:
 * `mcp__{server}__{tool}`.
 *
 * Callers feed this raw provider payloads, where a tool name typed as `string`
 * can still be absent at runtime (see `ClaudeCodeStreamAdapter`), so a missing
 * name parses as "not an MCP name" rather than throwing.
 */
export function parseFunctionCallToolName(toolName: string | undefined): McpFunctionCallToolNameParts | null {
  if (!toolName?.startsWith('mcp__')) return null

  const rest = toolName.slice('mcp__'.length)
  const delimiterIndex = rest.lastIndexOf('__')
  if (delimiterIndex <= 0 || delimiterIndex >= rest.length - 2) return null

  return {
    serverPart: rest.slice(0, delimiterIndex),
    toolPart: rest.slice(delimiterIndex + 2)
  }
}

/** Hex chars kept from the server digest when a bridged name must be lossy. */
const BRIDGED_SERVER_TAG_LENGTH = 8
/** Hex chars kept from the (server, tool) digest — keeps same-prefix siblings distinct. */
const BRIDGED_TOOL_TAG_LENGTH = 4
/** `mcp__s` + server tag + `__` + `_` + tool tag. */
const BRIDGED_TAG_OVERHEAD = 5 + 1 + BRIDGED_SERVER_TAG_LENGTH + 2 + 1 + BRIDGED_TOOL_TAG_LENGTH
/** Tool-name budget once the tags are paid for. */
const BRIDGED_TOOL_PART_MAX_LENGTH = FUNCTION_CALL_TOOL_NAME_MAX_LENGTH - BRIDGED_TAG_OVERHEAD
/** Tail cap of the fully-lossy fallback kept for names that still do not fit. */
const BRIDGED_FALLBACK_PREFIX_LENGTH = 50
const BRIDGED_FALLBACK_TAG_LENGTH = 12

/**
 * FNV-1a extended to `length` hex chars by folding each 32-bit word back in.
 *
 * Hand-rolled on purpose: this module is bundled into the renderer (see
 * `parseFunctionCallToolName` callers), so `node:crypto` is not an option.
 * Identifier-safe (`[0-9a-f]`), so it can sit inside a tool name.
 */
function fnv1aHex(value: string, length: number): string {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  let out = ''
  while (out.length < length) {
    out += (h >>> 0).toString(16).padStart(8, '0')
    // Fold the last emitted digit back in so the next word is not a constant.
    h = Math.imul(h ^ out.charCodeAt(out.length - 1), 0x01000193)
  }
  return out.slice(0, length)
}

/**
 * Name an MCP tool for a model-facing runtime bridge (DSH, Pi) while staying
 * inside the provider's function-name limit.
 *
 * A provider-safe wire name passes through untouched. When it does not fit, the
 * server name collapses to a short digest tag and the budget is spent on the
 * **tool** name instead: a model can only act on the tool name, while server
 * identity merely has to stay distinguishable. The 4-hex tool digest keeps
 * same-prefix siblings apart, preserving the fail-closed uniqueness the
 * previous fully-lossy `_<digest>` tail provided.
 *
 * Names that still do not fit — or that slug to nothing, e.g. CJK — keep the
 * fully-lossy shape, so no two identities are ever silently merged.
 *
 * @example
 * buildMcpBridgedToolName('github', 'search_issues')            // 'mcp__github__search_issues'
 * buildMcpBridgedToolName('<36-char uuid>', 'create_database')  // 'mcp__s1a2b3c4d__createDatabase_9f3e'
 */
export function buildMcpBridgedToolName(serverName: string, toolName: string): string {
  const wireName = `mcp__${serverName}__${toolName}`
  if (/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(wireName)) return wireName

  const toolPart = toCamelCase(toolName)
  if (toolPart && toolPart.length <= BRIDGED_TOOL_PART_MAX_LENGTH) {
    const serverTag = fnv1aHex(serverName, BRIDGED_SERVER_TAG_LENGTH)
    const toolTag = fnv1aHex(`${serverName}\0${toolName}`, BRIDGED_TOOL_TAG_LENGTH)
    return `mcp__s${serverTag}__${toolPart}_${toolTag}`
  }

  const prefix = `mcp__${toCamelCase(serverName)}__${toolPart}`.replace(/[^A-Za-z0-9_-]/g, '')
  const safePrefix = /^[A-Za-z_]/.test(prefix) ? prefix : `mcp_${prefix}`
  const tail = fnv1aHex(`${serverName}\0${toolName}`, BRIDGED_FALLBACK_TAG_LENGTH)
  return `${safePrefix.slice(0, BRIDGED_FALLBACK_PREFIX_LENGTH).replace(/_+$/, '')}_${tail}`
}
