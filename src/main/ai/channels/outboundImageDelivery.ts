/**
 * Cross-path dedupe for outbound channel images.
 *
 * The same workspace image can leave via two exits in one turn:
 * - `notify(file_path)` → adapter.sendFile / sendImage
 * - ChannelAdapterListener body extract → adapter.sendImage
 *
 * Within a (channelId, chatId) pair we remember realpath-normalized paths so
 * each image is delivered at most once (prefer photo via sendImage).
 */

const deliveredByChat = new Map<string, Set<string>>()

function chatKey(channelId: string, chatId: string): string {
  return `${channelId}\0${chatId}`
}

/** Whether this chat already delivered the given realpath. */
export function hasOutboundImageDelivered(channelId: string, chatId: string, canonicalPath: string): boolean {
  return deliveredByChat.get(chatKey(channelId, chatId))?.has(canonicalPath) === true
}

/** Record a successful image delivery for this chat. */
export function markOutboundImageDelivered(channelId: string, chatId: string, canonicalPath: string): void {
  const key = chatKey(channelId, chatId)
  let set = deliveredByChat.get(key)
  if (!set) {
    set = new Set()
    deliveredByChat.set(key, set)
  }
  set.add(canonicalPath)
}

/** Test helper — clear all tracked deliveries. */
export function resetOutboundImageDeliveryForTests(): void {
  deliveredByChat.clear()
}
