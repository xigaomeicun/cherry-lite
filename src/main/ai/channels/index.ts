export type {
  ChannelAdapterConfig,
  ChannelCallbackQueryEvent,
  ChannelCommandEvent,
  ChannelCommandName,
  ChannelInlineKeyboard,
  ChannelMessageEvent,
  SendMessageOptions
} from './ChannelAdapter'
export { ChannelAdapter } from './ChannelAdapter'
export { resolveLocalFile } from './security/localFileResolver'
export { sanitizeChannelOutput } from './security/OutputSanitizer'
export { resolveWorkspaceFile } from './security/WorkspaceFileGuard'
export type { BusyOffer } from './telegramChannelExtras'
export {
  askUserPending,
  busyOffers,
  escHtml,
  MODEL_PICK_LIMIT,
  normalizeToolKey,
  toolPermSent
} from './telegramChannelExtras'
// ChannelMessageHandler / ChannelManager after sanitize + extras so stream listeners
// can import the barrel without hitting an incomplete circular graph.
export { ChannelManager, registerAdapterFactory } from './ChannelManager'
export { ChannelMessageHandler, channelMessageHandler } from './ChannelMessageHandler'
