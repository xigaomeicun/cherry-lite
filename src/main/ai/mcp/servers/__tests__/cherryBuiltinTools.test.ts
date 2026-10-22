import { WebSearchConfigError, type WebSearchConfigErrorCode } from '@main/services/webSearch'
import type { ImageGenerationSupport } from '@shared/data/types/model'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getImageGenerationSupport, getModelByKey, loggerWarn } = vi.hoisted(() => ({
  getImageGenerationSupport: vi.fn(),
  getModelByKey: vi.fn(),
  loggerWarn: vi.fn()
}))

const searchKeywords = vi.fn()
const fetchUrls = vi.fn()
const kbSearch = vi.fn()
const kbReadConcept = vi.fn()
const kbGrepConcept = vi.fn()
const kbGetOrganizationTree = vi.fn()
const kbAddItems = vi.fn()
const kbDeleteConcepts = vi.fn()
const kbRefreshConcepts = vi.fn()
const listBasesForDiscovery = vi.fn()
const listRootItems = vi.fn()
const getPreference = vi.fn()
const generateImage = vi.fn()
const fileRead = vi.fn()
vi.mock('@data/services/ModelService', () => ({
  modelService: { getByKey: getModelByKey }
}))

vi.mock('@data/services/ProviderRegistryService', () => ({
  providerRegistryService: { getImageGenerationSupport }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), error: vi.fn(), warn: loggerWarn, debug: vi.fn(), silly: vi.fn() })
  }
}))

vi.mock('@application', () => ({
  application: {
    get: (name: string) => {
      if (name === 'WebSearchService') return { searchKeywords, fetchUrls }
      if (name === 'KnowledgeService') {
        return {
          search: kbSearch,
          readConcept: kbReadConcept,
          grepConcept: kbGrepConcept,
          getOrganizationTree: kbGetOrganizationTree,
          addItems: kbAddItems,
          deleteConcepts: kbDeleteConcepts,
          refreshConcepts: kbRefreshConcepts,
          listBasesForDiscovery,
          listRootItems
        }
      }
      if (name === 'PreferenceService') return { get: getPreference }
      if (name === 'AiService') return { generateImage }
      if (name === 'FileManager') return { read: fileRead }
      throw new Error(`unexpected service: ${name}`)
    }
  }
}))

const {
  callCherryBuiltinTool: callCherryBuiltinToolRaw,
  listCherryBuiltinTools: listCherryBuiltinToolsRaw,
  CherryBuiltinToolsServer
} = await import('../cherryBuiltinTools')
const { WEB_LOOKUP_ERROR_NOTE } = await import('@main/ai/tools/webLookup')

const signal = new AbortController().signal

// (cherry-lite) the kb_* tools were removed with the knowledge-base feature.
const callCherryBuiltinTool = (name: string, args: unknown, sig: AbortSignal) =>
  callCherryBuiltinToolRaw(name, args, sig)
const listCherryBuiltinTools = () => listCherryBuiltinToolsRaw()

function webResponse() {
  return {
    providerId: 'tavily',
    capability: 'searchKeywords',
    inputs: ['q'],
    results: [{ title: 'A', url: 'https://a.com', content: 'about A', sourceInput: 'q' }]
  }
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const part = result.content[0]
  return part.type === 'text' ? (part.text ?? '') : ''
}

describe('cherryBuiltinTools', () => {
  beforeEach(() => {
    searchKeywords.mockReset()
    fetchUrls.mockReset()
    kbSearch.mockReset()
    kbReadConcept.mockReset()
    kbGrepConcept.mockReset()
    kbGetOrganizationTree.mockReset()
    kbAddItems.mockReset()
    kbDeleteConcepts.mockReset()
    kbRefreshConcepts.mockReset()
    listBasesForDiscovery.mockReset()
    listRootItems.mockReset()
    getPreference.mockReset()
    generateImage.mockReset()
    fileRead.mockReset()
    getImageGenerationSupport.mockReset()
    getModelByKey.mockReset()
    getModelByKey.mockReturnValue({})
    getImageGenerationSupport.mockReturnValue(null)
    loggerWarn.mockReset()
  })

  it('advertises builtin tools with object input schemas and no $schema marker', () => {
    const tools = listCherryBuiltinTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['generate_image', 'report_artifacts', 'web_fetch', 'web_search'])
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.description).toBeTruthy()
      expect((tool.inputSchema as Record<string, unknown>).$schema).toBeUndefined()
    }
  })

  it('routes web_search through WebSearchService and returns mapped json content', async () => {
    searchKeywords.mockResolvedValue(webResponse())

    const result = await callCherryBuiltinTool('web_search', { query: 'hello' }, signal)

    expect(searchKeywords).toHaveBeenCalledWith({ keywords: ['hello'] }, { signal })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(textOf(result))).toEqual([
      { id: expect.stringMatching(/^[0-9a-f]{8}-1$/), title: 'A', url: 'https://a.com', content: 'about A' }
    ])
  })

  it('routes web_fetch through WebSearchService', async () => {
    fetchUrls.mockResolvedValue(webResponse())

    const result = await callCherryBuiltinTool('web_fetch', { urls: ['https://a.com'] }, signal)

    expect(fetchUrls).toHaveBeenCalledWith({ urls: ['https://a.com'] }, { signal })
    expect(JSON.parse(textOf(result))).toHaveLength(1)
  })

  it('surfaces the retry note (not an error) when a web lookup fails', async () => {
    searchKeywords.mockRejectedValue(new Error('upstream 503'))

    const result = await callCherryBuiltinTool('web_search', { query: 'hello' }, signal)

    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toBe(WEB_LOOKUP_ERROR_NOTE)
  })

  it('propagates AbortError instead of converting cancellation into an MCP error result', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' })
    searchKeywords.mockRejectedValue(abortError)

    await expect(callCherryBuiltinTool('web_search', { query: 'hello' }, signal)).rejects.toBe(abortError)
  })

  it('propagates an aborted signal even when the provider rejects with a normal error', async () => {
    const controller = new AbortController()
    const error = new Error('socket closed after abort')
    controller.abort()
    searchKeywords.mockRejectedValue(error)

    await expect(callCherryBuiltinTool('web_search', { query: 'hello' }, controller.signal)).rejects.toBe(error)
  })

  it('steers away from retrying when no web search provider is configured', async () => {
    searchKeywords.mockRejectedValue(
      new WebSearchConfigError(
        'provider_not_configured',
        'Default web search provider is not configured for capability searchKeywords'
      )
    )

    const result = await callCherryBuiltinTool('web_search', { query: 'hello' }, signal)

    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain('No usable web search provider')
    expect(textOf(result)).toContain('do not retry')
  })

  it('steers away from retrying when the configured provider lacks the capability', async () => {
    // The second permanent failure from getProviderForCapability — equally non-retryable.
    searchKeywords.mockRejectedValue(
      new WebSearchConfigError(
        'capability_unsupported',
        'Web search provider tavily does not support capability searchKeywords'
      )
    )

    const result = await callCherryBuiltinTool('web_search', { query: 'hello' }, signal)

    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain('No usable web search provider')
    expect(textOf(result)).toContain('do not retry')
  })

  it('treats an unknown provider id and an unimplemented capability as permanent too', async () => {
    // The other two permanent throws (config getProviderById / WebSearchService) — both non-retryable.
    for (const [code, message] of [
      ['provider_unknown', 'Unknown web search provider: stale-id'],
      ['capability_unsupported', 'Web search provider tavily does not implement capability searchKeywords']
    ] satisfies Array<[WebSearchConfigErrorCode, string]>) {
      searchKeywords.mockReset()
      searchKeywords.mockRejectedValue(new WebSearchConfigError(code, message))
      const result = await callCherryBuiltinTool('web_search', { query: 'hello' }, signal)
      expect(textOf(result)).toContain('No usable web search provider')
      expect(textOf(result)).toContain('do not retry')
    }
  })

  it('records report_artifacts declarations', async () => {
    const result = await callCherryBuiltinTool(
      'report_artifacts',
      { artifacts: [{ path: 'dist/report.md', description: 'Report' }], summary: 'Created report' },
      signal
    )

    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toBe('Recorded 1 artifact(s).')
  })

  it('rejects invalid report_artifacts declarations', async () => {
    const result = await callCherryBuiltinTool('report_artifacts', { artifacts: [] }, signal)

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Error:')
  })

  it('routes generate_image through AiService, summarizes it, and attaches the image inline', async () => {
    getPreference.mockReturnValue('openai::dall-e-3')
    generateImage.mockResolvedValue({ files: [{ id: 'f1', name: 'image-1.png' }] })
    fileRead.mockResolvedValue({ content: 'BASE64DATA', mime: 'image/png', version: 1 })

    const result = await callCherryBuiltinTool('generate_image', { prompt: 'a cat' }, signal)

    expect(result.isError).toBeFalsy()
    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ uniqueModelId: 'openai::dall-e-3', prompt: 'a cat' })
    )
    // Model-facing text summary comes first…
    expect(textOf(result)).toContain('Generated 1 image(s)')
    expect(textOf(result)).toContain('image-1.png')
    // …followed by the base64 image content block the agent renderer shows inline.
    expect(fileRead).toHaveBeenCalledWith('f1', { encoding: 'base64' })
    expect(result.content[1]).toEqual({ type: 'image', data: 'BASE64DATA', mimeType: 'image/png' })
  })

  it('advertises provider-accurate generate_image params from the configured model', () => {
    const support = {
      modes: {
        generate: {
          supports: {
            size: { type: 'enum', options: ['1024x1024', '1792x1024'] },
            numImages: { type: 'range', min: 1, max: 3 }
          }
        }
      }
    } satisfies ImageGenerationSupport
    getPreference.mockReturnValue('openai::dall-e-3')
    getImageGenerationSupport.mockReturnValue(support)

    const tool = listCherryBuiltinTools().find(({ name }) => name === 'generate_image')!
    const schema = tool.inputSchema as {
      properties: Record<string, { enum?: string[]; maximum?: number }>
    }

    expect(schema.properties.size.enum).toEqual(['1024x1024', '1792x1024'])
    expect(schema.properties.numImages.maximum).toBe(3)
    expect(schema.properties.image_ids).toBeUndefined()
  })

  it('resolves image ids and calls the edit mode with edit-specific params', async () => {
    const support = {
      modes: {
        generate: { supports: { size: { type: 'enum', options: ['1024x1024'] } } },
        edit: { supports: { quality: { type: 'enum', options: ['low', 'high'] } } }
      }
    } satisfies ImageGenerationSupport
    getPreference.mockReturnValue('openai::gpt-image-1')
    getImageGenerationSupport.mockReturnValue(support)
    fileRead.mockResolvedValue({ content: 'AAAA', mime: 'image/png' })
    generateImage.mockResolvedValue({ files: [] })

    const result = await callCherryBuiltinTool(
      'generate_image',
      { prompt: 'make it blue', image_ids: ['f1'], quality: 'high' },
      signal
    )

    expect(result.isError).toBeFalsy()
    expect(fileRead).toHaveBeenCalledWith('f1', { encoding: 'base64' })
    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'edit',
        inputImages: ['data:image/png;base64,AAAA'],
        paramValues: { quality: 'high' }
      })
    )
  })

  it('still summarizes generate_image when reading the file back for inline rendering fails', async () => {
    getPreference.mockReturnValue('openai::dall-e-3')
    generateImage.mockResolvedValue({ files: [{ id: 'f1', name: 'image-1.png' }] })
    fileRead.mockRejectedValue(new Error('file gone'))

    const result = await callCherryBuiltinTool('generate_image', { prompt: 'a cat' }, signal)

    // A failed read drops the inline image but must not fail the generation.
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain('Generated 1 image(s)')
    expect(result.content).toHaveLength(1)
  })

  it('steers the model to configure a painting model when none is set', async () => {
    getPreference.mockReturnValue(null)

    const result = await callCherryBuiltinTool('generate_image', { prompt: 'a cat' }, signal)

    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain('No painting model is configured')
    expect(textOf(result)).toContain('do not retry')
    expect(generateImage).not.toHaveBeenCalled()
  })

  it('propagates AbortError from generate_image instead of converting it to an MCP error', async () => {
    getPreference.mockReturnValue('openai::dall-e-3')
    generateImage.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))

    await expect(callCherryBuiltinTool('generate_image', { prompt: 'a cat' }, signal)).rejects.toThrow()
  })

  it('returns an error result for an unknown tool', async () => {
    const result = await callCherryBuiltinTool('nope', {}, signal)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('Unknown tool')
  })
})

// The server hosts the stateless builtin tools plus the autonomy tools acting on the session's agent.
describe('CherryBuiltinToolsServer autonomy tool registration', () => {
  const agentContext = {
    agentId: 'agent_1',
    agentDataPath: '/tmp/agent-data',
    sessionId: 'session-1',
    workspaceSource: { type: 'system' as const },
    workspacePath: '/tmp/workspace',
    trustedNotifyChannels: [{ id: 'channel-1', type: 'telegram' as const }],
    getKnowledgeBaseIds: () => []
  }

  it('exposes the stateless tools plus cron/notify/config', async () => {
    const server = new CherryBuiltinToolsServer(agentContext)
    const handlers = (server.mcpServer.server as any)._requestHandlers
    const result = await handlers.get('tools/list')({ method: 'tools/list', params: {} }, {})
    const names = result.tools.map((t: any) => t.name)
    expect(names).toEqual(expect.arrayContaining(['cron', 'notify', 'config', 'to_markdown']))
    expect(names).toEqual(expect.arrayContaining(listCherryBuiltinTools().map((t) => t.name)))
  })

  it('exposes CLI management to every agent, including the built-in Assistant', async () => {
    const normal = new CherryBuiltinToolsServer(agentContext)
    const assistant = new CherryBuiltinToolsServer({ ...agentContext, canAccessAllKnowledgeBases: () => true })
    const normalHandlers = (normal.mcpServer.server as any)._requestHandlers
    const assistantHandlers = (assistant.mcpServer.server as any)._requestHandlers

    const normalNames = (await normalHandlers.get('tools/list')({ method: 'tools/list', params: {} }, {})).tools.map(
      (tool: any) => tool.name
    )
    const assistantNames = (
      await assistantHandlers.get('tools/list')({ method: 'tools/list', params: {} }, {})
    ).tools.map((tool: any) => tool.name)

    expect(normalNames).toEqual(expect.arrayContaining(['cli_list', 'cli_search', 'cli_install']))
    expect(assistantNames).toEqual(expect.arrayContaining(['cli_list', 'cli_search', 'cli_install']))
  })
})
