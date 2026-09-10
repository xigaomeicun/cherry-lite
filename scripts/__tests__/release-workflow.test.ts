import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import {
  CHINA_EDITION,
  EDITIONS,
  getExpectedReleaseArtifacts,
  getReleaseChannel,
  getReleaseDownloadGroups,
  getReleaseProductName,
  GLOBAL_EDITION
} from '../release/edition'

const projectRoot = path.join(import.meta.dirname, '..', '..')
const workflowsDir = path.join(projectRoot, '.github', 'workflows')
const releaseScriptsDir = path.join(projectRoot, 'scripts', 'release')

/** Upstream workflows gutted to workflow_dispatch + noop (keep shell; do not delete). */
const NEUTRALIZED_WORKFLOWS = [
  'auto-release-build.yml',
  'auto-update-catalog.yml',
  'backport-release-fixes.yml',
  'ci-rerun-on-base-change.yml',
  'claude.yml',
  'dispatch-docs-update.yml',
  'github-content-translator.yml',
  'github-issue-tracker.yml',
  'issue-management.yml',
  'nightly-build.yml',
  'post-release.yml',
  'pr-description-check.yml',
  'prepare-release.yml',
  'preview-release.yml',
  'publish-release.yml',
  'release-packages.yml',
  'release.yml',
  'snapshot.yml',
  'sync-registry-data.yml',
  'sync-to-gitcode.yml',
  'update-mergeable-prs.yml'
] as const

/** Upstream release helpers emptied to stubs; edition.js retained. */
const NEUTRALIZED_SCRIPTS = [
  'backport-patch.js',
  'compose-release-body.js',
  'hotfix-release-notes.js',
  'sync-release-history.js',
  'validate-edition-artifacts.js',
  'validate-prepared-release.js',
  'validate-release-state.js'
] as const

const ACTIVE_WORKFLOWS = ['build-lite.yml', 'ci.yml'] as const

const FORBIDDEN_TRIGGERS = ['push', 'pull_request', 'schedule', 'workflow_run'] as const

function readWorkflow(name: string): { raw: string; doc: Record<string, unknown> } {
  const raw = readFileSync(path.join(workflowsDir, name), 'utf8')
  return { raw, doc: parse(raw) as Record<string, unknown> }
}

function onTriggers(doc: Record<string, unknown>): string[] {
  const on = doc.on
  if (on == null) return []
  if (typeof on === 'string') return [on]
  if (Array.isArray(on)) return on.map(String)
  return Object.keys(on as Record<string, unknown>)
}

describe('cherry-lite upstream-release neutralization', () => {
  it('lists exactly the 21 neutralized workflow shells (excludes build-lite / ci)', () => {
    expect(NEUTRALIZED_WORKFLOWS).toHaveLength(21)
    for (const name of ACTIVE_WORKFLOWS) {
      expect(NEUTRALIZED_WORKFLOWS).not.toContain(name)
    }
  })

  it.each(NEUTRALIZED_WORKFLOWS)('%s is workflow_dispatch-only noop', (name) => {
    const filePath = path.join(workflowsDir, name)
    expect(existsSync(filePath), `${name} should exist`).toBe(true)

    const { raw, doc } = readWorkflow(name)
    const triggers = onTriggers(doc)

    expect(triggers).toEqual(['workflow_dispatch'])
    for (const forbidden of FORBIDDEN_TRIGGERS) {
      expect(triggers).not.toContain(forbidden)
    }

    expect(raw).toMatch(/neutralized for cherry-lite/i)
    const jobs = doc.jobs as Record<string, unknown> | undefined
    expect(jobs).toBeDefined()
    expect(Object.keys(jobs!)).toEqual(['noop'])
  })

  it.each(NEUTRALIZED_SCRIPTS)('%s is an empty neutralized stub', (name) => {
    const filePath = path.join(releaseScriptsDir, name)
    expect(existsSync(filePath), `${name} should exist`).toBe(true)

    const raw = readFileSync(filePath, 'utf8')
    expect(raw).toMatch(/Neutralized upstream release script/i)
    expect(raw).toMatch(/module\.exports\s*=\s*\{\s*\}/)
  })

  it('scripts/release/edition.js still exports real packaging helpers', () => {
    const filePath = path.join(releaseScriptsDir, 'edition.js')
    expect(existsSync(filePath)).toBe(true)

    const raw = readFileSync(filePath, 'utf8')
    expect(raw).not.toMatch(/Neutralized upstream release script/i)
    expect(raw).not.toMatch(/module\.exports\s*=\s*\{\s*\}/)

    expect(CHINA_EDITION).toBe('cn')
    expect(GLOBAL_EDITION).toBe('global')
    expect(EDITIONS).toEqual(['global', 'cn'])
    expect(typeof getReleaseChannel).toBe('function')
    expect(typeof getExpectedReleaseArtifacts).toBe('function')
    expect(typeof getReleaseProductName).toBe('function')
    expect(typeof getReleaseDownloadGroups).toBe('function')
  })

  it.each(ACTIVE_WORKFLOWS)('%s stays workflow_dispatch and is not a noop stub', (name) => {
    const filePath = path.join(workflowsDir, name)
    expect(existsSync(filePath), `${name} should exist`).toBe(true)

    const { raw, doc } = readWorkflow(name)
    const triggers = onTriggers(doc)

    expect(triggers).toContain('workflow_dispatch')
    for (const forbidden of FORBIDDEN_TRIGGERS) {
      expect(triggers).not.toContain(forbidden)
    }

    expect(raw).not.toMatch(/neutralized for cherry-lite/i)
    const jobs = doc.jobs as Record<string, unknown> | undefined
    expect(jobs).toBeDefined()
    expect(Object.keys(jobs!)).not.toEqual(['noop'])
    expect(Object.keys(jobs!).length).toBeGreaterThan(0)
  })
})
