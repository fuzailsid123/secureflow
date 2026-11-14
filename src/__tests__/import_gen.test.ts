import { describe, expect, it } from 'vitest';
import { generateSyntheticWorkflow } from '@/lib/generator';
import { parseGitHubActionsYaml, parseWorkflowImport, toSarifReport } from '@/lib/import';
import { analyzeCycles } from '@/lib/scc';
import { simulateRun } from '@/lib/simulate';
import { buildGraph, topoSort } from '@/lib/topo';
import { validateWorkflowInput } from '@/lib/validate';

describe('Workflow import (JSON + GitHub Actions YAML) and SARIF export', () => {
  it('parses a GitHub Actions YAML workflow with scalar, inline-array, and bullet-list needs', () => {
    const yaml = `
name: Real CI
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
  lint:
    needs: setup
    steps:
      - run: npm run lint
  test:
    needs: [setup, lint]
    steps:
      - run: npm test
  deploy:
    needs:
      - lint
      - test
    steps:
      - run: echo deploy
`;
    const res = parseGitHubActionsYaml(yaml);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.name).toBe('Real CI');
    expect(res.value.tasks.map((t) => t.id)).toEqual(['setup', 'lint', 'test', 'deploy']);
    expect(res.value.edges).toEqual([
      ['setup', 'lint'],
      ['setup', 'test'],
      ['lint', 'test'],
      ['lint', 'deploy'],
      ['test', 'deploy'],
    ]);
  });

  it('auto-detects JSON imports and builds valid SARIF 2.1.0 output', () => {
    const jsonText = JSON.stringify({
      name: 'JSON Pipe',
      tasks: [{ id: 'a', name: 'A', durationMs: 10, log: 'bad AWS_SECRET_ACCESS_KEY' }],
      edges: [],
      patterns: ['AWS_SECRET_ACCESS_KEY'],
    });
    const imp = parseWorkflowImport(jsonText);
    expect(imp.ok).toBe(true);
    if (!imp.ok) return;
    expect(imp.format).toBe('json');

    const run = simulateRun({ id: 'w1', ...imp.value }, 1);
    const sarif = toSarifReport({ toolRunName: imp.value.name, findings: run.findings });
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results.length).toBe(1);
    expect(sarif.runs[0].results[0].ruleId).toBe('AWS_SECRET_ACCESS_KEY');
  });
});

describe('Synthetic DAG generator', () => {
  it('generates valid acyclic workflows for layered, diamond, chain, and random-dag shapes', () => {
    for (const shape of ['layered', 'diamond', 'chain', 'random-dag'] as const) {
      const wf = generateSyntheticWorkflow({ shape, taskCount: 30, seed: 99, injectLeak: true });
      const val = validateWorkflowInput(wf);
      expect(val.ok).toBe(true);
      const sorted = topoSort(buildGraph(wf.tasks.map((t) => t.id), wf.edges));
      expect(sorted.ok).toBe(true);
      const run = simulateRun({ id: shape, ...wf }, 4, { scanner: 'aho-corasick' });
      expect(run.metrics.quarantined).toBe(1);
    }
  });

  it('generates multi-cycle graphs detected by Tarjan SCC', () => {
    const wf = generateSyntheticWorkflow({ shape: 'multi-cycle', taskCount: 12, injectLeak: false });
    const g = buildGraph(wf.tasks.map((t) => t.id), wf.edges);
    const scc = analyzeCycles(g);
    expect(scc.cyclicSccs.length).toBe(2);
  });
});
