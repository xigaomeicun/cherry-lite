/**
 * Contract test for PresetProviderSeeder.run — neutered behavior.
 *
 * Cherry-Lite keeps the providers sidebar limited to user-defined providers,
 * so the seeder must not materialize the registry's commercial preset
 * providers. If a future merge restores the upstream seed body, this test
 * fails instead of silently re-seeding 60+ rows into user_provider.
 */

import { setupTestDatabase } from '@test-helpers/db'
import { describe, expect, it, vi } from 'vitest'

import { userProviderTable } from '@data/db/schemas/userProvider'
import { PresetProviderSeeder } from '@data/db/seeding/seeders/presetProviderSeeder'

vi.mock('@cherrystudio/provider-registry/node', () => {
  class RegistryLoader {
    loadProviders() {
      return [
        { id: 'openai', name: 'OpenAI', endpointConfigs: {}, defaultChatEndpoint: null },
        { id: 'anthropic', name: 'Anthropic', endpointConfigs: {}, defaultChatEndpoint: null }
      ]
    }
    getProvidersVersion() {
      return 'test-version'
    }
    loadModels() {
      return []
    }
    loadProviderModels() {
      return []
    }
  }
  return { RegistryLoader }
})

describe('PresetProviderSeeder.run — neutered', () => {
  const dbh = setupTestDatabase()

  it('does not insert preset providers even when the registry offers them', async () => {
    new PresetProviderSeeder().run(dbh.db)

    expect(await dbh.db.select().from(userProviderTable)).toHaveLength(0)
  })
})
