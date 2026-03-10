import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const threadStateEnum = pgEnum('thread_state', [
  'active',
  'waiting',
  'complete',
  'interrupted',
])

export const threads = pgTable('threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  state: threadStateEnum('state').notNull().default('active'),
  sourceChannel: text('source_channel'),
  initiatedBy: text('initiated_by').notNull(),
  trigger: text('trigger'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type ThreadRow = typeof threads.$inferSelect
export type NewThreadRow = typeof threads.$inferInsert
