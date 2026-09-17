import { agentSessionService } from '@data/services/AgentSessionService'

import { type BrowserGuestContext, BrowserGuestRegistry, type BrowserGuestTarget } from './BrowserGuestRegistry'

export interface AgentBrowserContext {
  agentId: string
  sessionId: string
}

export type AgentBrowserTarget = BrowserGuestTarget

export class AgentBrowserRegistry extends BrowserGuestRegistry {
  constructor(claims?: Map<Electron.WebContents, BrowserGuestTarget>) {
    super((id) => agentSessionService.getById(id).agentId ?? '', 'agent', claims)
  }

  override get(context: AgentBrowserContext | BrowserGuestContext) {
    return super.get('agentId' in context ? { ownerId: context.agentId, sessionId: context.sessionId } : context)
  }

  override ensureGuest(context: AgentBrowserContext | BrowserGuestContext, signal: AbortSignal, url?: string) {
    return super.ensureGuest(
      'agentId' in context ? { ownerId: context.agentId, sessionId: context.sessionId } : context,
      signal,
      url
    )
  }
}
