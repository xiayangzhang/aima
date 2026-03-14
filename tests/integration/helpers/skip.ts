import { describe } from 'vitest'
import { isTestDbAvailable } from './db'

// Conditionally run a describe block — skip gracefully when test DB is unavailable.
export function describeWithDb(name: string, fn: () => void): void {
  if (!isTestDbAvailable()) {
    console.log(`⏭  Skipping integration suite: "${name}" (AIMA_TEST_DATABASE_URL not set)`)
    return
  }
  describe(name, fn)
}
