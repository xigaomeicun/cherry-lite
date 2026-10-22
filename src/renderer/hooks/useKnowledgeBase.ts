/**
 * (cherry-lite) Read-only knowledge-base list. The KB feature UI and its mutation hooks
 * were removed; this stays only so composer/agent dialogs can prune stale KB bindings.
 */
import { useInfiniteFlatItems, useInfiniteQuery } from '@data/hooks/useDataApi'
import type { KnowledgeBaseListItem } from '@shared/data/api/schemas/knowledges'
import { KNOWLEDGE_BASES_MAX_LIMIT } from '@shared/data/api/schemas/knowledges'
import { useEffect, useRef, useState } from 'react'

const EMPTY_KNOWLEDGE_BASES: KnowledgeBaseListItem[] = []

export const useKnowledgeBases = (options: { enabled?: boolean; revalidateOnFocus?: boolean } = {}) => {
  const enabled = options.enabled !== false
  const [revalidateAllPages, setRevalidateAllPages] = useState(false)
  const { pages, isLoading, isRefreshing, error, hasNext, loadNext, refresh } = useInfiniteQuery('/knowledge-bases', {
    limit: KNOWLEDGE_BASES_MAX_LIMIT,
    enabled: options.enabled,
    swrOptions: {
      revalidateAll: revalidateAllPages,
      revalidateFirstPage: false,
      ...(options.revalidateOnFocus !== undefined && { revalidateOnFocus: options.revalidateOnFocus })
    }
  })
  const flatBases = useInfiniteFlatItems(pages)
  const isFullyLoaded = enabled && pages.length > 0 && !isLoading && !hasNext && !error
  const lastCompleteBasesRef = useRef<KnowledgeBaseListItem[]>(EMPTY_KNOWLEDGE_BASES)

  if (isFullyLoaded) {
    lastCompleteBasesRef.current = flatBases
  }

  useEffect(() => {
    setRevalidateAllPages(isFullyLoaded)
  }, [isFullyLoaded])

  useEffect(() => {
    if (enabled && hasNext && !isLoading && !isRefreshing && !error) {
      loadNext()
    }
  }, [enabled, error, hasNext, isLoading, isRefreshing, loadNext])

  const bases = enabled ? lastCompleteBasesRef.current : EMPTY_KNOWLEDGE_BASES

  return {
    bases,
    isLoading: enabled && !isFullyLoaded && !error,
    error,
    refetch: refresh
  }
}
