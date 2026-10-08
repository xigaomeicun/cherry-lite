import { application } from '@application'
import type { BridgeToolCallResult, BridgeToolDescriptor } from '@cherrystudio/dsh-bridge'
import { mcpServerService } from '@data/services/McpServerService'
import { loggerService } from '@logger'
import { MCP_FORWARDING_TIMEOUT_MS } from '@main/ai/mcp/mcpRequestOptions'
import type { AgentMcpServer } from '@main/ai/runtime/agentMcpServers'
import { CHERRY_MCP_SERVER, listBuiltinToolPolicies } from '@main/ai/toolApproval/builtinToolPolicy'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { buildMcpBridgedToolName, toWireServerName } from '@shared/ai/tools/mcpToolName'
import { BuiltinMcpServerNamesArray } from '@shared/utils/mcp'

import { dshToolResultErrorText, projectDshToolResult } from './dshToolResultProjection'

const logger = loggerService.withContext('DshCherryToolBridge')

class DshCherryToolIdentityError extends Error {}

interface DshToolBinding {
  client: Client
  rawName: string
}

export interface DshCherryToolBridge {
  tools: BridgeToolDescriptor[]
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<BridgeToolCallResult>
  close(): Promise<void>
}

export interface DshCherryToolBridgeOptions {
  agentsDataRoot: string
  toolResultRoot: string
}

/**
 * Wire server names Cherry owns: its own agent servers, and the readable aliases of the built-in
 * `@cherry/*` ones. Approval policy is keyed by wire name, so a user server that merely carries one of
 * these names must never be given it.
 */
const DSH_RESERVED_SERVER_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(CHERRY_MCP_SERVER),
  ...BuiltinMcpServerNamesArray.map(toWireServerName)
])

/**
 * Preserve MCP wire names when provider-safe; fall back to a tag + tool-name
 * shape otherwise. Shared with the Pi bridge — see `buildMcpBridgedToolName`.
 *
 * Pass `userServer` for servers the user (or the MCP catalog) defines, as opposed to Cherry's own agent
 * servers: those cannot claim a name Cherry owns.
 */
export function buildDshCherryToolName(
  serverName: string,
  toolName: string,
  options: { userServer?: boolean } = {}
): string {
  return buildMcpBridgedToolName(
    serverName,
    toolName,
    options.userServer ? { reservedServerNames: DSH_RESERVED_SERVER_NAMES } : {}
  )
}

export const DSH_AUTO_APPROVED_BRIDGED_TOOLS: ReadonlySet<string> = new Set(
  listBuiltinToolPolicies({ approval: 'auto' }).map(({ serverName, toolName }) =>
    buildDshCherryToolName(serverName, toolName)
  )
)

export const DSH_APPROVAL_REQUIRED_BRIDGED_TOOLS: ReadonlySet<string> = new Set(
  listBuiltinToolPolicies({ approval: 'required' }).map(({ serverName, toolName }) =>
    buildDshCherryToolName(serverName, toolName)
  )
)

export const DSH_NON_BYPASSABLE_APPROVAL_BRIDGED_TOOLS: ReadonlySet<string> = new Set(
  listBuiltinToolPolicies({ approval: 'required', bypassApproval: 'enforce' }).map(({ serverName, toolName }) =>
    buildDshCherryToolName(serverName, toolName)
  )
)

/** Warm user-configured catalogs before the connection snapshot captures their tool schemas. */
export async function warmDshMcpToolCatalogs(mcpIds: readonly string[]): Promise<void> {
  const catalog = application.get('McpCatalogService')
  const serverIds = new Set<string>()
  for (const idOrName of mcpIds) {
    const server = mcpServerService.findByIdOrName(idOrName)
    if (!server) {
      logger.warn('Skipping unresolvable MCP server referenced by dsh agent', { idOrName })
      continue
    }
    serverIds.add(server.id)
  }
  await Promise.allSettled([...serverIds].map((serverId) => catalog.refreshTools(serverId)))
}

/** Adapt every runtime-neutral MCP server into host-dispatched dsh native tools. */
export async function buildDshCherryToolBridge(
  servers: Record<string, AgentMcpServer>,
  options: DshCherryToolBridgeOptions
): Promise<DshCherryToolBridge> {
  const clients: Client[] = []
  const tools: BridgeToolDescriptor[] = []
  const bindings = new Map<string, DshToolBinding>()

  for (const [serverId, server] of Object.entries(servers)) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: `cherry-dsh-${serverId}`, version: '1.0.0' }, { capabilities: {} })
    try {
      await server.instance.connect(serverTransport)
      await client.connect(clientTransport)
      const result = await client.listTools()
      const serverNames = new Set<string>()
      const serverTools = result.tools.map((tool) => ({
        descriptor: toBridgeDescriptor(server.name, tool, server.id !== undefined),
        rawName: tool.name
      }))
      for (const { descriptor } of serverTools) {
        if (bindings.has(descriptor.name) || serverNames.has(descriptor.name)) {
          throw new DshCherryToolIdentityError(`Duplicate dsh Cherry tool name: ${descriptor.name}`)
        }
        serverNames.add(descriptor.name)
      }
      clients.push(client)
      for (const { descriptor, rawName } of serverTools) {
        tools.push(descriptor)
        bindings.set(descriptor.name, { client, rawName })
      }
    } catch (error) {
      await client.close().catch(() => undefined)
      if (error instanceof DshCherryToolIdentityError) {
        await Promise.allSettled(clients.map((connected) => connected.close()))
        throw error
      }
      logger.warn('Skipping unavailable MCP server for dsh session', { serverId, error })
    }
  }

  return {
    tools,
    async callTool(name, args, signal) {
      const binding = bindings.get(name)
      if (!binding) throw new Error(`Unknown dsh Cherry tool: ${name}`)
      const result = (await binding.client.callTool(
        { name: binding.rawName, arguments: toToolArguments(args) },
        undefined,
        // Forwarding only: no timeout policy at this layer — McpRuntimeService owns it (#20266).
        { signal, timeout: MCP_FORWARDING_TIMEOUT_MS }
      )) as CallToolResult
      if (result.isError) throw new Error(dshToolResultErrorText(result.content, binding.rawName))
      const text = await projectDshToolResult(result.content, binding.rawName, {
        ...options,
        ...(signal ? { signal } : {})
      })
      return { text, ...(result.structuredContent === undefined ? {} : { data: result.structuredContent }) }
    },
    async close() {
      await Promise.allSettled(clients.map((client) => client.close()))
    }
  }
}

function toBridgeDescriptor(serverName: string, tool: Tool, userServer: boolean): BridgeToolDescriptor {
  return {
    name: buildDshCherryToolName(serverName, tool.name, { userServer }),
    description: tool.description ?? '',
    inputSchema: tool.inputSchema as Record<string, unknown>
  }
}

function toToolArguments(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
}
