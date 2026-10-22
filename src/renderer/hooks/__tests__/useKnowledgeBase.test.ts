import type { KnowledgeBase } from '@shared/data/types/knowledge'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useKnowledgeBases } from '../useKnowledgeBase'

const mockUseInfiniteQuery = vi.fn()
const mockUseMutation = vi.fn()
const mockUseInvalidateCache = vi.fn()
const mockIpcRequest = vi.fn()

vi.mock('@data/hooks/useDataApi', () => ({
  useInfiniteQuery: (...args: unknown[]) => mockUseInfiniteQuery(...args),
  useInfiniteFlatItems: (pages: Array<{ items: KnowledgeBase[] }> = []) => pages.flatMap((page) => page.items),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
  useInvalidateCache: () => mockUseInvalidateCache()
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: {
    request: (...args: unknown[]) => mockIpcRequest(...args)
  }
}))

const createKnowledgeBase = (overrides: Partial<KnowledgeBase> = {}): KnowledgeBase => ({
  id: '',
  name: '',
  groupId: null,
  dimensions: 1536,
  embeddingModelId: null,
  rerankModelId: undefined,
  fileProcessorId: undefined,
  chunkSize: 1024,
  chunkOverlap: 200,
  chunkStrategy: 'structured',
  chunkSeparator: '\\n\\n',
  documentCount: undefined,
  status: 'completed',
  error: null,
  createdAt: '2026-04-15T09:00:00+08:00',
  updatedAt: '2026-04-15T09:00:00+08:00',
  ...overrides
})

describe('useKnowledgeBases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns every loaded knowledge base once the cursor chain is complete', async () => {
    const bases = [
      createKnowledgeBase({ id: 'base-1', name: 'Base 1' }),
      createKnowledgeBase({ id: 'base-2', name: 'Base 2' })
    ]
    const refetch = vi.fn()

    mockUseInfiniteQuery.mockReturnValue({
      pages: [{ items: bases }],
      isLoading: false,
      isRefreshing: false,
      error: undefined,
      hasNext: false,
      loadNext: vi.fn(),
      refresh: refetch
    })

    const { result } = renderHook(() => useKnowledgeBases())

    expect(result.current.bases).toEqual(bases)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeUndefined()
    expect(result.current.refetch).toBe(refetch)

    await waitFor(() => {
      expect(mockUseInfiniteQuery).toHaveBeenLastCalledWith('/knowledge-bases', {
        limit: 100,
        enabled: undefined,
        swrOptions: { revalidateAll: true, revalidateFirstPage: false }
      })
    })
  })

  it('auto-loads the next page without publishing a partial list', async () => {
    const loadNext = vi.fn()
    const firstPageBase = createKnowledgeBase({ id: 'base-1', name: 'Base 1' })

    mockUseInfiniteQuery.mockReturnValue({
      pages: [{ items: [firstPageBase], nextCursor: 'cursor-2' }],
      isLoading: false,
      isRefreshing: false,
      error: undefined,
      hasNext: true,
      loadNext,
      refresh: vi.fn()
    })

    const { result } = renderHook(() => useKnowledgeBases())

    expect(result.current.bases).toEqual([])
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(loadNext).toHaveBeenCalledTimes(1))
  })

  it('keeps the last complete list while a refreshed chain grows', () => {
    const completeBases = [createKnowledgeBase({ id: 'base-1', name: 'Base 1' })]
    let queryState = {
      pages: [{ items: completeBases }],
      isLoading: false,
      isRefreshing: false,
      error: undefined,
      hasNext: false,
      loadNext: vi.fn(),
      refresh: vi.fn()
    }
    mockUseInfiniteQuery.mockImplementation(() => queryState)

    const { result, rerender } = renderHook(() => useKnowledgeBases())
    expect(result.current.bases).toEqual(completeBases)

    queryState = {
      ...queryState,
      pages: [{ items: completeBases, nextCursor: 'cursor-2' }] as never,
      hasNext: true
    }
    rerender()

    expect(result.current.bases).toEqual(completeBases)
    expect(result.current.isLoading).toBe(true)
  })

  it('ends loading when the first page fails', () => {
    const error = new Error('page 1 failed')
    mockUseInfiniteQuery.mockReturnValue({
      pages: [],
      isLoading: false,
      isRefreshing: false,
      error,
      hasNext: false,
      loadNext: vi.fn(),
      refresh: vi.fn()
    })

    const { result } = renderHook(() => useKnowledgeBases())

    expect(result.current.bases).toEqual([])
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBe(error)
  })

  it('stops automatic pagination and preserves the last complete list on a later-page error', () => {
    const error = new Error('page 2 failed')
    const loadNext = vi.fn()
    const completeBases = [createKnowledgeBase({ id: 'base-1' })]
    let queryState = {
      pages: [{ items: completeBases }],
      isLoading: false,
      isRefreshing: false,
      error: undefined as Error | undefined,
      hasNext: false,
      loadNext,
      refresh: vi.fn()
    }
    mockUseInfiniteQuery.mockImplementation(() => queryState)

    const { result, rerender } = renderHook(() => useKnowledgeBases())

    queryState = {
      ...queryState,
      pages: [{ items: completeBases, nextCursor: 'cursor-2' }] as never,
      error,
      hasNext: true
    }
    rerender()

    expect(result.current.bases).toEqual(completeBases)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBe(error)
    expect(loadNext).not.toHaveBeenCalled()
  })

  it('passes an explicit activation boundary to DataApi', () => {
    mockUseInfiniteQuery.mockReturnValue({
      pages: [],
      isLoading: false,
      isRefreshing: false,
      error: undefined,
      hasNext: false,
      loadNext: vi.fn(),
      refresh: vi.fn()
    })

    renderHook(() => useKnowledgeBases({ enabled: false }))

    expect(mockUseInfiniteQuery).toHaveBeenCalledWith('/knowledge-bases', {
      limit: 100,
      enabled: false,
      swrOptions: { revalidateAll: false, revalidateFirstPage: false }
    })
  })
})
