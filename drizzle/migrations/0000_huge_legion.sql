CREATE TYPE "public"."thread_state" AS ENUM('active', 'waiting', 'complete', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."brain_type" AS ENUM('limbic', 'cortex', 'brainstem', 'amygdala', 'dmn');--> statement-breakpoint
CREATE TYPE "public"."slot_status" AS ENUM('pending', 'running', 'done', 'error');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('semantic', 'episodic', 'procedural', 'working', 'implicit');--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" "thread_state" DEFAULT 'active' NOT NULL,
	"source_channel" text,
	"initiated_by" text NOT NULL,
	"trigger" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"brain" "brain_type" NOT NULL,
	"status" "slot_status" DEFAULT 'pending' NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"intent" text,
	"complexity_hint" text,
	"execution_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slots_thread_brain_unique" UNIQUE("thread_id","brain")
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "memory_type" NOT NULL,
	"content" text NOT NULL,
	"entity_id" text,
	"segment_id" text,
	"segment_seq" integer,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"base_importance" double precision DEFAULT 0.5 NOT NULL,
	"usage_outcomes" jsonb DEFAULT '{"positive":0,"negative":0,"neutral":0}'::jsonb NOT NULL,
	"source_brain" text,
	"thread_id" text,
	"session_id" text,
	"supersedes_id" uuid,
	"t_invalid" timestamp with time zone,
	"last_accessed_at" timestamp with time zone,
	"pinned" boolean DEFAULT false NOT NULL,
	"forgotten" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_brain" text NOT NULL,
	"note" text NOT NULL,
	"trigger_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"base_importance" double precision DEFAULT 0.5 NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_supersedes_id_memories_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_memories_type" ON "memories" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_memories_tags" ON "memories" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "idx_memories_entity_id" ON "memories" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "idx_memories_segment_id" ON "memories" USING btree ("segment_id");--> statement-breakpoint
CREATE INDEX "idx_memories_t_invalid" ON "memories" USING btree ("t_invalid") WHERE t_invalid IS NULL;--> statement-breakpoint
CREATE INDEX "idx_memories_thread_id" ON "memories" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "idx_pending_expires_at" ON "pending_observations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_pending_trigger_at" ON "pending_observations" USING btree ("trigger_at");--> statement-breakpoint
CREATE INDEX "idx_pending_base_importance" ON "pending_observations" USING btree ("base_importance");