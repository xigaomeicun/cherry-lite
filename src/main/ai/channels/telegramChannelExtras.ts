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

export const MODEL_PICK_LIMIT = 30
