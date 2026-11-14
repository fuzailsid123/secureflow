import type { Task, WorkflowInput } from './types';

/** Deterministic ASCII filler of exactly `n` characters (so bytes === chars). */
function filler(n: number, tag: string): string {
  let s = '';
  for (let i = 0; s.length < n; i++) {
    s += `[${tag}] ${String(i).padStart(4, '0')} INFO step completed in ${(i * 37) % 900}ms\n`;
  }
  return s.slice(0, n);
}

function makeLog(tag: string, total: number, inject?: { text: string; at: number }): string {
  if (!inject) return filler(total, tag);
  const before = filler(inject.at, tag);
  const after = filler(total - inject.at - inject.text.length, `${tag}+`);
  return before + inject.text + after;
}

const t = (id: string, name: string, durationMs: number, log: string): Task => ({ id, name, durationMs, log });

/**
 * A CI/CD-style pipeline. `integration-tests` leaks a forbidden token at byte 4089, which straddles
 * the 4096-byte chunk boundary, so the scan demonstrates KMP carrying state between chunks.
 * Expected outcome: integration-tests is quarantined; package, deploy-staging, smoke-tests and
 * deploy-prod are cancelled; everything else completes.
 */
export function sampleWorkflowInput(): WorkflowInput {
  return {
    name: 'Sample CI/CD pipeline',
    tasks: [
      t('checkout', 'Clone repository', 800, makeLog('checkout', 1200)),
      t('install', 'Install dependencies', 2500, makeLog('install', 3000)),
      t('lint', 'Lint sources', 1500, makeLog('lint', 2500, { text: 'warning: DEPRECATED_CALX is not a rule\n', at: 900 })),
      t('unit-tests', 'Unit tests', 3000, makeLog('unit', 6000)),
      t('build', 'Compile and bundle', 4000, makeLog('build', 5000)),
      t(
        'integration-tests',
        'Integration tests',
        3500,
        makeLog('integ', 9000, { text: ' ERROR: UNAUTHORIZED_ACCESS to /admin', at: 4081 }),
      ),
      t('security-scan', 'Dependency security scan', 2000, makeLog('scan', 2500)),
      t('docs', 'Generate documentation', 1200, makeLog('docs', 1500)),
      t('package', 'Package artifacts', 1500, makeLog('package', 2000)),
      t('deploy-staging', 'Deploy to staging', 2000, makeLog('stage', 2500)),
      t('smoke-tests', 'Smoke tests', 1500, makeLog('smoke', 1800)),
      t('deploy-prod', 'Deploy to production', 2500, makeLog('prod', 2500)),
    ],
    edges: [
      ['checkout', 'install'],
      ['checkout', 'docs'],
      ['install', 'lint'],
      ['install', 'unit-tests'],
      ['install', 'build'],
      ['build', 'integration-tests'],
      ['unit-tests', 'integration-tests'],
      ['build', 'security-scan'],
      ['integration-tests', 'package'],
      ['security-scan', 'package'],
      ['lint', 'package'],
      ['package', 'deploy-staging'],
      ['deploy-staging', 'smoke-tests'],
      ['smoke-tests', 'deploy-prod'],
      ['docs', 'deploy-prod'],
    ],
    patterns: ['UNAUTHORIZED_ACCESS', 'DEPRECATED_CALL', 'AWS_SECRET_ACCESS_KEY'],
  };
}
