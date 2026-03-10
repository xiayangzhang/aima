import { jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { threads } from './threads'

export const brainTypeEnum = pgEnum('brain_type', [
  'limbic',
  'cortex',
  'brainstem',
  'amygdala',
  'dmn',
])

export const slotStatusEnum = pgEnum('slot_status', ['pending', 'running', 'done', 'error'])

export const slots = pgTable(
  'slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    brain: brainTypeEnum('brain').notNull(),
    status: slotStatusEnum('status').notNull().default('pending'),
    input: jsonb('input'),
    output: jsonb('output'),
    intent: text('intent'), // 'communicate' | 'execute' | 'both', Cortex only
    complexityHint: text('complexity_hint'), // 'simple' | 'complex', Cortex only
    executionSessionId: text('execution_session_id'), // Brainstem only
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    threadBrainUnique: unique('slots_thread_brain_unique').on(table.threadId, table.brain),
  }),
)

export type SlotRow = typeof slots.$inferSelect
export type NewSlotRow = typeof slots.$inferInsert
