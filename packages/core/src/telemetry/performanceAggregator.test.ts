/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { performance } from 'node:perf_hooks';
import { PerformanceAggregator } from './performanceAggregator.js';
import type { SessionMetrics } from './uiTelemetry.js';
import { ToolCallDecision } from './tool-call-decision.js';

vi.mock('node:v8', () => ({
  default: {
    getHeapStatistics: vi.fn(() => ({
      heap_size_limit: 2 * 1024 * 1024 * 1024, // 2GB
    })),
  },
}));

function createEmptyDecisions() {
  return {
    [ToolCallDecision.ACCEPT]: 0,
    [ToolCallDecision.REJECT]: 0,
    [ToolCallDecision.MODIFY]: 0,
    [ToolCallDecision.AUTO_ACCEPT]: 0,
  };
}

function createMockSessionMetrics(
  overrides?: Partial<SessionMetrics>,
): SessionMetrics {
  return {
    models: {},
    tools: {
      totalCalls: 0,
      totalSuccess: 0,
      totalFail: 0,
      totalDurationMs: 0,
      totalDecisions: createEmptyDecisions(),
      byName: {},
    },
    files: {
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
    },
    ...overrides,
  };
}

describe('PerformanceAggregator', () => {
  let aggregator: PerformanceAggregator;

  beforeEach(() => {
    vi.resetAllMocks();
    aggregator = new PerformanceAggregator();
    performance.clearMarks();
    performance.clearMeasures();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('computePercentile', () => {
    it('should return 0 for empty array', () => {
      expect(aggregator.computePercentile([], 95)).toBe(0);
    });

    it('should return the single value for array of length 1', () => {
      expect(aggregator.computePercentile([42], 95)).toBe(42);
    });

    it('should compute P95 correctly for 100 values', () => {
      const values = Array.from({ length: 100 }, (_, i) => i + 1);
      expect(aggregator.computePercentile(values, 95)).toBe(95);
    });

    it('should compute P50 (median) correctly', () => {
      expect(aggregator.computePercentile([1, 2, 3, 4, 5], 50)).toBe(3);
    });

    it('should handle unsorted input', () => {
      const values = [50, 10, 90, 30, 70];
      expect(aggregator.computePercentile(values, 50)).toBe(50);
    });

    it('should compute P99 for large datasets', () => {
      const values = Array.from({ length: 1000 }, (_, i) => i + 1);
      expect(aggregator.computePercentile(values, 99)).toBe(990);
    });

    it('should not mutate the original array', () => {
      const values = [50, 10, 90, 30, 70];
      const copy = [...values];
      aggregator.computePercentile(values, 95);
      expect(values).toEqual(copy);
    });

    it('should handle duplicate values', () => {
      const values = [100, 100, 100, 100, 200];
      expect(aggregator.computePercentile(values, 50)).toBe(100);
      expect(aggregator.computePercentile(values, 95)).toBe(200);
    });
  });

  describe('recordToolLatency', () => {
    it('should store latencies and use them for P95', () => {
      aggregator.recordToolLatency('read_file', 100);
      aggregator.recordToolLatency('read_file', 200);
      aggregator.recordToolLatency('read_file', 300);

      const metrics = createMockSessionMetrics({
        tools: {
          totalCalls: 3,
          totalSuccess: 3,
          totalFail: 0,
          totalDurationMs: 600,
          totalDecisions: createEmptyDecisions(),
          byName: {
            read_file: {
              count: 3,
              success: 3,
              fail: 0,
              durationMs: 600,
              decisions: createEmptyDecisions(),
            },
          },
        },
      });

      const result = aggregator.getToolPerformance(metrics);
      expect(result[0].p95LatencyMs).toBe(300);
    });

    it('should evict oldest entries when buffer exceeds max size', () => {
      const small = new PerformanceAggregator(5);
      for (let i = 1; i <= 7; i++) {
        small.recordToolLatency('tool', i * 100);
      }

      const metrics = createMockSessionMetrics({
        tools: {
          totalCalls: 7,
          totalSuccess: 7,
          totalFail: 0,
          totalDurationMs: 2800,
          totalDecisions: createEmptyDecisions(),
          byName: {
            tool: {
              count: 7,
              success: 7,
              fail: 0,
              durationMs: 2800,
              decisions: createEmptyDecisions(),
            },
          },
        },
      });

      // Buffer should contain [300, 400, 500, 600, 700]
      const result = small.getToolPerformance(metrics);
      expect(result[0].p95LatencyMs).toBe(700);
    });
  });

  describe('getStartupBreakdown', () => {
    it('should return empty phases when no measures exist', () => {
      const result = aggregator.getStartupBreakdown();
      expect(result.totalMs).toBe(0);
      expect(result.phases).toHaveLength(0);
    });

    it('should read phases from performance API', () => {
      performance.mark('test-start');
      performance.mark('test-end');
      performance.measure('cli_startup', 'test-start', 'test-end');

      const result = aggregator.getStartupBreakdown();
      expect(result.phases).toHaveLength(1);
      expect(result.phases[0].name).toBe('cli_startup');
      expect(result.phases[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should filter by phase names when provided', () => {
      performance.mark('a-start');
      performance.mark('a-end');
      performance.measure('phase_a', 'a-start', 'a-end');

      performance.mark('b-start');
      performance.mark('b-end');
      performance.measure('phase_b', 'b-start', 'b-end');

      const result = aggregator.getStartupBreakdown(['phase_a']);
      expect(result.phases).toHaveLength(1);
      expect(result.phases[0].name).toBe('phase_a');
    });

    it('should sum durations for totalMs', () => {
      performance.mark('s1');
      performance.mark('e1');
      performance.measure('p1', 's1', 'e1');

      performance.mark('s2');
      performance.mark('e2');
      performance.measure('p2', 's2', 'e2');

      const result = aggregator.getStartupBreakdown();
      expect(result.totalMs).toBe(
        result.phases[0].durationMs + result.phases[1].durationMs,
      );
    });
  });

  describe('getMemoryStatus', () => {
    it('should return memory status with utilization ratio', () => {
      vi.spyOn(process, 'memoryUsage').mockReturnValue({
        heapUsed: 500 * 1024 * 1024,
        heapTotal: 1024 * 1024 * 1024,
        rss: 800 * 1024 * 1024,
        external: 50 * 1024 * 1024,
        arrayBuffers: 10 * 1024 * 1024,
      });

      const status = aggregator.getMemoryStatus();
      expect(status.heapUsedMB).toBe(500);
      expect(status.heapTotalMB).toBe(1024);
      expect(status.rssMB).toBe(800);
      expect(status.heapSizeLimitMB).toBeCloseTo(2048, 0);
      // 500 / 2048 ≈ 0.244
      expect(status.utilization).toBeCloseTo(0.244, 2);
    });

    it('should handle zero heap size limit', async () => {
      vi.spyOn(process, 'memoryUsage').mockReturnValue({
        heapUsed: 100 * 1024 * 1024,
        heapTotal: 200 * 1024 * 1024,
        rss: 300 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 5 * 1024 * 1024,
      });

      const v8 = await import('node:v8');
      vi.mocked(v8.default.getHeapStatistics).mockReturnValue({
        heap_size_limit: 0,
      } as ReturnType<typeof v8.default.getHeapStatistics>);

      const status = aggregator.getMemoryStatus();
      expect(status.utilization).toBe(0);
    });
  });

  describe('getToolPerformance', () => {
    it('should return empty array when no tools used', () => {
      const metrics = createMockSessionMetrics();
      expect(aggregator.getToolPerformance(metrics)).toHaveLength(0);
    });

    it('should compute success rate and average latency', () => {
      const metrics = createMockSessionMetrics({
        tools: {
          totalCalls: 10,
          totalSuccess: 8,
          totalFail: 2,
          totalDurationMs: 5000,
          totalDecisions: createEmptyDecisions(),
          byName: {
            read_file: {
              count: 10,
              success: 8,
              fail: 2,
              durationMs: 5000,
              decisions: createEmptyDecisions(),
            },
          },
        },
      });

      const result = aggregator.getToolPerformance(metrics);
      expect(result).toHaveLength(1);
      expect(result[0].successRate).toBe(0.8);
      expect(result[0].avgLatencyMs).toBe(500);
    });

    it('should fall back to avg latency when no buffer exists', () => {
      const metrics = createMockSessionMetrics({
        tools: {
          totalCalls: 5,
          totalSuccess: 5,
          totalFail: 0,
          totalDurationMs: 1000,
          totalDecisions: createEmptyDecisions(),
          byName: {
            shell: {
              count: 5,
              success: 5,
              fail: 0,
              durationMs: 1000,
              decisions: createEmptyDecisions(),
            },
          },
        },
      });

      const result = aggregator.getToolPerformance(metrics);
      expect(result[0].p95LatencyMs).toBe(200); // avg = 1000/5
    });

    it('should handle zero call count gracefully', () => {
      const metrics = createMockSessionMetrics({
        tools: {
          totalCalls: 0,
          totalSuccess: 0,
          totalFail: 0,
          totalDurationMs: 0,
          totalDecisions: createEmptyDecisions(),
          byName: {
            empty_tool: {
              count: 0,
              success: 0,
              fail: 0,
              durationMs: 0,
              decisions: createEmptyDecisions(),
            },
          },
        },
      });

      const result = aggregator.getToolPerformance(metrics);
      expect(result[0].successRate).toBe(0);
      expect(result[0].avgLatencyMs).toBe(0);
    });
  });

  describe('getModelPerformance', () => {
    it('should compute model metrics from session data', () => {
      const metrics = createMockSessionMetrics({
        models: {
          'gemini-2.0-flash': {
            api: {
              totalRequests: 20,
              totalErrors: 2,
              totalLatencyMs: 10000,
            },
            tokens: {
              input: 5000,
              prompt: 4000,
              candidates: 3000,
              total: 8000,
              cached: 1500,
              thoughts: 200,
              tool: 100,
            },
            roles: {},
          },
        },
      });

      const result = aggregator.getModelPerformance(metrics);
      expect(result).toHaveLength(1);
      expect(result[0].model).toBe('gemini-2.0-flash');
      expect(result[0].errorRate).toBe(0.1);
      expect(result[0].avgLatencyMs).toBe(500);
      expect(result[0].cacheHitRate).toBe(0.3);
    });

    it('should handle zero requests gracefully', () => {
      const metrics = createMockSessionMetrics({
        models: {
          'empty-model': {
            api: { totalRequests: 0, totalErrors: 0, totalLatencyMs: 0 },
            tokens: {
              input: 0,
              prompt: 0,
              candidates: 0,
              total: 0,
              cached: 0,
              thoughts: 0,
              tool: 0,
            },
            roles: {},
          },
        },
      });

      const result = aggregator.getModelPerformance(metrics);
      expect(result[0].errorRate).toBe(0);
      expect(result[0].avgLatencyMs).toBe(0);
      expect(result[0].cacheHitRate).toBe(0);
    });

    it('should handle multiple models', () => {
      const metrics = createMockSessionMetrics({
        models: {
          'model-a': {
            api: { totalRequests: 10, totalErrors: 0, totalLatencyMs: 5000 },
            tokens: {
              input: 3000,
              prompt: 2000,
              candidates: 2000,
              total: 5000,
              cached: 900,
              thoughts: 0,
              tool: 0,
            },
            roles: {},
          },
          'model-b': {
            api: { totalRequests: 5, totalErrors: 1, totalLatencyMs: 2500 },
            tokens: {
              input: 1000,
              prompt: 800,
              candidates: 500,
              total: 1500,
              cached: 100,
              thoughts: 0,
              tool: 0,
            },
            roles: {},
          },
        },
      });

      const result = aggregator.getModelPerformance(metrics);
      expect(result).toHaveLength(2);

      const modelA = result.find((m) => m.model === 'model-a')!;
      expect(modelA.cacheHitRate).toBe(0.3);

      const modelB = result.find((m) => m.model === 'model-b')!;
      expect(modelB.errorRate).toBe(0.2);
    });
  });

  describe('getTokenEfficiency', () => {
    it('should aggregate tokens across all models', () => {
      const metrics = createMockSessionMetrics({
        models: {
          'model-a': {
            api: { totalRequests: 10, totalErrors: 0, totalLatencyMs: 5000 },
            tokens: {
              input: 3000,
              prompt: 2000,
              candidates: 2000,
              total: 5000,
              cached: 1000,
              thoughts: 0,
              tool: 0,
            },
            roles: {},
          },
          'model-b': {
            api: { totalRequests: 5, totalErrors: 0, totalLatencyMs: 2000 },
            tokens: {
              input: 2000,
              prompt: 1500,
              candidates: 1000,
              total: 3000,
              cached: 500,
              thoughts: 0,
              tool: 0,
            },
            roles: {},
          },
        },
      });

      const result = aggregator.getTokenEfficiency(metrics);
      expect(result.totalInput).toBe(5000);
      expect(result.totalOutput).toBe(3000);
      expect(result.totalCached).toBe(1500);
      expect(result.cacheHitRate).toBe(0.3);
    });

    it('should return zero cache hit rate when no input tokens', () => {
      const metrics = createMockSessionMetrics();
      const result = aggregator.getTokenEfficiency(metrics);
      expect(result.cacheHitRate).toBe(0);
    });
  });

  describe('createSnapshot', () => {
    it('should create a complete snapshot', () => {
      vi.spyOn(process, 'memoryUsage').mockReturnValue({
        heapUsed: 100 * 1024 * 1024,
        heapTotal: 200 * 1024 * 1024,
        rss: 300 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 5 * 1024 * 1024,
      });

      const metrics = createMockSessionMetrics();
      const snapshot = aggregator.createSnapshot(metrics);

      expect(snapshot.timestamp).toBeGreaterThan(0);
      expect(snapshot.startup).toBeDefined();
      expect(snapshot.memory).toBeDefined();
      expect(snapshot.tools).toEqual([]);
      expect(snapshot.models).toEqual([]);
      expect(snapshot.tokenEfficiency.cacheHitRate).toBe(0);
    });

    it('should accept injected startup data', () => {
      vi.spyOn(process, 'memoryUsage').mockReturnValue({
        heapUsed: 100 * 1024 * 1024,
        heapTotal: 200 * 1024 * 1024,
        rss: 300 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 5 * 1024 * 1024,
      });

      const startupData = {
        totalMs: 2500,
        phases: [
          { name: 'cli_startup', durationMs: 1500 },
          { name: 'load_settings', durationMs: 1000 },
        ],
      };

      const snapshot = aggregator.createSnapshot(createMockSessionMetrics(), {
        startupData,
      });

      expect(snapshot.startup.totalMs).toBe(2500);
      expect(snapshot.startup.phases).toHaveLength(2);
    });
  });

  describe('reset', () => {
    it('should clear all latency buffers', () => {
      aggregator.recordToolLatency('tool_a', 100);
      aggregator.recordToolLatency('tool_b', 200);
      aggregator.reset();

      const metrics = createMockSessionMetrics({
        tools: {
          totalCalls: 1,
          totalSuccess: 1,
          totalFail: 0,
          totalDurationMs: 100,
          totalDecisions: createEmptyDecisions(),
          byName: {
            tool_a: {
              count: 1,
              success: 1,
              fail: 0,
              durationMs: 100,
              decisions: createEmptyDecisions(),
            },
          },
        },
      });

      const result = aggregator.getToolPerformance(metrics);
      // After reset, no buffer data — P95 falls back to avg
      expect(result[0].p95LatencyMs).toBe(result[0].avgLatencyMs);
    });
  });
});
