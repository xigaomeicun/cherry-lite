export const SLASH_COMMANDS = [
  { name: 'new', description: '🆕 开启全新会话' },
  { name: 'stop', description: '✋ 终止当前任务' },
  { name: 'model', description: '🧠 切换底座模型' },
  { name: 'switch', description: '🤖 切换执行后端' },
  { name: 'mode', description: '🎮 切换权限模式' },
  { name: 'status', description: '📊 查看当前状态' },
  { name: 'rename', description: '✏️ 命名当前会话' },
  { name: 'compact', description: '🗜️ 压缩会话记忆' },
  { name: 'reboot', description: '🧿 重启樱桃服务' }
] as const

/**
 * Every command a transport can dispatch. Detection is a transport concern; the menu list above
 * is a Telegram concern. Discord / Slack / WeChat / QQ / Feishu gate `emit('command')` behind
 * `isSlashCommand`, so trimming a command out of the Telegram menu must NOT remove it from this
 * vocabulary — doing so silently broke `/help` and `/whoami` on all five of those channels while
 * looking like a menu-only change. Keep this a superset of `SLASH_COMMANDS`.
 */
const DETECTED_COMMANDS = [
  'new',
  'compact',
  'help',
  'whoami',
  'stop',
  'model',
  'switch',
  'mode',
  'status',
  'rename',
  'reboot'
] as const

const COMMAND_REGEX = new RegExp(`^\\/(${DETECTED_COMMANDS.join('|')})\\b`)

export function isSlashCommand(text: string): boolean {
  return COMMAND_REGEX.test(text)
}
