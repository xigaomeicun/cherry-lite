/**
 * Cherry-Lite Telegram extras: busy auto-queue offers + callback data prefixes.
 * Kept separate from ChannelMessageHandler to limit file size.
 */

import { t } from '@main/i18n'

import type { ChannelInlineKeyboard, ChannelMessageEvent } from './ChannelAdapter'

export type BusyOffer = {
  activeSessionId: string
  message: ChannelMessageEvent & {
    _skipBusyCheck?: boolean
    _cherryBusyCancelled?: boolean
    _cherryBusyOfferId?: string
  }
  cancelled: boolean
  /** 1-based position among pending cards for this session when the card was sent. */
  queueIndex: number
}

/** Shared offer map for busy auto-queue cards. */
export const busyOffers = new Map<string, BusyOffer>()

/** Keep the card well under Telegram's 4096-char limit. */
const BUSY_CARD_PREVIEW_MAX = 3000

function busyCardPreview(message: ChannelMessageEvent): string {
  const text = (message.text ?? '').trim()
  const extras = [
    ...(message.images?.length ? [`[🖼 ×${message.images.length}]`] : []),
    ...(message.files?.length ? [`[📎 ×${message.files.length}]`] : [])
  ].join(' ')
  const body = text.length > BUSY_CARD_PREVIEW_MAX ? `${text.slice(0, BUSY_CARD_PREVIEW_MAX)}…` : text
  return [body, extras].filter(Boolean).join('\n') || '…'
}

/** Plain-text confirmation card shown when a Telegram message arrives while a turn is running. */
export function buildBusyCardText(queueIndex: number, message: ChannelMessageEvent): string {
  return [
    t('common.channel_busy.title', { n: queueIndex }),
    '',
    busyCardPreview(message),
    '',
    t('common.channel_busy.steer_hint'),
    t('common.channel_busy.send_hint'),
    t('common.channel_busy.cancel_hint')
  ].join('\n')
}

/** Card text after a choice: same header + message, hints replaced by the result. */
export function buildBusyResultText(queueIndex: number, message: ChannelMessageEvent, result: string): string {
  return [t('common.channel_busy.title', { n: queueIndex }), '', busyCardPreview(message), '', result].join('\n')
}

export function buildBusyCardKeyboard(offerId: string): ChannelInlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: t('common.channel_busy.btn_steer'), callback_data: `busy:steer:${offerId}` },
        { text: t('common.channel_busy.btn_send'), callback_data: `busy:send:${offerId}` },
        { text: t('common.channel_busy.btn_cancel'), callback_data: `busy:cancel:${offerId}` }
      ]
    ]
  }
}

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
