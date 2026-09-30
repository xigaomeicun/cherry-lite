import * as fs from 'node:fs'
import * as path from 'node:path'

import { loggerService } from '@logger'
import { isOutsidePath } from '@main/utils/file'
import { findAllSkillDirectories, findSkillMdPath, parseSkillMetadata } from '@main/utils/markdownParser'
import {
  assertNoFoldedPathCollisions as assertNoFoldedPathCollisionsShared,
  assertZipEntriesWithin
} from '@main/utils/zipSafety'
import StreamZip from 'node-stream-zip'

/**
 * Handling for an untrusted skill tree on disk, however it arrived — an extracted ZIP or a shallow
 * clone. Owns the extraction ceilings and every containment check that decides which directory in
 * that tree is the skill being installed.
 */

const logger = loggerService.withContext('SkillArchive')

/** The install-wide ceilings — a Git tree is checked against these before checkout, too. */
export const MAX_EXTRACTED_SIZE = 100 * 1024 * 1024 // 100MB
export const MAX_FILES_COUNT = 2000

export async function validateZipFile(zipFilePath: string): Promise<void> {
  const stats = await fs.promises.stat(zipFilePath)
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${zipFilePath}`)
  }
  if (!zipFilePath.toLowerCase().endsWith('.zip')) {
    throw new Error(`Not a ZIP file: ${zipFilePath}`)
  }
}

/**
 * Paths differing only in case or Unicode composition land on one file on macOS and Windows, so the
 * installed content would depend on the platform and on which entry was written last.
 */
export const assertNoFoldedPathCollisions = (paths: readonly string[]): void =>
  assertNoFoldedPathCollisionsShared(paths, 'Skill')

export async function extractZip(zipFilePath: string, destDir: string): Promise<void> {
  const zip = new StreamZip.async({ file: zipFilePath })

  try {
    const entries = Object.values(await zip.entries())
    const entryNames = entries.map((entry) => entry.name)
    assertZipEntriesWithin(entryNames, destDir)
    assertNoFoldedPathCollisions(entryNames)
    // Measure the whole archive before rejecting it. Stopping at the entry that crosses a ceiling
    // reports the running counter — always the limit plus one entry — so an archive many times
    // over the limit reads as barely over it, and the user cannot tell why the install failed.
    // The central directory is already parsed and in memory here, so the full scan costs no I/O.
    const totalSize = entries.reduce((sum, entry) => sum + entry.size, 0)

    if (totalSize > MAX_EXTRACTED_SIZE) {
      throw new Error(`ZIP too large: ${totalSize} bytes exceeds ${MAX_EXTRACTED_SIZE}`)
    }
    if (entries.length > MAX_FILES_COUNT) {
      throw new Error(`ZIP has too many files: ${entries.length} exceeds ${MAX_FILES_COUNT}`)
    }

    await zip.extract(null, destDir)
  } finally {
    await zip.close()
  }
}

/** Apply the same ceilings an untrusted ZIP gets — a repository is no more trusted than an archive. */
export async function assertSkillDirectoryWithinLimits(skillDir: string): Promise<void> {
  let totalSize = 0
  let fileCount = 0

  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(entryPath)
        continue
      }
      if (!entry.isFile()) continue

      fileCount += 1
      totalSize += (await fs.promises.stat(entryPath)).size
      if (totalSize > MAX_EXTRACTED_SIZE) {
        throw new Error(`Skill directory too large: exceeds ${MAX_EXTRACTED_SIZE} bytes`)
      }
      if (fileCount > MAX_FILES_COUNT) {
        throw new Error(`Skill directory has too many files: exceeds ${MAX_FILES_COUNT}`)
      }
    }
  }

  await walk(skillDir)
}

/**
 * A symlinked component silently redirects the requested path elsewhere in the repository, so an
 * explicitly selected directory would install a skill other than the one shown to the user. The
 * realpath containment check alone cannot see this: the target stays inside the repository.
 */
async function assertNoSymlinkComponents(repoDir: string, relativePath: string): Promise<void> {
  let current = repoDir
  for (const part of relativePath.split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const stats = await fs.promises.lstat(current).catch(() => null)
    if (stats?.isSymbolicLink()) {
      throw new Error(`Skill directory path passes through a symlink: ${relativePath}`)
    }
  }
}

export async function resolveSkillDirectory(
  repoDir: string,
  skillName: string | null,
  directoryPath: string | null
): Promise<string> {
  if (directoryPath) {
    const resolved = path.resolve(repoDir, directoryPath)
    // Reject a directoryPath that escapes the clone root — a crafted identifier could otherwise
    // point install at an arbitrary local directory (path traversal).
    const relative = path.relative(repoDir, resolved)
    if (isOutsidePath(relative)) {
      throw new Error(`Skill directory path escapes the repository: ${directoryPath}`)
    }
    await assertNoSymlinkComponents(repoDir, relative)
    const skillMdPath = await findSkillMdPath(resolved)
    if (skillMdPath) return validateRepositorySkillDirectory(repoDir, resolved, skillMdPath)

    // Fail closed: an explicit directoryPath with no SKILL.md must NOT fall back to guessing a
    // different candidate in the repo — the user confirmed skill A and must not get skill B.
    throw new Error(`No SKILL.md found at the specified skill directory: ${directoryPath}`)
  }

  const candidates = await findAllSkillDirectories(repoDir, repoDir, 8)

  if (skillName) {
    const matches: typeof candidates = []
    for (const candidate of candidates) {
      try {
        const metadata = await parseSkillMetadata(
          candidate.folderPath,
          candidate.sourcePath || path.basename(candidate.folderPath),
          'skills',
          { calculateSize: false }
        )
        if (metadata.name === skillName) matches.push(candidate)
      } catch (error) {
        logger.warn('Failed to parse repository skill candidate', {
          folderPath: candidate.folderPath,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    if (matches.length === 1) {
      return validateRepositorySkillDirectory(repoDir, matches[0].folderPath)
    }
    if (matches.length > 1) {
      throw new Error(`Multiple SKILL.md files declare the specified skill: ${skillName}`)
    }
    throw new Error(`No SKILL.md found for the specified skill: ${skillName}`)
  }

  if (candidates.length === 1) {
    return validateRepositorySkillDirectory(repoDir, candidates[0].folderPath)
  }

  if (candidates.length > 0) {
    logger.warn('resolveSkillDirectory: fallback to first candidate', {
      directoryPath,
      skillName,
      candidateCount: candidates.length,
      selected: candidates[0].folderPath
    })
    return validateRepositorySkillDirectory(repoDir, candidates[0].folderPath)
  }

  const rootSkill = await findSkillMdPath(repoDir)
  if (rootSkill) return validateRepositorySkillDirectory(repoDir, repoDir, rootSkill)

  throw new Error(`No skill directory found in ${repoDir}`)
}

export async function validateRepositorySkillDirectory(
  repoDir: string,
  skillDir: string,
  knownSkillMdPath?: string
): Promise<string> {
  const [repoRealPath, skillRealPath] = await Promise.all([
    fs.promises.realpath(repoDir),
    fs.promises.realpath(skillDir)
  ])
  const relativeSkillPath = path.relative(repoRealPath, skillRealPath)
  if (isOutsidePath(relativeSkillPath)) {
    throw new Error(`Skill directory resolves outside the repository: ${skillDir}`)
  }

  const skillMdPath = knownSkillMdPath ?? (await findSkillMdPath(skillRealPath))
  if (!skillMdPath) throw new Error(`No SKILL.md found in ${skillDir}`)
  const skillMdRealPath = await fs.promises.realpath(skillMdPath)
  const relativeDescriptorPath = path.relative(repoRealPath, skillMdRealPath)
  if (isOutsidePath(relativeDescriptorPath)) {
    throw new Error(`Skill descriptor resolves outside the repository: ${skillMdPath}`)
  }
  return skillRealPath
}
