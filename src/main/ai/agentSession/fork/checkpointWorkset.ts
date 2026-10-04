import { selectDshCheckpointWorkset } from '@main/ai/runtime/dsh/forkCheckpoint'
import { AgentSessionForkError, type RuntimeForkCheckpoint } from '@main/ai/runtime/fork'

export interface ForkCheckpointWorkset {
  /** Passed to `driver.fork`. Smaller than the prefix when DSH can stamp the rest. */
  workset: RuntimeForkCheckpoint[]
  expand(remapped: readonly RuntimeForkCheckpoint[], resumeToken: string): RuntimeForkCheckpoint[]
}

/**
 * Pi and Claude remap every checkpoint (leaf / message ids change). DSH v4 only
 * changes the runtime session id, so the worker sees the anchor plus anything
 * the protocol still has to rewrite.
 */
export function resolveForkCheckpointWorkset(
  runtime: string,
  anchor: RuntimeForkCheckpoint,
  checkpoints: readonly RuntimeForkCheckpoint[]
): ForkCheckpointWorkset {
  if (runtime !== 'dsh') {
    return {
      workset: [...checkpoints],
      expand(remapped) {
        if (remapped.length !== checkpoints.length) throw new AgentSessionForkError('history_corrupt')
        return [...remapped]
      }
    }
  }
  return selectDshCheckpointWorkset(anchor, checkpoints)
}
