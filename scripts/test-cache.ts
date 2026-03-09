/**
 * AIMA Cache Sharing Test
 *
 * Question: Can different threads (different sessions) share the same
 * Block 1+2 prompt cache? What are the edge cases?
 *
 * Run: npx tsx test-cache.ts
 * Requires: ANTHROPIC_API_KEY env var
 */

import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = 'claude-sonnet-4-6'

// ---------------------------------------------------------------------------
// Simulate Block 1+2: identity + skill index (must be large enough to cache)
// Anthropic requires ~1024 tokens minimum for cache to activate.
// Real Block 1+2 will be much larger; we pad here for the test.
// ---------------------------------------------------------------------------
const IDENTITY = `
You are Alex, a cognitive AI agent operating within the AIMA (Artificial
Intelligence: A Minded Architecture) framework. You are a virtual employee
working within an organization, collaborating with human colleagues on tasks
across procurement, project management, risk, and operations.

Your cognitive architecture consists of five brain regions:
- Limbic: handles all external communication and routing
- Cortex: performs deep reasoning and planning
- Brainstem: executes system operations and API calls
- Amygdala: evaluates risk before tool execution
- DMN: reflects, consolidates memory, and monitors ongoing tasks

You operate through a cognitive workspace using Threads and Slots. Each Thread
represents a unit of work. You write structured outputs to your Slot when done.
`.trim()

const SKILL_INDEX = `
## Skill Index

### Communication Skills
- skill:professional-communication — Composing clear, appropriately toned messages
- skill:meeting-summary — Extracting action items and decisions from meeting notes
- skill:escalation-protocol — Knowing when and how to escalate issues

### Analysis Skills
- skill:procurement-analysis — Evaluating supplier quotes and purchase requests
- skill:risk-assessment — Identifying and categorizing operational risks
- skill:project-status-report — Compiling project health summaries

### Execution Skills
- skill:dataverse-crud — Creating, reading, updating Dataverse records
- skill:approval-routing — Moving approval workflows through Power Automate
- skill:notification-dispatch — Sending structured notifications via Teams/Email
`.trim()

// Pad to ensure we exceed the minimum cache threshold
const PADDING = `
Additional context about organizational policies, escalation paths, compliance
requirements, and standard operating procedures follows below. This content
is part of the stable identity block and is injected at session start.

Organizational Policies:
The organization follows ISO 27001 information security standards and requires
all data processing activities to be logged and auditable. All external API
calls must go through the approved integration gateway. Financial transactions
above $10,000 require dual approval from two authorized approvers. Personally
identifiable information must be handled in accordance with the Privacy Act 2025.

Escalation Paths:
Level 1 - Routine operations: Alex handles autonomously with full audit trail.
Level 2 - Exceptions requiring judgment: Alex notifies the responsible human
  owner and waits for acknowledgement before proceeding.
Level 3 - High-risk operations: Alex pauses, sends a detailed explanation to
  the approver, and requires explicit written authorization.
Level 4 - Emergency stop: Alex halts all operations, preserves state, and
  pages the on-call team immediately.

Standard Operating Procedures:
SOP-001: Procurement request processing — validate request completeness,
  check budget availability, route to appropriate approver, track to completion.
SOP-002: Risk assessment workflow — identify, categorize, score, assign owner,
  schedule review, track mitigation status.
SOP-003: Project status reporting — collect updates from Dataverse, summarize
  progress against milestones, flag blockers, distribute to stakeholders.
SOP-004: Supplier evaluation — collect quotes, apply scoring matrix, document
  comparison, recommend preferred supplier with justification.
SOP-005: Change request management — log request, assess impact, route for
  approval, communicate outcome, update project plan.
`.trim().repeat(15)

const BLOCK_1_2 = [IDENTITY, SKILL_INDEX, PADDING].join('\n\n')
const ESTIMATED_TOKENS = Math.ceil(BLOCK_1_2.length / 4)

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
interface CallResult {
  label: string
  elapsed_ms: number
  input_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  output_tokens: number
}

async function callAPI(
  label: string,
  block3: string,           // Dynamic workspace state (not cached)
  userMessage: string,
  messages: Anthropic.MessageParam[] = [],
): Promise<CallResult> {
  const start = Date.now()

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 64,
    system: [
      {
        type: 'text',
        text: BLOCK_1_2,
        cache_control: { type: 'ephemeral' },  // Mark Block 1+2 as cacheable
      },
      {
        type: 'text',
        text: block3,  // Block 3: workspace state — NOT cached (changes per call)
      },
    ],
    messages: [
      ...messages,
      { role: 'user', content: userMessage },
    ],
  })

  const elapsed = Date.now() - start
  const u = response.usage as Anthropic.Usage & {
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }

  // Debug: print raw usage on first call
  if (messages.length === 0 && label.includes('Thread-A')) {
    console.log('  [raw usage]', JSON.stringify(response.usage))
  }

  const result: CallResult = {
    label,
    elapsed_ms: elapsed,
    input_tokens: u.input_tokens,
    cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_tokens: u.cache_read_input_tokens ?? 0,
    output_tokens: u.output_tokens,
  }

  const cacheStatus =
    result.cache_read_tokens > 0 ? '✅ CACHE HIT' :
    result.cache_creation_tokens > 0 ? '🔨 CACHE CREATED' :
    '❌ NO CACHE'

  console.log(`\n[${label}] ${cacheStatus}`)
  console.log(`  elapsed:        ${elapsed}ms`)
  console.log(`  input:          ${result.input_tokens} tokens`)
  console.log(`  cache_created:  ${result.cache_creation_tokens} tokens`)
  console.log(`  cache_read:     ${result.cache_read_tokens} tokens`)
  console.log(`  output:         ${result.output_tokens} tokens`)

  return result
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== AIMA Cross-Thread Prompt Cache Test ===')
  console.log(`Model:           ${MODEL}`)
  console.log(`Block 1+2 size:  ~${ESTIMATED_TOKENS} estimated tokens`)
  console.log(`API key:         ${process.env.ANTHROPIC_API_KEY ? '✓ set' : '✗ MISSING'}`)
  console.log()

  // ------------------------------------------------------------------
  // Test 1: Baseline — first call creates cache
  // ------------------------------------------------------------------
  console.log('── Test 1: First call (cache creation) ──')
  const t1 = await callAPI(
    'Thread-A / first call',
    'thread_id=thread-A | task=analyze_procurement_request | status=active',
    'Acknowledge the task in one sentence.',
  )

  await sleep(500)

  // ------------------------------------------------------------------
  // Test 2: Different thread, same Block 1+2 — should hit cache
  // ------------------------------------------------------------------
  console.log('\n── Test 2: Different thread, same Block 1+2 ──')
  const t2 = await callAPI(
    'Thread-B / new thread same prefix',
    'thread_id=thread-B | task=review_hr_policy | status=active',
    'Acknowledge the task in one sentence.',
  )

  await sleep(500)

  // ------------------------------------------------------------------
  // Test 3: Same thread continued (simulate Limbic re-activation) — should hit cache
  // ------------------------------------------------------------------
  console.log('\n── Test 3: Same thread, continued conversation ──')
  const t3 = await callAPI(
    'Thread-A / re-activation',
    'thread_id=thread-A | task=analyze_procurement_request | status=cortex_done',
    'What did you just acknowledge?',
    [
      { role: 'user', content: 'Acknowledge the task in one sentence.' },
      { role: 'assistant', content: 'Understood — I am ready to analyze the procurement request.' },
    ],
  )

  await sleep(500)

  // ------------------------------------------------------------------
  // Test 4: Block 1+2 modified even slightly — should MISS cache
  // ------------------------------------------------------------------
  console.log('\n── Test 4: Modified Block 1+2 (cache miss expected) ──')
  const start4 = Date.now()
  const r4 = await client.messages.create({
    model: MODEL,
    max_tokens: 64,
    system: [
      {
        type: 'text',
        text: BLOCK_1_2 + '\n<!-- version: 2 -->',  // tiny change
        cache_control: { type: 'ephemeral' },
      },
      { type: 'text', text: 'thread_id=thread-C | task=test' },
    ],
    messages: [{ role: 'user', content: 'Acknowledge in one sentence.' }],
  })
  const u4 = r4.usage as Anthropic.Usage & {
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  const elapsed4 = Date.now() - start4
  const cacheStatus4 =
    (u4.cache_read_input_tokens ?? 0) > 0 ? '✅ CACHE HIT (unexpected!)' :
    (u4.cache_creation_input_tokens ?? 0) > 0 ? '🔨 CACHE CREATED (expected miss+create)' :
    '❌ NO CACHE'
  console.log(`[Thread-C / modified prefix] ${cacheStatus4}`)
  console.log(`  elapsed:        ${elapsed4}ms`)
  console.log(`  cache_created:  ${u4.cache_creation_input_tokens ?? 0}`)
  console.log(`  cache_read:     ${u4.cache_read_input_tokens ?? 0}`)

  // ------------------------------------------------------------------
  // Test 5: Timestamp IN Block 1+2 — cache miss every call
  // ------------------------------------------------------------------
  console.log('\n── Test 5: Timestamp inside Block 1+2 (breaks cache) ──')
  const BLOCK_WITH_TS = BLOCK_1_2 + `\n\nSession initialized at: ${new Date().toISOString()}`
  const start5a = Date.now()
  const r5a = await client.messages.create({
    model: MODEL, max_tokens: 32,
    system: [
      { type: 'text', text: BLOCK_WITH_TS, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'thread_id=ts-test-1' },
    ],
    messages: [{ role: 'user', content: 'Hi.' }],
  })
  const u5a = r5a.usage as any
  console.log(`[Call 5a - with timestamp] elapsed: ${Date.now()-start5a}ms | created: ${u5a.cache_creation_input_tokens} | read: ${u5a.cache_read_input_tokens}`)

  await sleep(300)

  // Second call — timestamp changed → different content → cache MISS
  const BLOCK_WITH_TS2 = BLOCK_1_2 + `\n\nSession initialized at: ${new Date().toISOString()}`
  const start5b = Date.now()
  const r5b = await client.messages.create({
    model: MODEL, max_tokens: 32,
    system: [
      { type: 'text', text: BLOCK_WITH_TS2, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'thread_id=ts-test-2' },
    ],
    messages: [{ role: 'user', content: 'Hi.' }],
  })
  const u5b = r5b.usage as any
  console.log(`[Call 5b - timestamp changed] elapsed: ${Date.now()-start5b}ms | created: ${u5b.cache_creation_input_tokens} | read: ${u5b.cache_read_input_tokens}`)
  console.log(u5b.cache_read_input_tokens === 0
    ? '  ✅ CONFIRMED: timestamp in Block 1+2 kills cache'
    : '  ❌ UNEXPECTED: cache hit despite different timestamp')

  // ------------------------------------------------------------------
  // Test 6: Timestamp MOVED to Block 3 — Block 1+2 cache preserved
  // ------------------------------------------------------------------
  console.log('\n── Test 6: Timestamp in Block 3 only (cache survives) ──')
  const start6a = Date.now()
  const r6a = await client.messages.create({
    model: MODEL, max_tokens: 32,
    system: [
      { type: 'text', text: BLOCK_1_2, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `thread_id=ts-block3-1 | session_start=${new Date().toISOString()}` }, // timestamp in Block 3
    ],
    messages: [{ role: 'user', content: 'Hi.' }],
  })
  const u6a = r6a.usage as any
  console.log(`[Call 6a - ts in Block 3] elapsed: ${Date.now()-start6a}ms | created: ${u6a.cache_creation_input_tokens} | read: ${u6a.cache_read_input_tokens}`)

  await sleep(300)

  const start6b = Date.now()
  const r6b = await client.messages.create({
    model: MODEL, max_tokens: 32,
    system: [
      { type: 'text', text: BLOCK_1_2, cache_control: { type: 'ephemeral' } }, // identical
      { type: 'text', text: `thread_id=ts-block3-2 | session_start=${new Date().toISOString()}` }, // timestamp changed, but in Block 3
    ],
    messages: [{ role: 'user', content: 'Hi.' }],
  })
  const u6b = r6b.usage as any
  console.log(`[Call 6b - ts in Block 3, changed] elapsed: ${Date.now()-start6b}ms | created: ${u6b.cache_creation_input_tokens} | read: ${u6b.cache_read_input_tokens}`)
  console.log(u6b.cache_read_input_tokens > 0
    ? '  ✅ CONFIRMED: timestamp in Block 3 preserves Block 1+2 cache'
    : '  ❌ Block 1+2 cache missed despite no changes')

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  console.log('\n══════════════════════════════')
  console.log('RESULTS SUMMARY')
  console.log('══════════════════════════════')

  const crossThreadWorks = t2.cache_read_tokens > 0
  const continuationWorks = t3.cache_read_tokens > 0

  console.log(`Cross-thread cache sharing:     ${crossThreadWorks ? '✅ CONFIRMED' : '❌ NOT WORKING'}`)
  console.log(`Same-thread continuation cache: ${continuationWorks ? '✅ CONFIRMED' : '❌ NOT WORKING'}`)
  console.log(`Modified prefix breaks cache:   ${(u4.cache_read_input_tokens ?? 0) === 0 ? '✅ CONFIRMED' : '❌ UNEXPECTED HIT'}`)

  if (t1.cache_creation_tokens < 1024) {
    console.log('\n⚠️  WARNING: Block 1+2 may be too short to trigger caching.')
    console.log('   Anthropic requires ~1024+ tokens for cache to activate.')
    console.log(`   Estimated size: ~${ESTIMATED_TOKENS} tokens`)
  }

  console.log('\n── Known constraints to keep in mind ──')
  console.log('1. Cache is workspace-scoped (not org-scoped, since 2026-02-05)')
  console.log('2. Cache is per-model — Sonnet and Opus do NOT share cache')
  console.log('3. Tool definitions are part of the cached prefix — changes break it')
  console.log('4. Default TTL: ~5 min; ephemeral: up to 1 hour (model-dependent)')
  console.log('5. Block 3+4 must NOT be inside cache_control — they change per call')
  console.log('6. Even whitespace changes invalidate cache — Block 1+2 must be byte-exact')
}

main().catch(err => {
  console.error('Error:', err.message ?? err)
  process.exit(1)
})
