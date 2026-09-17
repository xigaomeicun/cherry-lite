import { useCommandHandler } from '@renderer/hooks/command'
import { useIsActiveTab } from '@renderer/hooks/tab'

export function ComposerFocusShortcut({
  focus,
  editable = true
}: {
  focus: () => void
  editable?: boolean
  composerEmpty?: boolean
}) {
  const isActiveTab = useIsActiveTab()
  useCommandHandler('chat.input.focus', focus, { enabled: isActiveTab && editable })

  return null
}
