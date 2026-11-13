/**
 * Contract test for LocalModelSeeder.run — neutered behavior.
 *
 * Cherry-Lite keeps the providers sidebar limited to user-defined providers,
 * so the seeder must not materialize the built-in Local Models provider or its
 * embedding model. If a future merge restores the upstream seed body, this
 * test fails instead of silently re-seeding the sidebar.
 */

import { setupTestDatabase } from '@test-helpers/db'
import { describe, expect, it } from 'vitest'

import { userModelTable } from '@data/db/schemas/userModel'
import { userProviderTable } from '@data/db/schemas/userProvider'
import { LocalModelSeeder } from '@data/db/seeding/seeders/LocalModelSeeder'

describe('LocalModelSeeder', () => {
  const dbh = setupTestDatabase()

  it('does not seed the local embedding provider or model', async () => {
    new LocalModelSeeder().run(dbh.db)

    expect(await dbh.db.select().from(userProviderTable)).toHaveLength(0)
    expect(await dbh.db.select().from(userModelTable)).toHaveLength(0)
  })
})
