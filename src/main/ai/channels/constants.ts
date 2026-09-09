export const SLASH_COMMANDS = [
  { name: 'new', description: '🆕 开启全新会话' },
  { name: 'stop', description: '✋ 终止当前生成' },
  { name: 'model', description: '🧠 切换底座模型' },
  { name: 'switch', description: '🤖 切换执行后端' },
  { name: 'mode', description: '🎮 切换权限模式' },
  { name: 'status', description: '📊 查看当前状态' },
  { name: 'rename', description: '✏️ 命名当前会话' },
  { name: 'compact', description: '🗜️ 压缩会话记忆' }
] as const

const COMMAND_REGEX = new RegExp(`^\\/(${SLASH_COMMANDS.map((c) => c.name).join('|')})\\b`)

export function isSlashCommand(text: string): boolean {
  return COMMAND_REGEX.test(text)
}
