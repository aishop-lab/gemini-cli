/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';
import v8 from 'node:v8';
import { bytesToMB } from '../utils/formatters.js';
import type { SessionMetrics } from './uiTelemetry.js';

/**
 * Startup phase timing from the performance API.
 */
export interface StartupPhaseInfo {
  name: string;
  durationMs: number;
}

/**
 * Memory status derived from heap statistics.
 * Addresses #20550: heap exhaustion crashes at 4GB+ with no prior warning.
 */
export interface MemoryStatus {
  heapUsedMB: number;
  heapTotalMB: number;
  heapSizeLimitMB: number;
  rssMB: number;
  utilization: number;
}

/**
 * Per-tool performance summary including P95 latency.
 */
export interface ToolPerformanceSummary {
  name: string;
  callCount: number;
  successRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

/**
 * Per-model API performance summary with token efficiency.
 */
export interface ModelPerformanceSummary {
  model: string;
  totalRequests: number;
  errorRate: number;
  avgLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheHitRate: number;
}

/**
 * Unified performance snapshot combining all metrics from existing
 * telemetry services (StartupProfiler, MemoryMonitor, UiTelemetryService).
 */
export interface PerformanceSnapshot {
  timestamp: number;
  startup: {
    totalMs: number;
    phases: StartupPhaseInfo[];
  };
  memory: MemoryStatus;
  tools: ToolPerformanceSummary[];
  models: ModelPerformanceSummary[];
  tokenEfficiency: {
    totalInput: number;
    totalOutput: number;
    totalCached: number;
    cacheHitRate: number;
  };
}

/**
 * Aggregates performance data from existing telemetry services into
 * unified snapshots suitable for display, export, and baseline comparison.
 *
 * Maintains rolling latency buffers for percentile computation (P95/P99)
 * since UiTelemetryService only stores aggregate totals.
 */
export class PerformanceAggregator {
  private toolLatencyBuffers: Map<string, number[]> = new Map();
  private readonly maxBufferSize: number;

  constructor(maxBufferSize: number = 1000) {
    this.maxBufferSize = maxBufferSize;
  }

  /**
   * Records an individual tool call latency for percentile computation.
   * Should be called for each tool execution to build the latency buffer.
   */
  recordToolLatency(toolName: string, durationMs: number): void {
    let buffer = this.toolLatencyBuffers.get(toolName);
    if (!buffer) {
      buffer = [];
      this.toolLatencyBuffers.set(toolName, buffer);
    }
    buffer.push(durationMs);
    if (buffer.length > this.maxBufferSize) {
      buffer.shift();
    }
  }

  /**
   * Computes the given percentile of a set of values.
   * Uses the nearest-rank method: P95 of [1..100] = 95.
   */
  computePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Reads startup phase measures from the Node.js performance API.
   * Must be called before StartupProfiler.flush() clears the measures.
   * Alternatively, pass pre-captured startup data to createSnapshot().
   */
  getStartupBreakdown(phaseNames?: string[]): {
    totalMs: number;
    phases: StartupPhaseInfo[];
  } {
    const measures = performance.getEntriesByType('measure');
    const phases: StartupPhaseInfo[] = [];
    let totalMs = 0;

    for (const measure of measures) {
      if (phaseNames && !phaseNames.includes(measure.name)) continue;
      phases.push({ name: measure.name, durationMs: measure.duration });
      totalMs += measure.duration;
    }

    return { totalMs, phases };
  }

  /**
   * Builds memory status from process.memoryUsage() and v8 heap statistics.
   */
  getMemoryStatus(): MemoryStatus {
    const mem = process.memoryUsage();
    const heapSizeLimit = v8.getHeapStatistics().heap_size_limit;
    const heapUsedMB = bytesToMB(mem.heapUsed);
    const heapSizeLimitMB = bytesToMB(heapSizeLimit);

    return {
      heapUsedMB,
      heapTotalMB: bytesToMB(mem.heapTotal),
      heapSizeLimitMB,
      rssMB: bytesToMB(mem.rss),
      utilization: heapSizeLimitMB > 0 ? heapUsedMB / heapSizeLimitMB : 0,
    };
  }

  /**
   * Derives per-tool performance summaries from session metrics.
   * Uses latency buffers for P95; falls back to average if no buffer data.
   */
  getToolPerformance(sessionMetrics: SessionMetrics): ToolPerformanceSummary[] {
    const tools: ToolPerformanceSummary[] = [];

    for (const [name, stats] of Object.entries(sessionMetrics.tools.byName)) {
      const buffer = this.toolLatencyBuffers.get(name) || [];
      const avgLatencyMs = stats.count > 0 ? stats.durationMs / stats.count : 0;
      const p95LatencyMs = this.computePercentile(buffer, 95);

      tools.push({
        name,
        callCount: stats.count,
        successRate: stats.count > 0 ? stats.success / stats.count : 0,
        avgLatencyMs,
        p95LatencyMs: buffer.length > 0 ? p95LatencyMs : avgLatencyMs,
      });
    }

    return tools;
  }

  /**
   * Derives per-model API performance summaries from session metrics.
   * Computes cache hit rate from input vs cached token counts.
   */
  getModelPerformance(
    sessionMetrics: SessionMetrics,
  ): ModelPerformanceSummary[] {
    const models: ModelPerformanceSummary[] = [];

    for (const [model, metrics] of Object.entries(sessionMetrics.models)) {
      const totalReqs = metrics.api.totalRequests;

      models.push({
        model,
        totalRequests: totalReqs,
        errorRate: totalReqs > 0 ? metrics.api.totalErrors / totalReqs : 0,
        avgLatencyMs:
          totalReqs > 0 ? metrics.api.totalLatencyMs / totalReqs : 0,
        inputTokens: metrics.tokens.input,
        outputTokens: metrics.tokens.candidates,
        cachedTokens: metrics.tokens.cached,
        cacheHitRate:
          metrics.tokens.input > 0
            ? metrics.tokens.cached / metrics.tokens.input
            : 0,
      });
    }

    return models;
  }

  /**
   * Computes aggregate token efficiency across all models.
   */
  getTokenEfficiency(sessionMetrics: SessionMetrics): {
    totalInput: number;
    totalOutput: number;
    totalCached: number;
    cacheHitRate: number;
  } {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCached = 0;

    for (const metrics of Object.values(sessionMetrics.models)) {
      totalInput += metrics.tokens.input;
      totalOutput += metrics.tokens.candidates;
      totalCached += metrics.tokens.cached;
    }

    return {
      totalInput,
      totalOutput,
      totalCached,
      cacheHitRate: totalInput > 0 ? totalCached / totalInput : 0,
    };
  }

  /**
   * Creates a complete performance snapshot from session metrics.
   *
   * @param sessionMetrics - Current session metrics from UiTelemetryService
   * @param options.startupData - Pre-captured startup data (use if StartupProfiler already flushed)
   * @param options.phaseNames - Filter startup phases by name
   */
  createSnapshot(
    sessionMetrics: SessionMetrics,
    options?: {
      startupData?: { totalMs: number; phases: StartupPhaseInfo[] };
      phaseNames?: string[];
    },
  ): PerformanceSnapshot {
    return {
      timestamp: Date.now(),
      startup:
        options?.startupData ?? this.getStartupBreakdown(options?.phaseNames),
      memory: this.getMemoryStatus(),
      tools: this.getToolPerformance(sessionMetrics),
      models: this.getModelPerformance(sessionMetrics),
      tokenEfficiency: this.getTokenEfficiency(sessionMetrics),
    };
  }

  /**
   * Clears all latency buffers.
   */
  reset(): void {
    this.toolLatencyBuffers.clear();
  }
}
