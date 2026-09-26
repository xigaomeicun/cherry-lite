/**
 * Regenerates src/renderer/routeTree.gen.ts.
 *
 * The TanStack router plugin only generates the route tree during a vite
 * build, and this repo ships no `tsr` binary — so adding or removing a file
 * under src/renderer/routes/ leaves typecheck failing on an unknown route
 * until something invokes the generator. This script is that invocation.
 *
 * Usage: node scripts/generate-route-tree.mjs
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { getConfig } from '@tanstack/router-plugin'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

/**
 * @tanstack/router-generator is not a declared dependency, and pnpm blocks deep
 * subpath imports, so it has to be reached through the store. The generator is
 * always a sibling of the router plugin inside the same pnpm store directory.
 */
function resolveGeneratorEntry() {
  const pluginEntry = require.resolve('@tanstack/router-plugin')
  const storeDir = pluginEntry.split(`${sep}.pnpm${sep}`)[0] + `${sep}.pnpm`
  const scope = join(storeDir, 'node_modules', '@tanstack+router-generator@0.0.0')
  const [prefix] = require('node:fs')
    .readdirSync(storeDir)
    .filter((name) => name.startsWith('@tanstack+router-generator@'))
  if (!prefix) throw new Error(`no @tanstack/router-generator in ${scope}`)
  const entry = join(storeDir, prefix, 'node_modules', '@tanstack', 'router-generator', 'dist', 'esm', 'index.js')
  if (!existsSync(entry)) throw new Error(`generator entry missing: ${entry}`)
  return entry
}

const { Generator } = await import(pathToFileURL(resolveGeneratorEntry()).href)

const config = getConfig(
  {
    target: 'react',
    autoCodeSplitting: true,
    routesDirectory: resolve(root, 'src/renderer/routes'),
    generatedRouteTree: resolve(root, 'src/renderer/routeTree.gen.ts')
  },
  root
)

await new Generator({ config, root }).run()
console.log('routeTree.gen.ts regenerated')
