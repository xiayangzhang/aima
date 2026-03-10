import { doublePrecision, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const pendingObservations = pgTable(
  'pending_observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    targetBrain: text('target_brain').notNull(), // BrainType value
    note: text('note').notNull(),
    triggerAt: timestamp('trigger_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    baseImportance: doublePrecision('base_importance').notNull().default(0.5),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    expiresAtIdx: index('idx_pending_expires_at').on(table.expiresAt),
    triggerAtIdx: index('idx_pending_trigger_at').on(table.triggerAt),
    baseImportanceIdx: index('idx_pending_base_importance').on(table.baseImportance),
  }),
)

export type PendingRow = typeof pendingObservations.$inferSelect
export type NewPendingRow = typeof pendingObservations.$inferInsert
