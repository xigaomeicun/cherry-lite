import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { application } from '@application'
import { resolveBundledDshRuntimeEntry } from '@cherrystudio/dsh-bridge'
import { loggerService } from '@logger'
import * as z from 'zod'

import {
  AgentSessionForkError,
  resolveForkWorkerTimeoutMs,
  runForkWorker,
  type RuntimeForkInput,
  type RuntimeForkResult
} from '../fork'
import { parseDshForkCheckpoint } from './forkCheckpoint'
import type { DshForkWorkerInput } from './forkWorker'

const logger = loggerService.withContext('dshFork')

/** Above this, disk fallback can exceed the 60s floor. Compact is not automatic. */
const HUGE_DSH_JSONL_BYTES = 16 * 1024 * 1024
/** Live snapshots larger than this still hash one prefix; warn so the log explains the cost. */
const HUGE_DSH_EVENT_COUNT = 50_000

function warnIfHugeDshHistory(info: {
  forkSource: string
  eventCount: number
  jsonlBytes: number | ''
  checkpointCount: number
  boundary: number
}): void {
  const hugeBytes = typeof info.jsonlBytes === 'number' && info.jsonlBytes >= HUGE_DSH_JSONL_BYTES
  const hugeEvents = info.eventCount >= HUGE_DSH_EVENT_COUNT
  if (!hugeBytes && !hugeEvents) return
  logger.warn(
    `dsh session history is large fork_source=${info.forkSource} event_count=${info.eventCount} boundary=${info.boundary} checkpoint_count=${info.checkpointCount} jsonl_bytes=${info.jsonlBytes}; native fork cost grows with history (no automatic compact)`
  )
}

export async function forkDshSession(input: RuntimeForkInput, snapshotEvents?: unknown[]): Promise<RuntimeForkResult> {
  const checkpoint = parseDshForkCheckpoint(input.checkpoint)
  const sourceRoot = application.getPath('feature.agents.dsh.sessions')
  const targetRoot = path.join(input.artifactDirectory, 'dsh')
  const checkpoints = input.checkpoints.map(parseDshForkCheckpoint).map((value) => {
    if (
      (value.formatVersion === checkpoint.formatVersion && value.boundary > checkpoint.boundary) ||
      value.runtimeSessionId !== checkpoint.runtimeSessionId
    )
      throw new AgentSessionForkError('history_changed')
    return value
  })
  input.signal.throwIfAborted()
  const workerData: DshForkWorkerInput = {
    modulePath: pathToFileURL(resolveBundledDshRuntimeEntry('@cherrystudio/dsh-bridge/fork')).href,
    sourceRoot,
    targetRoot,
    sourceSessionId: checkpoint.runtimeSessionId,
    targetSessionId: input.targetSessionId,
    targetCwd: input.targetCwd,
    boundary: checkpoint.boundary,
    formatVersion: checkpoint.formatVersion,
    checkpoints: checkpoints.map(({ boundary, formatVersion }) => ({ boundary, formatVersion })),
    events: snapshotEvents
  }
  const forkSource = snapshotEvents && snapshotEvents.length > 0 ? 'live' : 'disk'
  const started = Date.now()
  const jsonlBytesHint =
    forkSource === 'disk' ? await sourceSessionJsonlBytes(sourceRoot, checkpoint.runtimeSessionId) : ''
  const timeoutMs = resolveForkWorkerTimeoutMs({
    jsonlBytes: typeof jsonlBytesHint === 'number' ? jsonlBytesHint : 0,
    checkpointCount: checkpoints.length
  })
  const eventCount = snapshotEvents?.length ?? 0
  warnIfHugeDshHistory({
    forkSource,
    eventCount,
    jsonlBytes: jsonlBytesHint,
    checkpointCount: checkpoints.length,
    boundary: checkpoint.boundary
  })
  const { default: createWorker } = await import('./forkWorker?nodeWorker')
  input.signal.throwIfAborted()
  // Start the worker only after the listener exists. A stat between create and
  // runForkWorker can drop the result message.
  const worker = createWorker({ workerData, env: { ...process.env } })
  let workerResult: unknown
  try {
    workerResult = await runForkWorker(worker, input.signal, timeoutMs)
  } catch (error) {
    logger.warn(
      `dsh fork failed fork_source=${forkSource} event_count=${eventCount} boundary=${checkpoint.boundary} checkpoint_count=${checkpoints.length} duration_ms=${Date.now() - started} timeout_ms=${timeoutMs} jsonl_bytes=${jsonlBytesHint}`,
      { error }
    )
    if (error instanceof AgentSessionForkError && error.reason === 'fork_timed_out') {
      throw new AgentSessionForkError(
        'fork_timed_out',
        `Fork worker timed out after ${timeoutMs}ms (fork_source=${forkSource}, checkpoint_count=${checkpoints.length}, jsonl_bytes=${jsonlBytesHint === '' ? 'unknown' : jsonlBytesHint})`
      )
    }
    throw error
  }
  const parsed = z
    .strictObject({
      path: z.string().min(1),
      checkpoints: z
        .array(z.strictObject({ boundary: z.number().int().nonnegative(), formatVersion: z.literal(4) }))
        .length(checkpoints.length)
    })
    .safeParse(workerResult)
  if (!parsed.success) {
    logger.warn(
      `dsh fork failed fork_source=${forkSource} event_count=${eventCount} boundary=${checkpoint.boundary} checkpoint_count=${checkpoints.length} duration_ms=${Date.now() - started} timeout_ms=${timeoutMs} jsonl_bytes=${jsonlBytesHint}`
    )
    throw new AgentSessionForkError('history_corrupt')
  }
  const durationMs = Date.now() - started
  logger.info(
    `dsh fork fork_source=${forkSource} event_count=${eventCount} boundary=${checkpoint.boundary} checkpoint_count=${checkpoints.length} duration_ms=${durationMs} timeout_ms=${timeoutMs} jsonl_bytes=${jsonlBytesHint}`
  )
  const result = parsed.data
  const relative = path.relative(targetRoot, result.path)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid DSH artifact path')
  return {
    resumeToken: input.targetSessionId,
    checkpoints: checkpoints.map((value, index) =>
      parseDshForkCheckpoint({ ...value, ...result.checkpoints[index], runtimeSessionId: input.targetSessionId })
    ),
    publish: [{ source: result.path, target: path.join(sourceRoot, relative) }]
  }
}

async function sourceSessionJsonlBytes(root: string, sessionId: string): Promise<number | ''> {
  try {
    const artifacts = (await readdir(root, { recursive: true })).filter(
      (file) => path.basename(path.dirname(file)) === sessionId && path.basename(file) === 'session.jsonl.zstd'
    )
    if (artifacts.length !== 1) return ''
    return (await stat(path.join(root, artifacts[0]))).size
  } catch {
    return ''
  }
}
