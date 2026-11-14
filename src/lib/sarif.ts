export interface SarifFindingInput {
  taskId?: string;
  pattern: string;
  byteOffset: number;
  line: number;
  column: number;
  ruleKind?: string;
  entropy?: number;
  context?: { before: string; match: string; after: string };
}

/** Formats run or audit findings as a valid SARIF 2.1.0 JSON document (browser-safe). */
export function toSarifReport(source: { toolRunName: string; findings: SarifFindingInput[] }) {
  const rulesMap = new Map<string, { id: string; shortDescription: { text: string } }>();
  for (const f of source.findings) {
    if (!rulesMap.has(f.pattern)) {
      rulesMap.set(f.pattern, {
        id: f.pattern,
        shortDescription: {
          text: f.ruleKind ? `Forbidden ${f.ruleKind} pattern: ${f.pattern}` : `Forbidden pattern: ${f.pattern}`,
        },
      });
    }
  }

  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'SecureFlow',
            informationUri: 'https://github.com/secureflow',
            rules: [...rulesMap.values()],
          },
        },
        invocations: [{ executionSuccessful: true, workingDirectory: { uri: source.toolRunName } }],
        results: source.findings.map((f) => ({
          ruleId: f.pattern,
          level: 'error',
          message: {
            text: `Matched "${f.pattern}" at byte ${f.byteOffset} (line ${f.line}, col ${f.column})${
              f.entropy !== undefined ? ` [entropy=${f.entropy}]` : ''
            }`,
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.taskId ? `tasks/${f.taskId}.log` : 'audit.log' },
                region: {
                  startLine: f.line,
                  startColumn: f.column,
                  byteOffset: f.byteOffset,
                  snippet: f.context ? { text: `${f.context.before}${f.context.match}${f.context.after}` } : undefined,
                },
              },
            },
          ],
        })),
      },
    ],
  };
}
