import CodeViewer from '@renderer/components/CodeViewer'
import { getLanguageByFilePath } from '@renderer/utils/codeLanguage'

import { AgentToolsType, type WriteToolInput, type WriteToolOutput } from '../shared/agentToolTypes'
import { ClickableFilePath } from '../shared/ClickableFilePath'
import { SkeletonValue, ToolHeader } from '../shared/GenericTools'
import type { ToolDisclosureItem } from '../shared/ToolDisclosure'

export function WriteTool({
  input,
  output,
  hasError
}: {
  input?: WriteToolInput
  output?: WriteToolOutput
  hasError?: boolean
}): ToolDisclosureItem {
  const rawInput = input as unknown as Record<string, unknown> | undefined
  const filePath = typeof rawInput?.file_path === 'string' ? rawInput.file_path : typeof rawInput?.path === 'string' ? rawInput.path : undefined
  const filename = filePath?.split('/').pop()
  const language = getLanguageByFilePath(filePath ?? '')
  // A Write creates the file: keep the path inert until the call finishes
  // successfully (output present and no error). While streaming the file may
  // not exist yet, and a failed write never created it — so neither is clickable.
  const fileWritten = output !== undefined && !hasError

  return {
    key: AgentToolsType.Write,
    label: (
      <ToolHeader
        toolName={AgentToolsType.Write}
        args={input}
        params={
          <SkeletonValue
            value={
              filePath ? (
                <ClickableFilePath path={filePath} displayName={filename} interactive={fileWritten} />
              ) : undefined
            }
            width="200px"
          />
        }
        variant="collapse-label"
        showStatus={false}
      />
    ),
    children: input ? (
      <CodeViewer
        value={input.content ?? ''}
        language={language}
        expanded={false}
        wrapped={false}
        maxHeight={240}
        options={{ lineNumbers: true }}
      />
    ) : (
      <SkeletonValue value={null} width="100%" fallback={null} />
    )
  }
}
