import type { CacheMiniAppAttention } from '@shared/data/cache/cacheValueTypes'
import type { QuotaUsageWithLimits } from '@shared/types/miniAppQuota'

/**
 * cherry-lite: the Mini Apps request channels (`mini_app.*` IpcApi commands) were removed together
 * with their handlers; only the main -> renderer event types and the detail DTO still have consumers.
 */

/** The mini-app detail DTO built by `features/miniApp/management.ts`. */
export interface MiniAppDetail {
  appId: string
  name: string
  description: string
  version: string
  /** The launcher tile's logo, as the `MiniApp` DTO carries it: a preset key on `logo`, an uploaded image on `logoSrc`. */
  logo?: string
  logoSrc?: string
  /** Where it came from — the panel shows "installed from example.com" for web sources. */
  source: 'file' | 'url' | 'builtin'
  sourceUrl: string | null
  /**
   * Whether a rollback snapshot is retained. Derived in the owner from
   * `previousContentHash`: the panel decides whether to show the button, and that
   * column means nothing to the renderer.
   */
  canRollback: boolean
  /**
   * Every leaf the current manifest declares. `optional` is what the panel renders off:
   * a REQUIRED leaf gets no toggle at all, because the service refuses to revoke one
   * — a button that always fails is worse than no button.
   */
  declared: Array<{ key: string; optional: boolean; granted: boolean }>
  grants: string[]
  /** The declared host allowlist, read-only in the panel. Not grants — see `declared`. */
  network: string[]
  /** Leaves a Cherry update added under a namespace this app already declared (decision A). */
  pendingAdditions: string[]
  /** The version the last update check found for THIS app, or null — the panel's "new version" chip. */
  updateVersion: string | null
  /** Read here with the rest of the panel's state; written via `PATCH /mini-apps/:appId`. */
  aiModelId: string | null
  aiQuickModelId: string | null
  /** Usage AND the ceiling it is measured against — the panel draws a bar, not a number. */
  storage: QuotaUsageWithLimits
  file: QuotaUsageWithLimits
  /** What the installed package itself takes on disk. */
  packageBytes: number
  /** The previous version kept for rollback, or 0 when none is retained. */
  snapshotBytes: number
}

export type MiniAppEventSchemas = {
  /** Apps that want the user's attention, and why (a host-added permission, or an update). */
  'mini_app.runtime.attention': { apps: CacheMiniAppAttention[] }
  /** Host is about to change this app underneath it; drop it from every pool. */
  'mini_app.runtime.evicted': { appId: string }
}
