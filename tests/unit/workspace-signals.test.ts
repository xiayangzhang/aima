import { describe, expect, test } from 'bun:test'
import type { BrainSignal } from '../../src/adapters/index'
import { CognitiveWorkspace } from '../../src/workspace/index'

// Minimal mock DB — Signals are purely in-memory, no DB calls needed
const mockDb = {} as Parameters<typeof CognitiveWorkspace>[0]

describe('CognitiveWorkspace — Brain Signals', () => {
  test('pushSignal / hasSignal / popSignal round-trip', () => {
    const ws = new CognitiveWorkspace(mockDb)

    expect(ws.hasSignal('amygdala_interrupt', 'thread-1')).toBe(false)

    const sig: BrainSignal = { type: 'amygdala_interrupt', threadId: 'thread-1', message: 'halt!' }
    ws.pushSignal(sig)

    expect(ws.hasSignal('amygdala_interrupt', 'thread-1')).toBe(true)

    const popped = ws.popSignal('amygdala_interrupt', 'thread-1')
    expect(popped).toEqual(sig)
    expect(ws.hasSignal('amygdala_interrupt', 'thread-1')).toBe(false)
  })

  test('popSignal on empty queue returns undefined', () => {
    const ws = new CognitiveWorkspace(mockDb)
    expect(ws.popSignal('dmn_correction', 'thread-1')).toBeUndefined()
  })

  test('signals are FIFO within the same thread', () => {
    const ws = new CognitiveWorkspace(mockDb)
    const s1: BrainSignal = { type: 'dmn_correction', threadId: 'thread-1', message: 'first' }
    const s2: BrainSignal = { type: 'dmn_correction', threadId: 'thread-1', message: 'second' }
    ws.pushSignal(s1)
    ws.pushSignal(s2)

    expect(ws.popSignal('dmn_correction', 'thread-1')?.message).toBe('first')
    expect(ws.popSignal('dmn_correction', 'thread-1')?.message).toBe('second')
    expect(ws.popSignal('dmn_correction', 'thread-1')).toBeUndefined()
  })

  test('different signal types are independent', () => {
    const ws = new CognitiveWorkspace(mockDb)
    ws.pushSignal({ type: 'amygdala_interrupt', threadId: 'thread-1', message: 'interrupt' })
    ws.pushSignal({ type: 'dmn_correction', threadId: 'thread-1', message: 'correct' })

    expect(ws.hasSignal('amygdala_interrupt', 'thread-1')).toBe(true)
    expect(ws.hasSignal('dmn_correction', 'thread-1')).toBe(true)

    ws.popSignal('amygdala_interrupt', 'thread-1')
    expect(ws.hasSignal('amygdala_interrupt', 'thread-1')).toBe(false)
    expect(ws.hasSignal('dmn_correction', 'thread-1')).toBe(true)
  })

  test('signals from different threads are isolated', () => {
    const ws = new CognitiveWorkspace(mockDb)
    ws.pushSignal({ type: 'amygdala_interrupt', threadId: 'thread-A', message: 'interrupt-A' })
    ws.pushSignal({ type: 'amygdala_interrupt', threadId: 'thread-B', message: 'interrupt-B' })

    // thread-B sees its own signal, not thread-A's
    expect(ws.hasSignal('amygdala_interrupt', 'thread-B')).toBe(true)
    const poppedB = ws.popSignal('amygdala_interrupt', 'thread-B')
    expect(poppedB?.message).toBe('interrupt-B')

    // thread-A signal is unaffected
    expect(ws.hasSignal('amygdala_interrupt', 'thread-A')).toBe(true)
    const poppedA = ws.popSignal('amygdala_interrupt', 'thread-A')
    expect(poppedA?.message).toBe('interrupt-A')
  })
})
