import { toast } from '@renderer/services/toast'
import type { ExportableMessage } from '@renderer/types/messageExport'
import type { Topic } from '@renderer/types/topic'
import i18next from 'i18next'

export const copyTopicAsMarkdown = async (topic: Topic) => {
  const { topicToMarkdown } = await import('./ExportService')
  const markdown = await topicToMarkdown(topic)
  await navigator.clipboard.writeText(markdown)
  toast.success(i18next.t('message.copy.success'))
}

export const copyTopicAsPlainText = async (topic: Topic) => {
  const { topicToPlainText } = await import('./ExportService')
  const plainText = await topicToPlainText(topic)
  await navigator.clipboard.writeText(plainText)
  toast.success(i18next.t('message.copy.success'))
}

export const copyMessageAsPlainText = async (message: ExportableMessage) => {
  const { messageToPlainText } = await import('@renderer/utils/export')
  const plainText = await messageToPlainText(message)
  await navigator.clipboard.writeText(plainText)
  toast.success(i18next.t('message.copy.success'))
}

/**
 * 复制会话 ID —— 用于把某个 Agent 会话 / Topic 的 UUID 交给外部工具定位
 * （如 cherrystudio-ops 的 cherry-session-tool.py --session <UUID>）。
 */
export const copySessionId = async (sessionId: string) => {
  await navigator.clipboard.writeText(sessionId)
  toast.success(i18next.t('message.copy.success'))
}
