import { CommandShortcut } from '@renderer/components/command'
import { useCommandHandler, useResolvedCommand } from '@renderer/hooks/command'
import { useIsActiveTab } from '@renderer/hooks/tab'
import { useTranslation } from 'react-i18next'

/**
 * ⌘I affordance for an EMPTY, unfocused composer.
 *
 * Two layout constraints, both load-bearing:
 *
 * - `absolute` — as a flow sibling it takes width from the editor, which drags the editor's own
 *   scrollbar away from the composer's right edge and leaves it visibly inset while the hint shows.
 * - empty-only — out of flow it would otherwise sit on top of the first line's tail whenever the
 *   composer is blurred with a draft still in it.
 *
 * The focused case is handled in CSS (`group-has-[:focus]/composer-editor:hidden`) so the hint
 * disappears on the very first keystroke without a re-render.
 */
export function ComposerFocusShortcut({
  focus,
  editable = true,
  composerEmpty
}: {
  focus: () => void
  editable?: boolean
  /** Whether the composer holds no text yet — the only state where the hint cannot overlap content. */
  composerEmpty: boolean
}) {
  const { t } = useTranslation()
  const isActiveTab = useIsActiveTab()
  const { shortcutLabel } = useResolvedCommand('chat.input.focus')
  useCommandHandler('chat.input.focus', focus, { enabled: isActiveTab && editable })

  if (!editable || !composerEmpty || !shortcutLabel) return null

  return (
    <span className="[[data-composer-presentation=compact]_&]:-translate-y-1/2 pointer-events-none absolute top-2 right-8 z-1 flex h-5 select-none items-center gap-1 text-foreground-tertiary text-xs group-has-[:focus]/composer-editor:hidden [[data-composer-presentation=compact]_&]:top-1/2">
      <CommandShortcut
        command="chat.input.focus"
        className="h-5 rounded-md bg-muted/50 px-1.5 font-normal text-foreground-tertiary"
      />
      {t('chat.input.focus_hint')}
    </span>
  )
}
