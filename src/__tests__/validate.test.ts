import { describe, expect, it } from 'vitest';
import { validateWorkers, validateWorkflowInput } from '@/lib/validate';
import { LIMITS } from '@/lib/limits';

const ok = () => ({
  name: ' My flow ',
  tasks: [{ id: 'a', durationMs: 5 }, { id: 'b', durationMs: 7, name: 'B', log: 'hi' }],
  edges: [['a', 'b'], ['a', 'b']],
  patterns: ['BAD'],
});

describe('validateWorkflowInput', () => {
  it('normalizes: trims name, defaults task name/log, drops duplicate edges', () => {
    const r = validateWorkflowInput(ok());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.name).toBe('My flow');
    expect(r.value.tasks[0]).toEqual({ id: 'a', name: 'a', durationMs: 5, log: '' });
    expect(r.value.edges).toEqual([['a', 'b']]);
  });

  it.each([
    ['non-object body', null],
    ['bad id', { ...ok(), tasks: [{ id: 'has space', durationMs: 5 }] }],
    ['duplicate id', { ...ok(), tasks: [{ id: 'a', durationMs: 5 }, { id: 'a', durationMs: 5 }] }],
    ['zero duration', { ...ok(), tasks: [{ id: 'a', durationMs: 0 }] }],
    ['fractional duration', { ...ok(), tasks: [{ id: 'a', durationMs: 1.5 }] }],
    ['unknown edge target', { ...ok(), edges: [['a', 'nope']] }],
    ['malformed edge', { ...ok(), edges: [['a']] }],
    ['empty pattern', { ...ok(), patterns: [''] }],
    ['duplicate pattern', { ...ok(), patterns: ['X', 'X'] }],
    ['too many patterns', { ...ok(), patterns: Array.from({ length: LIMITS.maxPatterns + 1 }, (_, i) => `p${i}`) }],
    ['oversized pattern', { ...ok(), patterns: ['x'.repeat(LIMITS.maxPatternBytes + 1)] }],
    ['oversized log', { ...ok(), tasks: [{ id: 'a', durationMs: 5, log: 'x'.repeat(LIMITS.maxTaskLogBytes + 1) }] }],
    ['too many tasks', { ...ok(), tasks: Array.from({ length: LIMITS.maxTasks + 1 }, (_, i) => ({ id: `t${i}`, durationMs: 1 })), edges: [] }],
  ])('rejects %s', (_label, body) => {
    expect(validateWorkflowInput(body).ok).toBe(false);
  });

  it('allows self-loops (they are reported later as cycles)', () => {
    expect(validateWorkflowInput({ ...ok(), edges: [['a', 'a']] }).ok).toBe(true);
  });
});

describe('validateWorkers', () => {
  it('accepts 1-16 integers only', () => {
    expect(validateWorkers(1).ok && validateWorkers(16).ok).toBe(true);
    for (const x of [0, 17, 2.5, '3', null, undefined]) expect(validateWorkers(x).ok).toBe(false);
  });
});
