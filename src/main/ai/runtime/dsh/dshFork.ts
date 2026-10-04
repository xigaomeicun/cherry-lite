import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import * as z from 'zod'

import { application } from '@application'
import { resolveBundledDshRuntimeEntry } from '@cherrystudio/dsh-bridge'
import { loggerService } from '@logger'

import { AgentSessionForkError, type RuntimeForkInput, type RuntimeForkResult } from '../fork'
import { runForkWorker } from '../fork'
import { parseDshForkCheckpoint } from './forkCheckpoint'
import type { DshForkWorkerInput } from './forkWorker'

const logger = loggerService.withContext('dshFork')

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
  const { default: createWorker } = await import('./forkWorker?nodeWorker')
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
  const worker = createWorker({ workerData, env: { ...process.env } })
  const forkSource = snapshotEvents && snapshotEvents.length > 0 ? 'live' : 'disk'
  const started = Date.now()
  let workerResult: unknown
  try {
    workerResult = await runForkWorker(worker, input.signal)
  } catch (error) {
    logger.warn(
      `dsh fork failed fork_source=${forkSource} event_count=${snapshotEvents?.length ?? 0} boundary=${checkpoint.boundary} checkpoint_count=${checkpoints.length} duration_ms=${Date.now() - started} jsonl_bytes=`,
      { error }
    )
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
      `dsh fork failed fork_source=${forkSource} event_count=${snapshotEvents?.length ?? 0} boundary=${checkpoint.boundary} checkpoint_count=${checkpoints.length} duration_ms=${Date.now() - started} jsonl_bytes=`
    )
    throw new AgentSessionForkError('history_corrupt')
  }
  const durationMs = Date.now() - started
  const jsonlBytes = forkSource === 'disk' ? await sourceSessionJsonlBytes(sourceRoot, checkpoint.runtimeSessionId) : ''
  logger.info(
    `dsh fork fork_source=${forkSource} event_count=${snapshotEvents?.length ?? 0} boundary=${checkpoint.boundary} checkpoint_count=${checkpoints.length} duration_ms=${durationMs} jsonl_bytes=${jsonlBytes}`
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
