import { describe, expect, test } from 'bun:test'
import type { BrainSignal } from '../../src/adapters/index'
import { CognitiveWorkspace } from '../../src/workspace/index'

// Minimal mock DB — Signals are purely in-memory, no DB calls needed
const mockDb = {} as Parameters<typeof CognitiveWorkspace>[0]

describe('CognitiveWorkspace — Brain Signals', () => {
  test('pushSignal / hasSignal / popSignal round-trip', () => {
    const ws = new CognitiveWorkspace(mockDb)

    expect(ws.hasSignal('amygdala_interrupt')).toBe(false)

    const sig: BrainSignal = { type: 'amygdala_interrupt', message: 'halt!' }
    ws.pushSignal(sig)

    expect(ws.hasSignal('amygdala_interrupt')).toBe(true)

    const popped = ws.popSignal('amygdala_interrupt')
    expect(popped).toEqual(sig)
    expect(ws.hasSignal('amygdala_interrupt')).toBe(false)
  })

  test('popSignal on empty queue returns undefined', () => {
    const ws = new CognitiveWorkspace(mockDb)
    expect(ws.popSignal('dmn_correction')).toBeUndefined()
  })

  test('signals are FIFO', () => {
    const ws = new CognitiveWorkspace(mockDb)
    const s1: BrainSignal = { type: 'dmn_correction', message: 'first' }
    const s2: BrainSignal = { type: 'dmn_correction', message: 'second' }
    ws.pushSignal(s1)
    ws.pushSignal(s2)

    expect(ws.popSignal('dmn_correction')?.message).toBe('first')
    expect(ws.popSignal('dmn_correction')?.message).toBe('second')
    expect(ws.popSignal('dmn_correction')).toBeUndefined()
  })

  test('different signal types are independent', () => {
    const ws = new CognitiveWorkspace(mockDb)
    ws.pushSignal({ type: 'amygdala_interrupt', message: 'interrupt' })
    ws.pushSignal({ type: 'dmn_correction', message: 'correct' })

    expect(ws.hasSignal('amygdala_interrupt')).toBe(true)
    expect(ws.hasSignal('dmn_correction')).toBe(true)

    ws.popSignal('amygdala_interrupt')
    expect(ws.hasSignal('amygdala_interrupt')).toBe(false)
    expect(ws.hasSignal('dmn_correction')).toBe(true)
  })
})
