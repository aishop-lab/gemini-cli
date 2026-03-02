/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  formatSnapshotText,
  formatComparisonText,
  formatSuggestionsText,
  formatSnapshotJSON,
  formatSnapshotMarkdown,
  formatComparisonMarkdown,
} from './reportFormatter.js';
import type { PerformanceSnapshot } from './performanceAggregator.js';
import type { ComparisonResult } from './baselineManager.js';
import type { Suggestion } from './suggestionEngine.js';

function createMockSnapshot(
  overrides?: Partial<PerformanceSnapshot>,
): PerformanceSnapshot {
  return {
    timestamp: 1700000000000,
    startup: {
      totalMs: 2500,
      phases: [
        { name: 'load_cli_config', durationMs: 1800 },
        { name: 'initialize_plugins', durationMs: 700 },
      ],
    },
    memory: {
      heapUsedMB: 512,
      heapTotalMB: 1024,
      heapSizeLimitMB: 2048,
      rssMB: 680,
      utilization: 0.25,
    },
    tools: [
      {
        name: 'read_file',
        callCount: 42,
        successRate: 1,
        avgLatencyMs: 120,
        p95LatencyMs: 350,
      },
      {
        name: 'shell',
        callCount: 12,
        successRate: 0.833,
        avgLatencyMs: 800,
        p95LatencyMs: 2500,
      },
    ],
    models: [
      {
        model: 'gemini-2.0-flash',
        totalRequests: 15,
        errorRate: 0.067,
        avgLatencyMs: 450,
        inputTokens: 30000,
        outputTokens: 8000,
        cachedTokens: 10000,
        cacheHitRate: 0.333,
      },
    ],
    tokenEfficiency: {
      totalInput: 30000,
      totalOutput: 8000,
      totalCached: 10000,
      cacheHitRate: 0.333,
    },
    ...overrides,
  };
}

describe('reportFormatter', () => {
  describe('formatSnapshotText', () => {
    it('should produce readable terminal output', () => {
      const output = formatSnapshotText(createMockSnapshot());

      expect(output).toContain('Performance Snapshot');
      expect(output).toContain('Startup: 2.5s');
      expect(output).toContain('load_cli_config');
      expect(output).toContain('1.8s');
      expect(output).toContain('512MB / 2048MB');
      expect(output).toContain('25.0%');
      expect(output).toContain('RSS: 680MB');
    });

    it('should format tool performance table', () => {
      const output = formatSnapshotText(createMockSnapshot());

      expect(output).toContain('Tool Performance:');
      expect(output).toContain('read_file');
      expect(output).toContain('42');
      expect(output).toContain('350ms');
      expect(output).toContain('shell');
      expect(output).toContain('2.5s');
    });

    it('should format model API stats', () => {
      const output = formatSnapshotText(createMockSnapshot());

      expect(output).toContain('API Performance:');
      expect(output).toContain('gemini-2.0-flash');
      expect(output).toContain('15 reqs');
      expect(output).toContain('93.3% success');
    });

    it('should format token efficiency line', () => {
      const output = formatSnapshotText(createMockSnapshot());

      expect(output).toContain('30000 in / 8000 out / 10000 cached');
      expect(output).toContain('33.3% hit rate');
    });

    it('should skip tool section when no tools used', () => {
      const output = formatSnapshotText(createMockSnapshot({ tools: [] }));

      expect(output).not.toContain('Tool Performance:');
    });

    it('should skip model section when no API calls', () => {
      const output = formatSnapshotText(createMockSnapshot({ models: [] }));

      expect(output).not.toContain('API Performance:');
    });

    it('should handle zero startup time', () => {
      const output = formatSnapshotText(
        createMockSnapshot({
          startup: { totalMs: 0, phases: [] },
        }),
      );

      expect(output).toContain('Startup: 0ms');
    });

    it('should format sub-second durations as milliseconds', () => {
      const output = formatSnapshotText(
        createMockSnapshot({
          startup: { totalMs: 450, phases: [] },
        }),
      );

      expect(output).toContain('Startup: 450ms');
    });
  });

  describe('formatComparisonText', () => {
    it('should report no regressions', () => {
      const result: ComparisonResult = {
        timestamp: Date.now(),
        baselineTimestamp: Date.now() - 86400000,
        metrics: [],
        hasRegression: false,
        highestSeverity: 'none',
      };

      expect(formatComparisonText(result)).toBe(
        'No performance regressions detected.',
      );
    });

    it('should format regression with severity and change', () => {
      const result: ComparisonResult = {
        timestamp: Date.now(),
        baselineTimestamp: Date.now() - 86400000,
        metrics: [
          {
            metric: 'startup.totalMs',
            baseline: 1000,
            current: 1500,
            changePercent: 50,
            regression: true,
            severity: 'medium',
          },
        ],
        hasRegression: true,
        highestSeverity: 'medium',
      };

      const output = formatComparisonText(result);
      expect(output).toContain('Performance Regression Detected');
      expect(output).toContain('medium');
      expect(output).toContain('[MEDIUM]');
      expect(output).toContain('startup.totalMs');
      expect(output).toContain('+50.0%');
    });

    it('should only show regressed metrics', () => {
      const result: ComparisonResult = {
        timestamp: Date.now(),
        baselineTimestamp: Date.now() - 86400000,
        metrics: [
          {
            metric: 'startup.totalMs',
            baseline: 1000,
            current: 1500,
            changePercent: 50,
            regression: true,
            severity: 'medium',
          },
          {
            metric: 'memory.utilization',
            baseline: 0.2,
            current: 0.18,
            changePercent: -10,
            regression: false,
            severity: 'none',
          },
        ],
        hasRegression: true,
        highestSeverity: 'medium',
      };

      const output = formatComparisonText(result);
      expect(output).toContain('startup.totalMs');
      expect(output).not.toContain('memory.utilization');
    });

    it('should show negative change without plus sign', () => {
      const result: ComparisonResult = {
        timestamp: Date.now(),
        baselineTimestamp: Date.now() - 86400000,
        metrics: [
          {
            metric: 'tokenEfficiency.cacheHitRate',
            baseline: 0.5,
            current: 0.2,
            changePercent: -60,
            regression: true,
            severity: 'high',
          },
        ],
        hasRegression: true,
        highestSeverity: 'high',
      };

      const output = formatComparisonText(result);
      expect(output).toContain('-60.0%');
      expect(output).not.toContain('+-');
    });
  });

  describe('formatSuggestionsText', () => {
    it('should return placeholder when no suggestions', () => {
      expect(formatSuggestionsText([])).toBe('No optimization suggestions.');
    });

    it('should format suggestions with severity icons', () => {
      const suggestions: Suggestion[] = [
        {
          category: 'memory',
          severity: 'critical',
          message: 'High memory usage (90% of heap limit).',
        },
        {
          category: 'token',
          severity: 'warning',
          message: 'Low cache utilization (10.0%).',
        },
        {
          category: 'general',
          severity: 'info',
          message: 'Session running for 2 hours.',
        },
      ];

      const output = formatSuggestionsText(suggestions);
      expect(output).toContain('[!] High memory usage');
      expect(output).toContain('[*] Low cache utilization');
      expect(output).toContain('[-] Session running');
    });
  });

  describe('formatSnapshotJSON', () => {
    it('should produce valid compact JSON', () => {
      const snapshot = createMockSnapshot();
      const json = formatSnapshotJSON(snapshot);
      const parsed = JSON.parse(json);

      expect(parsed.timestamp).toBe(snapshot.timestamp);
      expect(parsed.startup.totalMs).toBe(2500);
      expect(json).not.toContain('\n');
    });

    it('should produce valid pretty-printed JSON', () => {
      const snapshot = createMockSnapshot();
      const json = formatSnapshotJSON(snapshot, true);
      const parsed = JSON.parse(json);

      expect(parsed.timestamp).toBe(snapshot.timestamp);
      expect(json).toContain('\n');
      expect(json).toContain('  ');
    });

    it('should roundtrip through parse without loss', () => {
      const snapshot = createMockSnapshot();
      const json = formatSnapshotJSON(snapshot);
      const parsed: unknown = JSON.parse(json);

      expect(parsed).toEqual(snapshot);
    });
  });

  describe('formatSnapshotMarkdown', () => {
    it('should produce valid markdown with headers', () => {
      const output = formatSnapshotMarkdown(createMockSnapshot());

      expect(output).toContain('## Performance Report');
      expect(output).toContain('**Startup:**');
      expect(output).toContain('**Memory:**');
      expect(output).toContain('**Tokens:**');
    });

    it('should render startup phases as a table', () => {
      const output = formatSnapshotMarkdown(createMockSnapshot());

      expect(output).toContain('| Phase | Duration |');
      expect(output).toContain('|-------|----------|');
      expect(output).toContain('| load_cli_config | 1.8s |');
    });

    it('should render tools as a table', () => {
      const output = formatSnapshotMarkdown(createMockSnapshot());

      expect(output).toContain('### Tool Performance');
      expect(output).toContain('| Tool | Calls | P95 | Avg | Success |');
      expect(output).toContain('| read_file | 42 | 350ms | 120ms | 100.0% |');
    });

    it('should skip phase table when no phases', () => {
      const output = formatSnapshotMarkdown(
        createMockSnapshot({
          startup: { totalMs: 500, phases: [] },
        }),
      );

      expect(output).not.toContain('| Phase | Duration |');
    });

    it('should skip tool table when no tools', () => {
      const output = formatSnapshotMarkdown(createMockSnapshot({ tools: [] }));

      expect(output).not.toContain('### Tool Performance');
    });
  });

  describe('formatComparisonMarkdown', () => {
    it('should show passed status when no regression', () => {
      const result: ComparisonResult = {
        timestamp: Date.now(),
        baselineTimestamp: Date.now() - 86400000,
        metrics: [],
        hasRegression: false,
        highestSeverity: 'none',
      };

      const output = formatComparisonMarkdown(result);
      expect(output).toContain('### Regression Check: Passed');
      expect(output).toContain('No performance regressions detected.');
    });

    it('should render regression table in markdown', () => {
      const result: ComparisonResult = {
        timestamp: Date.now(),
        baselineTimestamp: Date.now() - 86400000,
        metrics: [
          {
            metric: 'startup.totalMs',
            baseline: 1000,
            current: 2000,
            changePercent: 100,
            regression: true,
            severity: 'high',
          },
          {
            metric: 'memory.utilization',
            baseline: 0.3,
            current: 0.25,
            changePercent: -16.7,
            regression: false,
            severity: 'none',
          },
        ],
        hasRegression: true,
        highestSeverity: 'high',
      };

      const output = formatComparisonMarkdown(result);
      expect(output).toContain('### Regression Check: Failed (high)');
      expect(output).toContain(
        '| Metric | Baseline | Current | Change | Severity |',
      );
      expect(output).toContain(
        '| startup.totalMs | 1000 | 2000 | +100.0% | high |',
      );
      // Should not include non-regressed metrics in the table
      expect(output).not.toContain('memory.utilization');
    });
  });
});
