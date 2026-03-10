import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '../../../src/schema/index'
import { CognitiveWorkspace } from '../../../src/workspace/index'
import type { DrizzleDB } from '../../../src/workspace/index'

const TEST_DB_URL = process.env.AIMA_TEST_DATABASE_URL

export function isTestDbAvailable(): boolean {
  return Boolean(TEST_DB_URL)
}

export function createTestDb() {
  if (!TEST_DB_URL) {
    throw new Error(
      'AIMA_TEST_DATABASE_URL not set. Skipping integration tests.\n' +
        'Set AIMA_TEST_DATABASE_URL=postgresql://aima:aima@localhost:5434/aima_test',
    )
  }
  const client = postgres(TEST_DB_URL)
  const db = drizzle(client, { schema })
  return { db, client }
}

// Fixture: run test inside a transaction that always rolls back.
// Uses the "deliberate throw" pattern to force Drizzle to ROLLBACK,
// while still returning the test result to the caller.
export async function withTransaction<T>(
  db: DrizzleDB,
  fn: (workspace: CognitiveWorkspace) => Promise<T>,
): Promise<T> {
  let captured: T | undefined

  try {
    await db.transaction(async (tx) => {
      const workspace = new CognitiveWorkspace(tx as unknown as DrizzleDB)
      captured = await fn(workspace)
      // Force rollback by throwing — Drizzle rolls back on any throw
      throw new Error('__rollback__')
    })
  } catch (e) {
    if (e instanceof Error && e.message === '__rollback__') {
      return captured as T
    }
    throw e
  }

  // Should never reach here
  return captured as T
}
