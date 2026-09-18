import { open, readdir } from 'node:fs/promises'
import path from 'node:path'

import { ensureDir, isPathInside, lstat, mkdir, realpath, removeDir } from '@main/utils/file'
import { type AbsoluteFilePath, AbsoluteFilePathSchema } from '@shared/types/file'

const AGENT_DATA_FILES = ['SOUL.md', 'USER.md'] as const

function asAbsolutePath(value: string): AbsoluteFilePath {
  return AbsoluteFilePathSchema.parse(value)
}

async function lstatIfExists(targetPath: string) {
  try {
    return await lstat(asAbsolutePath(targetPath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function resolveRealOrNearestExistingPath(targetPath: string): Promise<AbsoluteFilePath> {
  const absoluteTargetPath = asAbsolutePath(path.resolve(targetPath))
  try {
    return await realpath(absoluteTargetPath)
  } catch {
    let currentPath = asAbsolutePath(path.dirname(absoluteTargetPath))

    while (true) {
      try {
        const realCurrentPath = await realpath(currentPath)
        return asAbsolutePath(
          path.normalize(path.join(realCurrentPath, path.relative(currentPath, absoluteTargetPath)))
        )
      } catch {
        const parentPath = asAbsolutePath(path.dirname(currentPath))
        if (parentPath === currentPath) return absoluteTargetPath
        currentPath = parentPath
      }
    }
  }
}

/**
 * Validate a path in Data/Agents without following symbolic links in the
 * managed root or any path component below it.
 */
export async function assertAgentStoragePath(agentsDataRoot: string, targetPath: string): Promise<void> {
  const root = asAbsolutePath(path.resolve(agentsDataRoot))
  const target = asAbsolutePath(path.resolve(targetPath))
  if (target !== root && !isPathInside(target, root)) {
    throw new Error(`Agent storage path escapes its root: ${target}`)
  }

  const rootStat = await lstatIfExists(root)
  if (!rootStat?.isDirectory || rootStat.isSymbolicLink) {
    throw new Error(`Agent storage root must be a real directory: ${root}`)
  }

  let current = root
  const relative = path.relative(root, target)
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = asAbsolutePath(path.join(current, segment))
    const currentStat = await lstatIfExists(current)
    if (!currentStat) break
    if (currentStat.isSymbolicLink) {
      throw new Error(`Agent storage path contains a symbolic link: ${current}`)
    }
    if (current !== target && !currentStat.isDirectory) {
      throw new Error(`Agent storage path parent is not a directory: ${current}`)
    }
  }

  const [realRoot, realTarget] = await Promise.all([
    resolveRealOrNearestExistingPath(root),
    resolveRealOrNearestExistingPath(target)
  ])
  if (realTarget !== realRoot && !isPathInside(realTarget, realRoot)) {
    throw new Error(`Agent storage path resolves outside its root: ${target}`)
  }
}

/** Ensure a Data/Agents path is a real directory contained by the Agent storage root. */
export async function ensureAgentStorageDirectory(agentsDataRoot: string, targetPath: string): Promise<void> {
  await ensureDir(asAbsolutePath(path.resolve(agentsDataRoot)))
  await assertAgentStoragePath(agentsDataRoot, targetPath)
  await ensureDir(asAbsolutePath(path.resolve(targetPath)))
  await assertAgentStoragePath(agentsDataRoot, targetPath)
  const targetStat = await lstat(asAbsolutePath(path.resolve(targetPath)))
  if (!targetStat.isDirectory || targetStat.isSymbolicLink) {
    throw new Error(`Agent storage directory must be a real directory: ${targetPath}`)
  }
}

function assertAgentId(agentId: string): void {
  if (!agentId || agentId === '.' || agentId === '..' || agentId.toLowerCase() === 'system' || /[\\/]/.test(agentId)) {
    throw new Error(`Invalid agent id for data directory: ${agentId}`)
  }
}

export function agentDataDirectoryPath(agentsDataRoot: string, agentId: string): string {
  assertAgentId(agentId)
  return path.join(agentsDataRoot, agentId)
}

async function ensureEmptyFile(filePath: string): Promise<void> {
  const existing = await lstatIfExists(filePath)
  if (existing) {
    if (!existing.isFile || existing.isSymbolicLink) {
      throw new Error(`Agent data file must be a real file: ${filePath}`)
    }
    return
  }
  try {
    const handle = await open(filePath, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

    const racedFile = await lstatIfExists(filePath)
    if (!racedFile?.isFile || racedFile.isSymbolicLink) {
      throw new Error(`Agent data file must be a real file: ${filePath}`)
    }
  }
}

export async function ensureAgentDataDirectory(
  agentsDataRoot: string,
  agentId: string,
  options: { createFiles?: boolean } = {}
): Promise<string> {
  const agentDataPath = agentDataDirectoryPath(agentsDataRoot, agentId)
  await ensureAgentStorageDirectory(agentsDataRoot, agentDataPath)
  await ensureAgentStorageDirectory(agentsDataRoot, path.join(agentDataPath, 'memory'))

  if (options.createFiles !== false) {
    for (const filename of AGENT_DATA_FILES) {
      await ensureEmptyFile(path.join(agentDataPath, filename))
    }
  }

  await assertAgentDataDirectory(agentsDataRoot, agentId)
  return agentDataPath
}

export async function createAgentDataDirectory(agentsDataRoot: string, agentId: string): Promise<string> {
  const agentDataPath = agentDataDirectoryPath(agentsDataRoot, agentId)
  await ensureAgentStorageDirectory(agentsDataRoot, agentsDataRoot)
  await assertAgentStoragePath(agentsDataRoot, agentDataPath)
  if (await lstatIfExists(agentDataPath)) {
    throw new Error(`Agent data directory already exists: ${agentDataPath}`)
  }

  await mkdir(asAbsolutePath(agentDataPath))
  try {
    await ensureAgentDataDirectory(agentsDataRoot, agentId)
    return agentDataPath
  } catch (error) {
    await removeAgentDataDirectory(agentsDataRoot, agentId).catch(() => undefined)
    throw error
  }
}

export async function assertAgentDataDirectory(agentsDataRoot: string, agentId: string): Promise<string> {
  const agentDataPath = agentDataDirectoryPath(agentsDataRoot, agentId)
  await assertAgentStoragePath(agentsDataRoot, agentDataPath)

  const rootStat = await lstatIfExists(agentDataPath)
  if (!rootStat?.isDirectory || rootStat.isSymbolicLink) {
    throw new Error(`Agent data directory must be a real directory: ${agentDataPath}`)
  }

  const memoryPath = path.join(agentDataPath, 'memory')
  const memoryStat = await lstatIfExists(memoryPath)
  if (!memoryStat?.isDirectory || memoryStat.isSymbolicLink) {
    throw new Error(`Agent memory directory must be a real directory: ${memoryPath}`)
  }

  for (const filename of AGENT_DATA_FILES) {
    const filePath = path.join(agentDataPath, filename)
    const fileStat = await lstatIfExists(filePath)
    if (fileStat && (!fileStat.isFile || fileStat.isSymbolicLink)) {
      throw new Error(`Agent data file must be a real file: ${filePath}`)
    }
  }
  return agentDataPath
}

export async function removeAgentDataDirectory(agentsDataRoot: string, agentId: string): Promise<void> {
  const agentDataPath = agentDataDirectoryPath(agentsDataRoot, agentId)
  await assertAgentStoragePath(agentsDataRoot, agentDataPath)
  const targetStat = await lstatIfExists(agentDataPath)
  if (!targetStat) return
  if (!targetStat.isDirectory || targetStat.isSymbolicLink) {
    throw new Error(`Refusing to recursively remove unsafe agent data path: ${agentDataPath}`)
  }
  await removeDir(asAbsolutePath(agentDataPath))
}

export async function removeAgentSessionPhysicalDirectories(
  agentsDataRoot: string,
  systemWorkspacesRoot: string,
  sessionIds: readonly string[]
): Promise<void> {
  if (sessionIds.length === 0) return
  const sessionIdSet = new Set(sessionIds)

  // 1. Delete system workspaces matching session IDs
  try {
    const dates = await readdir(systemWorkspacesRoot, { withFileTypes: true }).catch(() => [])
    for (const dateEntry of dates) {
      if (!dateEntry.isDirectory()) continue
      const dateDir = path.join(systemWorkspacesRoot, dateEntry.name)
      const sessions = await readdir(dateDir, { withFileTypes: true }).catch(() => [])
      for (const sessionEntry of sessions) {
        if (!sessionEntry.isDirectory()) continue
        if (sessionIdSet.has(sessionEntry.name)) {
          await removeDir(asAbsolutePath(path.join(dateDir, sessionEntry.name))).catch(() => {})
        }
      }
      // If date directory becomes empty, clean it up too
      const remaining = await readdir(dateDir).catch(() => [])
      if (remaining.length === 0) {
        await removeDir(asAbsolutePath(dateDir)).catch(() => {})
      }
    }
  } catch {
    /* best effort */
  }

  // 2. Clean Claude Code project cache matching session IDs
  try {
    const claudeProjectsRoot = path.join(agentsDataRoot, '.claude', 'projects')
    const claudeProjects = await readdir(claudeProjectsRoot, { withFileTypes: true }).catch(() => [])
    for (const proj of claudeProjects) {
      if (!proj.isDirectory()) continue
      const matches = sessionIds.some((sid) => proj.name.endsWith(sid))
      if (matches) {
        await removeDir(asAbsolutePath(path.join(claudeProjectsRoot, proj.name))).catch(() => {})
      }
    }
  } catch {
    /* best effort */
  }

  // 3. Clean DSH sessions cache matching session IDs
  try {
    const dshSessionsRoot = path.join(agentsDataRoot, '.dsh', 'sessions')
    const dshSessions = await readdir(dshSessionsRoot, { withFileTypes: true }).catch(() => [])
    for (const dshSess of dshSessions) {
      if (!dshSess.isDirectory()) continue
      const matches = sessionIds.some((sid) => dshSess.name.includes(sid))
      if (matches) {
        await removeDir(asAbsolutePath(path.join(dshSessionsRoot, dshSess.name))).catch(() => {})
      }
    }
  } catch {
    /* best effort */
  }
}

export async function sweepOrphanAgentDirectories(agentsDataRoot: string, activeAgentIds: readonly string[]): Promise<void> {
  const activeSet = new Set(activeAgentIds)
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  try {
    const entries = await readdir(agentsDataRoot, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (UUID_REGEX.test(entry.name) && !activeSet.has(entry.name)) {
        await removeDir(asAbsolutePath(path.join(agentsDataRoot, entry.name))).catch(() => {})
      }
    }
  } catch {
    /* best effort */
  }
}
