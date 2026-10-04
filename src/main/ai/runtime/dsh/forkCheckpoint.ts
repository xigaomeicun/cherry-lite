import * as z from 'zod'

import { AgentSessionForkError, type RuntimeForkCheckpoint } from '../fork'

export const DshForkCheckpointSchema = z.strictObject({
  runtime: z.literal('dsh'),
  runtimeSessionId: z.string().min(1),
  boundary: z.number().int().nonnegative(),
  formatVersion: z.union([z.literal(0), z.literal(4)]).default(0)
})

export type DshForkCheckpoint = z.infer<typeof DshForkCheckpointSchema>

export function parseDshForkCheckpoint(value: unknown): DshForkCheckpoint {
  const parsed = DshForkCheckpointSchema.safeParse(value)
  if (!parsed.success) throw new AgentSessionForkError('unsupported_checkpoint')
  return parsed.data
}

export interface DshCheckpointWorkset {
  /** Checkpoints the native fork must rewrite. Stable v4 checkpoints are omitted. */
  workset: RuntimeForkCheckpoint[]
  /**
   * Rebuild one checkpoint per source anchor. Slots the driver rewrote come back
   * unchanged; other v4 checkpoints are stamped onto `resumeToken` (the child
   * runtime session id) without another prefix hash.
   */
  expand(remapped: readonly RuntimeForkCheckpoint[], resumeToken: string): RuntimeForkCheckpoint[]
}

function isDshAnchor(value: DshForkCheckpoint, anchor: DshForkCheckpoint): boolean {
  return (
    value.formatVersion === anchor.formatVersion &&
    value.runtimeSessionId === anchor.runtimeSessionId &&
    value.boundary === anchor.boundary
  )
}

/**
 * Native DSH fork rewrites `runtimeSessionId` and, for formatVersion 0, the boundary.
 * v4 boundaries are stable, so only the anchor (verified by the fork) and checkpoints
 * the protocol cannot stamp locally are sent through the worker.
 */
export function selectDshCheckpointWorkset(
  anchor: RuntimeForkCheckpoint,
  checkpoints: readonly RuntimeForkCheckpoint[]
): DshCheckpointWorkset {
  const parsedAnchor = DshForkCheckpointSchema.safeParse(anchor)
  if (!parsedAnchor.success) {
    return {
      workset: [...checkpoints],
      expand(remapped) {
        if (remapped.length !== checkpoints.length) throw new AgentSessionForkError('history_corrupt')
        return [...remapped]
      }
    }
  }
  const anchorValue = parsedAnchor.data
  const workset: RuntimeForkCheckpoint[] = []
  // -1 = stamp locally. Otherwise an index into `workset` / `remapped`.
  const slots: number[] = []
  let anchorVerified = false
  for (const checkpoint of checkpoints) {
    const parsed = DshForkCheckpointSchema.safeParse(checkpoint)
    if (!parsed.success) {
      slots.push(workset.length)
      workset.push(checkpoint)
      continue
    }
    const value = parsed.data
    if (isDshAnchor(value, anchorValue) && !anchorVerified) {
      anchorVerified = true
      slots.push(workset.length)
      workset.push(checkpoint)
      continue
    }
    const stampable =
      anchorValue.formatVersion === 4 &&
      value.formatVersion === 4 &&
      value.runtimeSessionId === anchorValue.runtimeSessionId &&
      value.boundary <= anchorValue.boundary
    if (stampable) {
      slots.push(-1)
      continue
    }
    slots.push(workset.length)
    workset.push(checkpoint)
  }
  return {
    workset,
    expand(remapped, resumeToken) {
      if (remapped.length !== workset.length) throw new AgentSessionForkError('history_corrupt')
      if (slots.some((slot) => slot < 0) && !resumeToken.trim()) throw new AgentSessionForkError('history_corrupt')
      return slots.map((slot, index) => {
        if (slot >= 0) return remapped[slot]
        const parsed = parseDshForkCheckpoint(checkpoints[index])
        return parseDshForkCheckpoint({ ...parsed, runtimeSessionId: resumeToken, formatVersion: 4 })
      })
    }
  }
}
