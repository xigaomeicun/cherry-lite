/**
 * Cherry-Lite Telegram extras: busy auto-queue offers + callback data prefixes.
 * Kept separate from ChannelMessageHandler to limit file size.
 */

import type { ChannelMessageEvent } from './ChannelAdapter'

export type BusyOffer = {
  activeSessionId: string
  message: ChannelMessageEvent & {
    _skipBusyCheck?: boolean
    _cherryBusyCancelled?: boolean
    _cherryBusyOfferId?: string
  }
  cancelled: boolean
}

/** Shared offer map for busy auto-queue cards. */
export const busyOffers = new Map<string, BusyOffer>()

/** AskUserQuestion multi-step answers (Telegram). */
export const askUserPending = new Map<
  string,
  {
    input: {
      questions: Array<{
        question?: string
        header?: string
        options?: Array<{ label?: string; description?: string }>
      }>
      answers?: Record<string, unknown>
    }
    answers: Record<string, unknown>
    qIndex: number
  }
>()

/** Dedup generic tool-permission cards per approvalId. */
export const toolPermSent = new Set<string>()

export function escHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function normalizeToolKey(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/[_-]/g, '')
}

/** Telegram /model picker: short callback tokens → full UniqueModelId + display name.
 * Telegram callback_data is capped at 64 bytes; UUID provider ids make `mdl:${id}` truncate
 * and the confirm button was showing the truncated id instead of the friendly name.
 */
export type ModelPickEntry = { id: string; name: string }
export const modelPickTokens = new Map<string, ModelPickEntry>()

/** Remember a model for an inline-keyboard callback; returns a short opaque token. */
export function rememberModelPick(id: string, name: string): string {
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  modelPickTokens.set(token, { id, name: name || id })
  // Bound memory if users open /model repeatedly without clicking.
  if (modelPickTokens.size > 300) {
    const oldest = modelPickTokens.keys().next().value
    if (oldest !== undefined) modelPickTokens.delete(oldest)
  }
  return token
}

/** Test helper — clear model-pick tokens. */
export function resetModelPickTokensForTests(): void {
  modelPickTokens.clear()
}

export const MODEL_PICK_LIMIT = 30
