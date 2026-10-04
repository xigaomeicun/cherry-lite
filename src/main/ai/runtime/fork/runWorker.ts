import type { Worker } from 'node:worker_threads'

import { AgentSessionForkError } from './checkpoint'

/** Floor for every fork worker. Short sessions stay on this budget. */
export const FORK_WORKER_TIMEOUT_MIN_MS = 60_000
/** Hard cap. A larger budget only covers disk fallback; it is not the fix for huge sessions. */
export const FORK_WORKER_TIMEOUT_CAP_MS = 180_000

/**
 * `min(max(60s, 60s + 2s/MiB + 250ms per extra checkpoint), 3min)`.
 * Live forks pass no byte hint and a tiny checkpoint workset, so they stay at 60s.
 */
export function resolveForkWorkerTimeoutMs(hints?: { jsonlBytes?: number; checkpointCount?: number }): number {
  const bytes = Number.isFinite(hints?.jsonlBytes) ? Math.max(0, hints?.jsonlBytes ?? 0) : 0
  const checkpoints = Number.isFinite(hints?.checkpointCount) ? Math.max(0, hints?.checkpointCount ?? 0) : 0
  const scaled =
    FORK_WORKER_TIMEOUT_MIN_MS + Math.ceil(bytes / (1024 * 1024)) * 2_000 + Math.max(0, checkpoints - 1) * 250
  return Math.min(FORK_WORKER_TIMEOUT_CAP_MS, Math.max(FORK_WORKER_TIMEOUT_MIN_MS, scaled))
}

export async function runForkWorker(
  worker: Worker,
  signal: AbortSignal,
  timeoutMs: number = FORK_WORKER_TIMEOUT_MIN_MS
): Promise<unknown> {
  const requested = Number.isFinite(timeoutMs) ? timeoutMs : FORK_WORKER_TIMEOUT_MIN_MS
  const limit = Math.min(FORK_WORKER_TIMEOUT_CAP_MS, Math.max(FORK_WORKER_TIMEOUT_MIN_MS, requested))
  try {
    signal.throwIfAborted()
    return await new Promise<unknown>((resolve, reject) => {
      const onAbort = () => reject(signal.reason)
      const timer = setTimeout(
        () => reject(new AgentSessionForkError('fork_timed_out', `Fork worker timed out after ${limit}ms`)),
        limit
      )
      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      worker.once('message', (message: { result: unknown; error?: string }) => {
        cleanup()
        if (message.error) reject(new AgentSessionForkError(message.error))
        else resolve(message.result)
      })
      worker.once('error', (error) => {
        cleanup()
        reject(error)
      })
      worker.once('exit', () => {
        cleanup()
        reject(new Error('Fork worker exited without a result'))
      })
      if (signal.aborted) onAbort()
    })
  } finally {
    // Await termination before the operation owner removes any staged files.
    await worker.terminate()
  }
}
