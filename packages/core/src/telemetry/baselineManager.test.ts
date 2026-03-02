/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BaselineManager } from './baselineManager.js';
import type { PerformanceSnapshot } from './performanceAggregator.js';
import type { ComparisonResult } from './baselineManager.js';

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn(),
  readFile: vi.fn(),
  mkdir: vi.fn(),
}));

function createMockSnapshot(
  overrides?: Partial<PerformanceSnapshot>,
): PerformanceSnapshot {
  return {
    timestamp: Date.now(),
    startup: { totalMs: 1000, phases: [] },
    memory: {
      heapUsedMB: 200,
      heapTotalMB: 500,
      heapSizeLimitMB: 2048,
      rssMB: 400,
      utilization: 0.1,
    },
    tools: [],
    models: [],
    tokenEfficiency: {
      totalInput: 5000,
      totalOutput: 3000,
      totalCached: 1500,
      cacheHitRate: 0.3,
    },
    ...overrides,
  };
}

describe('BaselineManager', () => {
  let manager: BaselineManager;
  let fsMock: typeof import('node:fs/promises');

  beforeEach(async () => {
    vi.resetAllMocks();
    manager = new BaselineManager();
    fsMock = await import('node:fs/promises');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('saveBaseline', () => {
    it('should write snapshot as JSON to the specified path', async () => {
      const snapshot = createMockSnapshot();
      await manager.saveBaseline(snapshot, '/tmp/baselines/perf.json');

      expect(fsMock.mkdir).toHaveBeenCalledWith('/tmp/baselines', {
        recursive: true,
      });
      expect(fsMock.writeFile).toHaveBeenCalledWith(
        '/tmp/baselines/perf.json',
        JSON.stringify(snapshot, null, 2),
        'utf-8',
      );
    });
  });

  describe('loadBaseline', () => {
    it('should load and parse a saved baseline', async () => {
      const snapshot = createMockSnapshot();
      vi.mocked(fsMock.readFile).mockResolvedValue(JSON.stringify(snapshot));

      const loaded = await manager.loadBaseline('/tmp/baselines/perf.json');
      expect(loaded).toEqual(snapshot);
    });

    it('should return null if file does not exist', async () => {
      vi.mocked(fsMock.readFile).mockRejectedValue(
        new Error('ENOENT: no such file or directory'),
      );

      const loaded = await manager.loadBaseline('/nonexistent/path.json');
      expect(loaded).toBeNull();
    });

    it('should return null for corrupted JSON', async () => {
      vi.mocked(fsMock.readFile).mockResolvedValue('{ invalid json content');

      const loaded = await manager.loadBaseline('/tmp/corrupted.json');
      expect(loaded).toBeNull();
    });
  });

  describe('compare', () => {
    it('should detect startup regression', () => {
      const baseline = createMockSnapshot({
        startup: { totalMs: 1000, phases: [] },
      });
      const current = createMockSnapshot({
        startup: { totalMs: 1500, phases: [] },
      });

      const result = manager.compare(current, baseline);
      const startupMetric = result.metrics.find(
        (m) => m.metric === 'startup.totalMs',
      );

      expect(startupMetric).toBeDefined();
      expect(startupMetric!.regression).toBe(true);
      expect(startupMetric!.changePercent).toBe(50);
      expect(result.hasRegression).toBe(true);
    });

    it('should not flag startup as regression within threshold', () => {
      const baseline = createMockSnapshot({
        startup: { totalMs: 1000, phases: [] },
      });
      const current = createMockSnapshot({
        startup: { totalMs: 1100, phases: [] },
      });

      const result = manager.compare(current, baseline);
      const startupMetric = result.metrics.find(
        (m) => m.metric === 'startup.totalMs',
      );

      expect(startupMetric!.regression).toBe(false);
    });

    it('should detect memory utilization regression', () => {
      const baseline = createMockSnapshot({
        memory: {
          heapUsedMB: 200,
          heapTotalMB: 500,
          heapSizeLimitMB: 2048,
          rssMB: 400,
          utilization: 0.3,
        },
      });
      const current = createMockSnapshot({
        memory: {
          heapUsedMB: 1000,
          heapTotalMB: 1500,
          heapSizeLimitMB: 2048,
          rssMB: 1200,
          utilization: 0.6,
        },
      });

      const result = manager.compare(current, baseline);
      const memMetric = result.metrics.find(
        (m) => m.metric === 'memory.utilization',
      );

      expect(memMetric!.regression).toBe(true);
      expect(result.hasRegression).toBe(true);
    });

    it('should detect tool P95 latency regression', () => {
      const baseline = createMockSnapshot({
        tools: [
          {
            name: 'read_file',
            callCount: 10,
            successRate: 1,
            avgLatencyMs: 100,
            p95LatencyMs: 200,
          },
        ],
      });
      const current = createMockSnapshot({
        tools: [
          {
            name: 'read_file',
            callCount: 10,
            successRate: 1,
            avgLatencyMs: 200,
            p95LatencyMs: 400,
          },
        ],
      });

      const result = manager.compare(current, baseline);
      const toolMetric = result.metrics.find(
        (m) => m.metric === 'tool.read_file.p95LatencyMs',
      );

      expect(toolMetric!.regression).toBe(true);
      expect(toolMetric!.changePercent).toBe(100);
    });

    it('should detect cache hit rate regression', () => {
      const baseline = createMockSnapshot({
        tokenEfficiency: {
          totalInput: 5000,
          totalOutput: 3000,
          totalCached: 2500,
          cacheHitRate: 0.5,
        },
      });
      const current = createMockSnapshot({
        tokenEfficiency: {
          totalInput: 5000,
          totalOutput: 3000,
          totalCached: 1000,
          cacheHitRate: 0.2,
        },
      });

      const result = manager.compare(current, baseline);
      const cacheMetric = result.metrics.find(
        (m) => m.metric === 'tokenEfficiency.cacheHitRate',
      );

      expect(cacheMetric!.regression).toBe(true);
      expect(result.hasRegression).toBe(true);
    });

    it('should report no regression when metrics improve', () => {
      const baseline = createMockSnapshot({
        startup: { totalMs: 2000, phases: [] },
        memory: {
          heapUsedMB: 500,
          heapTotalMB: 1000,
          heapSizeLimitMB: 2048,
          rssMB: 800,
          utilization: 0.25,
        },
        tokenEfficiency: {
          totalInput: 5000,
          totalOutput: 3000,
          totalCached: 1000,
          cacheHitRate: 0.2,
        },
      });
      const current = createMockSnapshot({
        startup: { totalMs: 1500, phases: [] },
        memory: {
          heapUsedMB: 300,
          heapTotalMB: 600,
          heapSizeLimitMB: 2048,
          rssMB: 500,
          utilization: 0.15,
        },
        tokenEfficiency: {
          totalInput: 5000,
          totalOutput: 3000,
          totalCached: 2000,
          cacheHitRate: 0.4,
        },
      });

      const result = manager.compare(current, baseline);
      expect(result.hasRegression).toBe(false);
      expect(result.highestSeverity).toBe('none');
    });

    it('should respect custom thresholds', () => {
      const baseline = createMockSnapshot({
        startup: { totalMs: 1000, phases: [] },
      });
      const current = createMockSnapshot({
        startup: { totalMs: 1500, phases: [] },
      });

      // With default thresholds (0.2), 50% increase is a regression
      const defaultResult = manager.compare(current, baseline);
      expect(defaultResult.hasRegression).toBe(true);

      // With relaxed threshold (0.6), 50% increase is NOT a regression
      const relaxed = manager.compare(current, baseline, {
        startupIncrease: 0.6,
        memoryUtilizationIncrease: 0.3,
        toolLatencyIncrease: 0.5,
        cacheHitRateDecrease: 0.2,
      });
      expect(
        relaxed.metrics.find((m) => m.metric === 'startup.totalMs')!.regression,
      ).toBe(false);
    });

    it('should classify severity correctly', () => {
      const baseline = createMockSnapshot({
        startup: { totalMs: 1000, phases: [] },
      });

      // 35% increase → medium severity (0.25 <= 0.35 < 0.5)
      const medium = manager.compare(
        createMockSnapshot({ startup: { totalMs: 1350, phases: [] } }),
        baseline,
      );
      expect(
        medium.metrics.find((m) => m.metric === 'startup.totalMs')!.severity,
      ).toBe('medium');

      // 60% increase → high severity (0.6 >= 0.5)
      const high = manager.compare(
        createMockSnapshot({ startup: { totalMs: 1600, phases: [] } }),
        baseline,
      );
      expect(
        high.metrics.find((m) => m.metric === 'startup.totalMs')!.severity,
      ).toBe('high');
    });

    it('should skip comparison when baseline value is zero', () => {
      const baseline = createMockSnapshot({
        startup: { totalMs: 0, phases: [] },
        memory: {
          heapUsedMB: 0,
          heapTotalMB: 0,
          heapSizeLimitMB: 0,
          rssMB: 0,
          utilization: 0,
        },
        tokenEfficiency: {
          totalInput: 0,
          totalOutput: 0,
          totalCached: 0,
          cacheHitRate: 0,
        },
      });
      const current = createMockSnapshot();

      const result = manager.compare(current, baseline);
      expect(result.metrics).toHaveLength(0);
      expect(result.hasRegression).toBe(false);
    });

    it('should skip tools not in baseline', () => {
      const baseline = createMockSnapshot({ tools: [] });
      const current = createMockSnapshot({
        tools: [
          {
            name: 'new_tool',
            callCount: 5,
            successRate: 1,
            avgLatencyMs: 100,
            p95LatencyMs: 200,
          },
        ],
      });

      const result = manager.compare(current, baseline);
      const toolMetrics = result.metrics.filter((m) =>
        m.metric.startsWith('tool.'),
      );
      expect(toolMetrics).toHaveLength(0);
    });

    it('should compute highestSeverity across all metrics', () => {
      const baseline = createMockSnapshot({
        startup: { totalMs: 1000, phases: [] },
        tools: [
          {
            name: 'slow_tool',
            callCount: 10,
            successRate: 1,
            avgLatencyMs: 100,
            p95LatencyMs: 200,
          },
        ],
      });
      // Startup: 30% increase (low), tool: 200% increase (high)
      const current = createMockSnapshot({
        startup: { totalMs: 1300, phases: [] },
        tools: [
          {
            name: 'slow_tool',
            callCount: 10,
            successRate: 1,
            avgLatencyMs: 300,
            p95LatencyMs: 600,
          },
        ],
      });

      const result = manager.compare(current, baseline);
      expect(result.highestSeverity).toBe('high');
    });
  });

  describe('getExitCode', () => {
    it('should return 0 when no regression', () => {
      const result: ComparisonResult = {
        timestamp: Date.now(),
        baselineTimestamp: Date.now() - 86400000,
        metrics: [],
        hasRegression: false,
        highestSeverity: 'none',
      };
      expect(manager.getExitCode(result)).toBe(0);
    });

    it('should return 1 when regression detected', () => {
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
        ],
        hasRegression: true,
        highestSeverity: 'high',
      };
      expect(manager.getExitCode(result)).toBe(1);
    });
  });
});
