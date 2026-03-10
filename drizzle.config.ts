import type { Config } from 'drizzle-kit'

export default {
  schema: [
    './src/schema/threads.ts',
    './src/schema/slots.ts',
    './src/schema/memories.ts',
    './src/schema/pending.ts',
  ],
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
} satisfies Config
