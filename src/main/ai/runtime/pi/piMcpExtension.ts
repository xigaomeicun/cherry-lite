import { application } from '@application'
import { mcpServerService } from '@data/services/McpServerService'
import type { ExtensionFactory, McpTransportFactory } from '@earendil-works/pi-coding-agent'
import { loggerService } from '@logger'
import { MCP_FORWARDING_TIMEOUT_MS } from '@main/ai/mcp/mcpRequestOptions'
import type { AgentMcpServer } from '@main/ai/runtime/agentMcpServers'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { piMcpServerIdentity, resolvePiMcpServerKeys } from './piMcpNames'
import type { loadPiSdk } from './piSdk'

const logger = loggerService.withContext('PiMcpExtension')

export {
  buildLegacyPiMcpToolName,
  buildPiMcpToolName,
  expandPiDisabledMcpTools,
  resolvePiMcpServerKeys,
  toPiMcpServerKey
} from './piMcpNames'

export async function warmMcpToolCatalogs(mcpIds: readonly string[]): Promise<void> {
  const catalog = application.get('McpCatalogService')
  const serverIds = new Set<string>()
  for (const idOrName of mcpIds) {
    const server = mcpServerService.findByIdOrName(idOrName)
    if (!server) {
      logger.warn('Skipping unresolvable MCP server referenced by agent', { idOrName })
      continue
    }
    serverIds.add(server.id)
  }
  await Promise.allSettled([...serverIds].map((serverId) => catalog.refreshTools(serverId)))
}

/** Cherry owns server configuration; Pi owns MCP discovery, tool execution, results and teardown. */
export function createPiMcpExtension(
  pi: Awaited<ReturnType<typeof loadPiSdk>>,
  servers: Record<string, AgentMcpServer>,
  logPath: string
): ExtensionFactory {
  // Compact, provider-safe server keys stay inside Pi's 64-char tool-name ceiling. They are resolved once
  // for the whole set, in an order-independent way, so policy and tool listing see the same names.
  const keys = resolvePiMcpServerKeys(Object.values(servers))
  const runtimeServers = new Map<string, AgentMcpServer>()
  for (const server of Object.values(servers)) {
    runtimeServers.set(keys.get(piMcpServerIdentity(server))!, server)
  }
  return pi.createMcpExtension({
    logPath,
    loadConfig: () => ({
      servers: [...runtimeServers.keys()].map((name) => ({
        name,
        scope: 'extension' as const,
        source: 'Cherry Studio',
        config: {
          command: 'cherry-in-memory',
          exposure: 'codemode' as const,
          timeout: MCP_FORWARDING_TIMEOUT_MS / 1000
        }
      })),
      errors: []
    }),
    createTransport: (entry) => {
      const server = runtimeServers.get(entry.name)!
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      return {
        async start() {
          await server.instance.connect(serverTransport)
          await clientTransport.start()
        },
        send: (message) => clientTransport.send(message as Parameters<InMemoryTransport['send']>[0]),
        close: () => clientTransport.close(),
        onMessage(listener) {
          clientTransport.onmessage = (message) => listener(message as Parameters<typeof listener>[0])
          return () => {
            clientTransport.onmessage = undefined
          }
        },
        onError(listener) {
          clientTransport.onerror = listener
          return () => {
            clientTransport.onerror = undefined
          }
        },
        onClose(listener) {
          clientTransport.onclose = listener
          return () => {
            clientTransport.onclose = undefined
          }
        }
      } satisfies ReturnType<McpTransportFactory>
    }
  })
}
