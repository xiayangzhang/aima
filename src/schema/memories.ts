import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from 'drizzle-orm/pg-core'

export const memoryTypeEnum = pgEnum('memory_type', [
  'semantic',
  'episodic',
  'procedural',
  'working',
  'implicit',
])

export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: memoryTypeEnum('type').notNull(),
    content: text('content').notNull(),
    entityId: text('entity_id'),
    segmentId: text('segment_id'),
    segmentSeq: integer('segment_seq'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    baseImportance: doublePrecision('base_importance').notNull().default(0.5),
    usageOutcomes: jsonb('usage_outcomes')
      .notNull()
      .default(sql`'{"positive":0,"negative":0,"neutral":0}'::jsonb`),
    sourceBrain: text('source_brain'),
    threadId: text('thread_id'),
    sessionId: text('session_id'),
    supersedesId: uuid('supersedes_id').references((): AnyPgColumn => memories.id),
    tInvalid: timestamp('t_invalid', { withTimezone: true }),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
    pinned: boolean('pinned').notNull().default(false),
    forgotten: boolean('forgotten').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    embedding: vector('embedding', { dimensions: 1536 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    typeIdx: index('idx_memories_type').on(table.type),
    tagsIdx: index('idx_memories_tags').using('gin', table.tags),
    entityIdIdx: index('idx_memories_entity_id').on(table.entityId),
    segmentIdIdx: index('idx_memories_segment_id').on(table.segmentId),
    tInvalidIdx: index('idx_memories_t_invalid').on(table.tInvalid).where(sql`t_invalid IS NULL`),
    threadIdIdx: index('idx_memories_thread_id').on(table.threadId),
    sessionIdIdx: index('idx_memories_session_id')
      .on(table.sessionId)
      .where(sql`session_id IS NOT NULL`),
    embeddingHnswIdx: index('idx_memories_embedding_hnsw')
      // biome-ignore lint/suspicious/noExplicitAny: Drizzle HNSW index type inference requires any
      .using('hnsw', table.embedding as any)
      .with({ m: 16, ef_construction: 64 }),
  }),
)

export type MemoryRow = typeof memories.$inferSelect
export type NewMemoryRow = typeof memories.$inferInsert
