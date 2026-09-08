import type { CompoundIcon } from '@cherrystudio/ui'
import { Bailian, Modelscope } from '@cherrystudio/ui/icons/providers'
import type { McpServer } from '@shared/data/types/mcpServer'

export interface SyncResult {
  success: boolean
  message: string
  allServers: McpServer[]
}

export interface ProviderConfig {
  key: string
  /** i18n key for provider name, or plain text if not starting with 'provider.' */
  nameKey: string
  discoverUrl: string
  apiKeyUrl: string
  tokenFieldName: string
  getToken: () => string | null
  saveToken: (token: string) => void
  syncServers: (token: string) => Promise<SyncResult>
}

export const providers: ProviderConfig[] = []

/**
 * Helper function to get the display name for a provider.
 * Translates if nameKey starts with 'provider.', otherwise returns as-is.
 */
export const getProviderDisplayName = (provider: ProviderConfig, t: (key: string) => string): string => {
  return provider.nameKey.startsWith('provider.') ? t(provider.nameKey) : provider.nameKey
}

const MCP_PROVIDER_ICONS: Record<string, CompoundIcon> = {
  modelscope: Modelscope,
  bailian: Bailian
}

export function getMcpProviderLogo(providerKey: string): CompoundIcon | undefined {
  return MCP_PROVIDER_ICONS[providerKey]
}
