import { AgentSessionForkError, type RuntimeForkCheckpoint } from '@main/ai/runtime/fork'

export interface ForkCheckpointWorkset {
  /** Passed to `driver.fork`. */
  workset: RuntimeForkCheckpoint[]
  expand(remapped: readonly RuntimeForkCheckpoint[], resumeToken: string): RuntimeForkCheckpoint[]
}

/**
 * Pi and Claude remap every checkpoint (leaf / message ids change), so the worker always receives
 * the full prefix. (The DSH-only "anchor + stamp the rest" workset retired with the DSH runtime.)
 */
export function resolveForkCheckpointWorkset(
  _runtime: string,
  _anchor: RuntimeForkCheckpoint,
  checkpoints: readonly RuntimeForkCheckpoint[]
): ForkCheckpointWorkset {
  return {
    workset: [...checkpoints],
    expand(remapped) {
      if (remapped.length !== checkpoints.length) throw new AgentSessionForkError('history_corrupt')
      return [...remapped]
    }
  }
}
