import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import type { FileAttachment } from '@main/utils/downloadAsBase64'

import { readCanonicalLocalFile } from './localFileResolver'

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

/**
 * Well-known CPA / agent asset dump root (`~/.agents/workspace`).
 * DSH/skills often write generated images here even when the Cherry session
 * workspace is an app-owned `Agents/system/...` directory — outbound channel
 * delivery must be allowed to read from this bounded root without opening the
 * entire filesystem.
 */
export function agentAssetsWorkspaceRoot(home = homedir()): string {
  return path.join(home, '.agents', 'workspace')
}

function isInsideRoot(realTarget: string, realRoot: string): boolean {
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep)
}

/**
 * Resolve an agent-supplied path into a `FileAttachment`, confined to the session
 * workspace (and optional additional roots). Accepts paths relative to the
 * workspace and absolute paths that land inside an allowed root. `realpath`
 * defeats `../` and symlink escape; reading happens on a single fd over the
 * canonical path so the stat/size check and the read see the same inode.
 *
 * This is defense-in-depth against traversal mistakes and prompt injection picking a
 * wrong path — not a sandbox against an agent with code execution (which can already
 * read arbitrary files and exfiltrate them as message text). See #16566.
 *
 * `additionalRoots` is for bounded, known session-adjacent directories (e.g. the
 * CPA agent assets workspace). Do not pass arbitrary user paths.
 */
export async function resolveWorkspaceFile(
  workspaceRoot: string,
  userPath: string,
  additionalRoots: readonly string[] = []
): Promise<FileAttachment> {
  const requested = path.isAbsolute(userPath) ? path.normalize(userPath) : path.resolve(workspaceRoot, userPath)

  let realTarget: string
  try {
    realTarget = await realpath(requested)
  } catch (error) {
    if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      throw new Error(`File not found in workspace: ${userPath}`)
    }
    throw error
  }

  const roots = [workspaceRoot, ...additionalRoots]
  let sawExistingRoot = false
  let lastRootError: unknown

  for (const root of roots) {
    let realRoot: string
    try {
      realRoot = await realpath(root)
      sawExistingRoot = true
    } catch (error) {
      lastRootError = error
      // Missing additional roots are skipped; a missing session workspace is
      // reported below if nothing else matches.
      continue
    }

    if (isInsideRoot(realTarget, realRoot)) {
      return readCanonicalLocalFile(requested, realTarget, userPath)
    }
  }

  if (!sawExistingRoot) {
    if (isErrnoException(lastRootError) && (lastRootError.code === 'ENOENT' || lastRootError.code === 'ENOTDIR')) {
      throw new Error(`Session workspace is unavailable: ${workspaceRoot}`)
    }
    if (lastRootError) throw lastRootError
  }

  throw new Error(`Path is outside the workspace: ${userPath}`)
}
