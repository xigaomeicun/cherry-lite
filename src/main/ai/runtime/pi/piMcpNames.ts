import { createHash } from 'node:crypto'

import { CHERRY_MCP_SERVER } from '@main/ai/toolApproval/builtinToolPolicy'
import { buildFunctionCallToolName } from '@shared/ai/tools/mcpToolName'

/**
 * Pure naming helpers for Pi's native MCP tools. Kept free of SDK/service imports so the naming
 * contract (and the migration of stored disabled-tool ids) can be tested in isolation.
 */

export interface PiMcpServerIdentity {
  id?: string
  name?: string
}

/**
 * Compute a compact, identifier-safe server identifier for Pi's 64-char tool-name ceiling.
 *
 * A raw 36-char UUID prefix spends 43 chars upfront (`mcp__<uuid>__`), leaving only 12 chars
 * before Pi's native `createMcpToolName` truncates and hashes the tool name.
 * We prefer a clean slug of `server.name` (e.g. 'notion', 'github').
 * If the name cannot produce a valid ASCII slug (e.g. pure CJK) or is missing,
 * we fall back to `s_${id.slice(0, 8)}` (~10 chars), leaving 45+ chars for tools.
 */
export function toPiMcpServerKey(
  server: PiMcpServerIdentity | string,
  isTaken?: (candidate: string) => boolean
): string {
  const serverObj = typeof server === 'string' ? { name: server } : server
  const name = serverObj.name?.trim()
  const slug = name
    ? name
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 20)
    : ''

  let candidate: string
  if (slug.length >= 2 && !/^[0-9]/.test(slug)) {
    candidate = slug
  } else {
    const rawId = (serverObj.id || serverObj.name || 'mcp').replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
    candidate = `s_${rawId.slice(0, 8)}`
  }

  if (isTaken && isTaken(candidate) && serverObj.id) {
    const suffix = serverObj.id
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 4)
      .toLowerCase()
    candidate = `${candidate.slice(0, 15)}_${suffix}`
  }

  return candidate
}

/** Match Pi's native MCP identifiers for policy and stored disabled-tool lookups. */
export function buildPiMcpToolName(server: PiMcpServerIdentity | string, toolName: string, collides = false): string {
  const serverKey = toPiMcpServerKey(server)
  const name = `mcp__${serverKey}__${toolName}`.replace(/[^A-Za-z0-9_]/g, '_')
  if (name.length <= 64 && !collides) return name
  const hash = createHash('sha256').update(`${serverKey}\0${toolName}`).digest('hex').slice(0, 8)
  return `${name.slice(0, 55)}_${hash}`
}

/**
 * The tool id Pi used before server keys became name slugs: the raw server UUID is the namespace,
 * sanitized as a whole (so `-` in both the UUID and the tool name become `_`) and hashed when it
 * overflows 64 chars. Stored `disabledTools` entries were written in this shape, so migration has to
 * reproduce it byte for byte rather than route through the slugging path.
 */
export function buildLegacyPiMcpToolName(serverId: string, toolName: string, collides = false): string {
  const name = `mcp__${serverId}__${toolName}`.replace(/[^A-Za-z0-9_]/g, '_')
  if (name.length <= 64 && !collides) return name
  const hash = createHash('sha256').update(`${serverId}\0${toolName}`).digest('hex').slice(0, 8)
  return `${name.slice(0, 55)}_${hash}`
}

const RESERVED_SERVER_KEYS: ReadonlySet<string> = new Set(
  Object.values(CHERRY_MCP_SERVER).map((name) => toPiMcpServerKey(name))
)

/** Identity used to look a server's key up again: UUID when it has one, otherwise its name. */
export function piMcpServerIdentity(server: PiMcpServerIdentity): string {
  return server.id ?? server.name ?? ''
}

/**
 * Assign every server a key that is unique within one agent session and does not depend on the order
 * the caller happens to iterate in. The session extension, the tool lister, the stream adapter and the
 * disabled-tool policy all have to agree on these keys, otherwise the same tool is known under two names.
 *
 * Cherry's own servers always keep their plain slug (a user server named `skills` must not shadow the
 * built-in one); user servers are then assigned in UUID order so the first keeps the plain slug and the
 * rest get an id suffix.
 */
export function resolvePiMcpServerKeys(servers: Iterable<PiMcpServerIdentity | undefined>): Map<string, string> {
  const keys = new Map<string, string>()
  const taken = new Set<string>(RESERVED_SERVER_KEYS)
  const withId: Array<PiMcpServerIdentity & { id: string }> = []

  for (const server of servers) {
    if (!server) continue
    if (server.id) {
      withId.push(server as PiMcpServerIdentity & { id: string })
    } else {
      const key = toPiMcpServerKey(server)
      keys.set(piMcpServerIdentity(server), key)
      taken.add(key)
    }
  }

  for (const server of withId.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))) {
    if (keys.has(server.id)) continue
    const base = toPiMcpServerKey(server)
    let key = base
    if (taken.has(key)) {
      const idChars = server.id.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
      // Keep the whole key within the 20-char slug cap: `buildPiMcpToolName` re-slugs its input.
      for (const length of [4, 6, 8, 10]) {
        key = `${base.slice(0, 19 - length)}_${idChars.slice(0, length)}`
        if (!taken.has(key)) break
      }
    }
    keys.set(server.id, key)
    taken.add(key)
  }

  return keys
}

/**
 * Add the current native ids for every stored disabled-tool alias of this server's tools.
 *
 * Disabled ids were persisted under three generations of naming: Pi's UUID-namespaced id, the raw
 * `mcp__<uuid>__<tool>` form, and the camelCase function-call alias. A tool that was blocked under any
 * of them must stay blocked under the slug-based id, or upgrading would silently re-enable it.
 */
export function expandPiDisabledMcpTools(
  disabled: Set<string>,
  server: { id: string; name: string },
  serverKey: string,
  toolNames: readonly string[]
): void {
  const names = toolNames.map((toolName) => buildPiMcpToolName(serverKey, toolName))
  const legacyNames = toolNames.map((toolName) => buildLegacyPiMcpToolName(server.id, toolName))
  const collides = (all: readonly string[], value: string) => all.indexOf(value) !== all.lastIndexOf(value)

  toolNames.forEach((toolName, index) => {
    const name = names[index]
    const legacyName = buildLegacyPiMcpToolName(server.id, toolName, collides(legacyNames, legacyNames[index]))
    if (
      disabled.has(name) ||
      disabled.has(legacyName) ||
      disabled.has(buildFunctionCallToolName(server.name, toolName)) ||
      disabled.has(`mcp__${server.id}__${toolName}`) ||
      disabled.has(`mcp__${server.id.replaceAll('-', '_')}__${toolName}`)
    ) {
      disabled.add(buildPiMcpToolName(serverKey, toolName, collides(names, name)))
    }
  })
}
