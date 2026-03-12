-- Enable pgvector extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to memories table
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);

-- Create HNSW index for cosine similarity search
-- Note: requires pgvector >= 0.5.0
CREATE INDEX IF NOT EXISTS "idx_memories_embedding_hnsw"
  ON "memories" USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
