/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PerformanceSnapshot } from './performanceAggregator.js';

function isPerformanceSnapshot(value: unknown): value is PerformanceSnapshot {
  if (value === null || typeof value !== 'object') return false;
  return (
    'timestamp' in value &&
    typeof value.timestamp === 'number' &&
    'startup' in value &&
    typeof value.startup === 'object' &&
    value.startup !== null &&
    'memory' in value &&
    typeof value.memory === 'object' &&
    value.memory !== null &&
    'tools' in value &&
    Array.isArray(value.tools) &&
    'models' in value &&
    Array.isArray(value.models) &&
    'tokenEfficiency' in value &&
    typeof value.tokenEfficiency === 'object' &&
    value.tokenEfficiency !== null
  );
}

/**
 * Configurable thresholds for regression detection.
 * Ratios represent fractional change (0.2 = 20% increase).
 */
export interface RegressionThresholds {
  /** Max allowed startup time increase as a ratio (0.2 = 20%). */
  startupIncrease: number;
  /** Max allowed memory utilization increase as absolute delta (0.15 = 15%). */
  memoryUtilizationIncrease: number;
  /** Max allowed tool P95 latency increase as a ratio (0.25 = 25%). */
  toolLatencyIncrease: number;
  /** Max allowed cache hit rate decrease as absolute delta (0.1 = 10%). */
  cacheHitRateDecrease: number;
}

/**
 * Comparison result for a single metric.
 */
export interface MetricComparison {
  metric: string;
  baseline: number;
  current: number;
  changePercent: number;
  regression: boolean;
  severity: 'none' | 'low' | 'medium' | 'high';
}

/**
 * Overall comparison result suitable for CI output.
 */
export interface ComparisonResult {
  timestamp: number;
  baselineTimestamp: number;
  metrics: MetricComparison[];
  hasRegression: boolean;
  highestSeverity: 'none' | 'low' | 'medium' | 'high';
}

const DEFAULT_THRESHOLDS: RegressionThresholds = {
  startupIncrease: 0.2,
  memoryUtilizationIncrease: 0.15,
  toolLatencyIncrease: 0.25,
  cacheHitRateDecrease: 0.1,
};

const SEVERITY_ORDER: Record<string, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

function classifySeverity(
  changeRatio: number,
): 'none' | 'low' | 'medium' | 'high' {
  const abs = Math.abs(changeRatio);
  if (abs < 0.1) return 'none';
  if (abs < 0.25) return 'low';
  if (abs < 0.5) return 'medium';
  return 'high';
}

/**
 * Manages performance baselines for CI regression detection.
 *
 * Saves performance snapshots as JSON files that can be committed to the
 * repository, then compares future runs against the baseline to detect
 * regressions. Designed for use in CI pipelines where a non-zero exit
 * code signals a performance regression.
 *
 * Implements the REGRESSION_DETECTION and BASELINE_COMPARISON metric
 * categories defined in metrics.ts (lines 68-71).
 */
export class BaselineManager {
  /**
   * Saves a performance snapshot as a JSON baseline file.
   */
  async saveBaseline(
    snapshot: PerformanceSnapshot,
    filePath: string,
  ): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
  }

  /**
   * Loads a previously saved baseline. Returns null if file doesn't exist.
   */
  async loadBaseline(filePath: string): Promise<PerformanceSnapshot | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      return isPerformanceSnapshot(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Compares a current snapshot against a baseline and detects regressions.
   *
   * Checks four dimensions:
   * 1. Startup time (increase = regression)
   * 2. Memory utilization (increase = regression)
   * 3. Per-tool P95 latency (increase = regression)
   * 4. Cache hit rate (decrease = regression)
   */
  compare(
    current: PerformanceSnapshot,
    baseline: PerformanceSnapshot,
    thresholds: RegressionThresholds = DEFAULT_THRESHOLDS,
  ): ComparisonResult {
    const metrics: MetricComparison[] = [];

    // 1. Startup time
    if (baseline.startup.totalMs > 0) {
      const change =
        (current.startup.totalMs - baseline.startup.totalMs) /
        baseline.startup.totalMs;
      const regression = change > thresholds.startupIncrease;
      metrics.push({
        metric: 'startup.totalMs',
        baseline: baseline.startup.totalMs,
        current: current.startup.totalMs,
        changePercent: change * 100,
        regression,
        severity: regression ? classifySeverity(change) : 'none',
      });
    }

    // 2. Memory utilization
    if (baseline.memory.utilization > 0) {
      const absoluteChange =
        current.memory.utilization - baseline.memory.utilization;
      const changePercent = absoluteChange / baseline.memory.utilization;
      const regression = absoluteChange > thresholds.memoryUtilizationIncrease;
      metrics.push({
        metric: 'memory.utilization',
        baseline: baseline.memory.utilization,
        current: current.memory.utilization,
        changePercent: changePercent * 100,
        regression,
        severity: regression ? classifySeverity(changePercent) : 'none',
      });
    }

    // 3. Per-tool P95 latency
    for (const currentTool of current.tools) {
      const baselineTool = baseline.tools.find(
        (t) => t.name === currentTool.name,
      );
      if (!baselineTool || baselineTool.p95LatencyMs === 0) continue;

      const change =
        (currentTool.p95LatencyMs - baselineTool.p95LatencyMs) /
        baselineTool.p95LatencyMs;
      const regression = change > thresholds.toolLatencyIncrease;
      metrics.push({
        metric: `tool.${currentTool.name}.p95LatencyMs`,
        baseline: baselineTool.p95LatencyMs,
        current: currentTool.p95LatencyMs,
        changePercent: change * 100,
        regression,
        severity: regression ? classifySeverity(change) : 'none',
      });
    }

    // 4. Cache hit rate (decrease = regression)
    if (baseline.tokenEfficiency.cacheHitRate > 0) {
      const decrease =
        baseline.tokenEfficiency.cacheHitRate -
        current.tokenEfficiency.cacheHitRate;
      const changePercent = -decrease / baseline.tokenEfficiency.cacheHitRate;
      const regression = decrease > thresholds.cacheHitRateDecrease;
      metrics.push({
        metric: 'tokenEfficiency.cacheHitRate',
        baseline: baseline.tokenEfficiency.cacheHitRate,
        current: current.tokenEfficiency.cacheHitRate,
        changePercent: changePercent * 100,
        regression,
        severity: regression
          ? classifySeverity(decrease / baseline.tokenEfficiency.cacheHitRate)
          : 'none',
      });
    }

    const hasRegression = metrics.some((m) => m.regression);
    const highestSeverity = metrics.reduce<'none' | 'low' | 'medium' | 'high'>(
      (max, m) =>
        SEVERITY_ORDER[m.severity] > SEVERITY_ORDER[max] ? m.severity : max,
      'none',
    );

    return {
      timestamp: current.timestamp,
      baselineTimestamp: baseline.timestamp,
      metrics,
      hasRegression,
      highestSeverity,
    };
  }

  /**
   * Returns a CI-friendly exit code: 0 = no regression, 1 = regression detected.
   */
  getExitCode(result: ComparisonResult): number {
    return result.hasRegression ? 1 : 0;
  }
}
