import type { EditToolInput, EditToolOutput } from '../shared/agentToolTypes'
import { AgentToolsType } from '../shared/agentToolTypes'
import { ClickableFilePath } from '../shared/ClickableFilePath'
import { ToolHeader } from '../shared/GenericTools'
import type { ToolDisclosureItem } from '../shared/ToolDisclosure'
import { AgentFileDiffView } from './AgentFileDiffView'

function EditToolChildren({ input, output }: { input?: EditToolInput; output?: EditToolOutput }) {
  const outputText = typeof output === 'string' ? output : undefined
  const rawInput = input as unknown as Record<string, unknown> | undefined
  const filePath = typeof rawInput?.file_path === 'string' ? rawInput.file_path : typeof rawInput?.path === 'string' ? rawInput.path : undefined
  const rawEdits = Array.isArray(rawInput?.edits) ? rawInput.edits : undefined
  const hunks = rawEdits
    ? rawEdits.map((e) => {
        const edit = e as Record<string, unknown>
        return {
          oldString: typeof edit.old_string === 'string' ? edit.old_string : typeof edit.oldText === 'string' ? edit.oldText : undefined,
          newString: typeof edit.new_string === 'string' ? edit.new_string : typeof edit.newText === 'string' ? edit.newText : undefined
        }
      })
    : [
        {
          oldString: input?.old_string,
          newString: input?.new_string
        }
      ]

  return (
    <AgentFileDiffView
      filePath={filePath}
      hunks={hunks}>
      {outputText}
    </AgentFileDiffView>
  )
}

export function EditTool({ input, output }: { input?: EditToolInput; output?: EditToolOutput }): ToolDisclosureItem {
  const rawInput = input as unknown as Record<string, unknown> | undefined
  const filePath = typeof rawInput?.file_path === 'string' ? rawInput.file_path : typeof rawInput?.path === 'string' ? rawInput.path : undefined
  const filename = filePath?.split('/').pop()

  return {
    key: AgentToolsType.Edit,
    label: (
      <ToolHeader
        toolName={AgentToolsType.Edit}
        args={input}
        params={filePath ? <ClickableFilePath path={filePath} displayName={filename} /> : undefined}
        variant="collapse-label"
        showStatus={false}
      />
    ),
    children: <EditToolChildren input={input} output={output} />
  }
}
