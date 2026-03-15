/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests proving the PerformanceAggregator pipeline works
 * with real Gemini CLI telemetry types. These tests simulate the actual
 * data flow: StartupProfiler phases → UiTelemetryService events →
 * PerformanceAggregator → SuggestionEngine → ReportFormatter.
 *
 * No mocks for the telemetry types — uses real UiTelemetryService,
 * real performance.mark/measure, and real ToolCallEvent objects.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { PerformanceAggregator } from './performanceAggregator.js';
import { UiTelemetryService } from './uiTelemetry.js';
import { SuggestionEngine } from './suggestionEngine.js';
import { BaselineManager } from './baselineManager.js';
import {
  formatSnapshotText,
  formatSnapshotMarkdown,
  formatSnapshotJSON,
  formatComparisonText,
  formatSuggestionsText,
} from './reportFormatter.js';
import { ToolCallDecision } from './tool-call-decision.js';
import { EVENT_TOOL_CALL, EVENT_API_RESPONSE } from './types.js';
import type { UiEvent } from './uiTelemetry.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('node:v8', () => ({
  default: {
    getHeapStatistics: vi.fn(() => ({
      heap_size_limit: 2 * 1024 * 1024 * 1024, // 2GB
    })),
  },
}));

/**
 * Creates performance marks and measures that mirror what StartupProfiler
 * produces during a real Gemini CLI startup.
 */
function simulateStartupPhases(): void {
  // These phase names match the real StartupProfiler calls in gemini.tsx
  const phases = [
    { name: 'cli_startup', durationMs: 150 },
    { name: 'load_settings', durationMs: 45 },
    { name: 'parse_arguments', durationMs: 12 },
    { name: 'load_cli_config', durationMs: 320 },
    { name: 'initialize_app', durationMs: 890 },
    { name: 'authenticate', durationMs: 230 },
    { name: 'load_builtin_commands', durationMs: 35 },
    { name: 'discover_tools', durationMs: 410 },
  ];

  for (const phase of phases) {
    const startMark = `startup:${phase.name}:start`;
    const endMark = `startup:${phase.name}:end`;
    performance.mark(startMark);
    performance.mark(endMark, {
      startTime:
        performance.getEntriesByName(startMark)[0].startTime + phase.durationMs,
    });
    performance.measure(phase.name, startMark, endMark);
  }
}

/**
 * Clears all performance marks and measures created by simulateStartupPhases.
 */
function clearStartupPhases(): void {
  const phases = [
    'cli_startup',
    'load_settings',
    'parse_arguments',
    'load_cli_config',
    'initialize_app',
    'authenticate',
    'load_builtin_commands',
    'discover_tools',
  ];
  for (const name of phases) {
    performance.clearMarks(`startup:${name}:start`);
    performance.clearMarks(`startup:${name}:end`);
    performance.clearMeasures(name);
  }
}

/**
 * Feeds tool call events into a UiTelemetryService instance, matching
 * the real event shape from loggers.ts logToolCall().
 */
function simulateToolCalls(
  service: UiTelemetryService,
  aggregator: PerformanceAggregator,
): void {
  const toolCalls = [
    { name: 'read_file', durationMs: 120, success: true },
    { name: 'read_file', durationMs: 95, success: true },
    { name: 'read_file', durationMs: 210, success: true },
    { name: 'read_file', durationMs: 180, success: true },
    { name: 'read_file', durationMs: 6500, success: true }, // slow outlier
    { name: 'write_file', durationMs: 340, success: true },
    { name: 'write_file', durationMs: 290, success: true },
    { name: 'write_file', durationMs: 310, success: false },
    { name: 'shell', durationMs: 1200, success: true },
    { name: 'shell', durationMs: 8500, success: true }, // slow shell command
    { name: 'shell', durationMs: 950, success: true },
  ];

  for (const call of toolCalls) {
    const event = {
      'event.name': EVENT_TOOL_CALL,
      'event.timestamp': new Date().toISOString(),
      function_name: call.name,
      function_args: {},
      duration_ms: call.durationMs,
      success: call.success,
      decision: ToolCallDecision.AUTO_ACCEPT,
      prompt_id: 'test-prompt-1',
      tool_type: 'native' as const,
    } as UiEvent;

    service.addEvent(event);
    // This is the wiring added in loggers.ts
    aggregator.recordToolLatency(call.name, call.durationMs);
  }
}

/**
 * Feeds API response events into a UiTelemetryService instance, matching
 * the real event shape from loggers.ts logApiResponse().
 */
function simulateApiResponses(service: UiTelemetryService): void {
  const responses = [
    {
      model: 'gemini-2.5-pro',
      durationMs: 2400,
      inputTokens: 1500,
      outputTokens: 800,
      cachedTokens: 900,
    },
    {
      model: 'gemini-2.5-pro',
      durationMs: 1800,
      inputTokens: 2200,
      outputTokens: 1200,
      cachedTokens: 1800,
    },
    {
      model: 'gemini-2.5-pro',
      durationMs: 3100,
      inputTokens: 3000,
      outputTokens: 500,
      cachedTokens: 2100,
    },
    {
      model: 'gemini-2.5-flash',
      durationMs: 450,
      inputTokens: 500,
      outputTokens: 200,
      cachedTokens: 0,
    },
  ];

  for (const resp of responses) {
    const event = {
      'event.name': EVENT_API_RESPONSE,
      'event.timestamp': new Date().toISOString(),
      model: resp.model,
      duration_ms: resp.durationMs,
      status_code: 200,
      prompt: {},
      response: {},
      finish_reasons: [],
      usage: {
        input_token_count: resp.inputTokens,
        output_token_count: resp.outputTokens,
        total_token_count: resp.inputTokens + resp.outputTokens,
        cached_content_token_count: resp.cachedTokens,
        thoughts_token_count: 0,
        tool_token_count: 0,
      },
    } as UiEvent;

    service.addEvent(event);
  }
}

describe('Performance pipeline integration', () => {
  let aggregator: PerformanceAggregator;
  let telemetryService: UiTelemetryService;

  beforeEach(() => {
    aggregator = new PerformanceAggregator();
    telemetryService = new UiTelemetryService();
  });

  afterEach(() => {
    clearStartupPhases();
  });

  it('captures startup phases before flush clears them', () => {
    simulateStartupPhases();

    // This is what gemini.tsx does: capture before flush
    const startup = aggregator.captureStartup();

    // Simulate flush clearing the performance entries
    clearStartupPhases();

    // Verify phases were captured
    expect(startup.phases.length).toBe(8);
    expect(startup.phases.map((p) => p.name)).toEqual([
      'cli_startup',
      'load_settings',
      'parse_arguments',
      'load_cli_config',
      'initialize_app',
      'authenticate',
      'load_builtin_commands',
      'discover_tools',
    ]);
    expect(startup.totalMs).toBeGreaterThan(0);

    // Verify createSnapshot uses cached startup data even after flush
    const snapshot = aggregator.createSnapshot(telemetryService.getMetrics());
    expect(snapshot.startup.phases.length).toBe(8);
    expect(snapshot.startup.totalMs).toBe(startup.totalMs);
  });

  it('records per-tool latency for P95 computation via the loggers.ts hook', () => {
    simulateToolCalls(telemetryService, aggregator);
    const metrics = telemetryService.getMetrics();

    // Verify UiTelemetryService has aggregate data
    expect(metrics.tools.totalCalls).toBe(11);
    expect(metrics.tools.totalSuccess).toBe(10);
    expect(metrics.tools.totalFail).toBe(1);
    expect(Object.keys(metrics.tools.byName)).toEqual([
      'read_file',
      'write_file',
      'shell',
    ]);

    // Verify aggregator computed P95 from individual latencies (not averages)
    const toolPerf = aggregator.getToolPerformance(metrics);
    const readFile = toolPerf.find((t) => t.name === 'read_file')!;
    expect(readFile.callCount).toBe(5);
    expect(readFile.p95LatencyMs).toBe(6500); // P95 catches the slow outlier
    expect(readFile.avgLatencyMs).toBeCloseTo(1421, 0); // (120+95+210+180+6500)/5

    const shell = toolPerf.find((t) => t.name === 'shell')!;
    expect(shell.p95LatencyMs).toBe(8500); // P95 catches the slow shell command
  });

  it('creates a complete snapshot from real UiTelemetryService data', () => {
    simulateStartupPhases();
    aggregator.captureStartup();
    clearStartupPhases();
    simulateToolCalls(telemetryService, aggregator);
    simulateApiResponses(telemetryService);

    const snapshot = aggregator.createSnapshot(telemetryService.getMetrics());

    // Startup
    expect(snapshot.startup.phases.length).toBe(8);
    expect(snapshot.startup.totalMs).toBeGreaterThan(0);

    // Memory (real process.memoryUsage())
    expect(snapshot.memory.heapUsedMB).toBeGreaterThan(0);
    expect(snapshot.memory.rssMB).toBeGreaterThan(0);
    expect(snapshot.memory.utilization).toBeGreaterThan(0);
    expect(snapshot.memory.utilization).toBeLessThan(1);

    // Tools
    expect(snapshot.tools.length).toBe(3);
    expect(
      snapshot.tools.find((t) => t.name === 'read_file')!.p95LatencyMs,
    ).toBe(6500);

    // Models
    expect(snapshot.models.length).toBe(2);
    const pro = snapshot.models.find((m) => m.model === 'gemini-2.5-pro')!;
    expect(pro.totalRequests).toBe(3);
    expect(pro.cachedTokens).toBe(4800); // 900 + 1800 + 2100
    expect(pro.cacheHitRate).toBeGreaterThan(0);

    // Token efficiency
    expect(snapshot.tokenEfficiency.totalInput).toBeGreaterThan(0);
    expect(snapshot.tokenEfficiency.totalCached).toBe(4800);
    expect(snapshot.tokenEfficiency.cacheHitRate).toBeGreaterThan(0);
  });

  it('suggestion engine fires on real snapshot data', () => {
    simulateStartupPhases();
    aggregator.captureStartup();
    clearStartupPhases();
    simulateToolCalls(telemetryService, aggregator);
    simulateApiResponses(telemetryService);

    const snapshot = aggregator.createSnapshot(telemetryService.getMetrics());
    const engine = new SuggestionEngine();
    const suggestions = engine.analyze(snapshot);

    // The slow shell tool (P95 = 8500ms > 5000ms threshold) should trigger
    const toolSuggestion = suggestions.find((s) => s.category === 'tool');
    expect(toolSuggestion).toBeDefined();
    expect(toolSuggestion!.message).toContain('shell');
    expect(toolSuggestion!.severity).toBe('warning');
  });

  it('report formatter produces text output from real data', () => {
    simulateStartupPhases();
    aggregator.captureStartup();
    clearStartupPhases();
    simulateToolCalls(telemetryService, aggregator);
    simulateApiResponses(telemetryService);

    const snapshot = aggregator.createSnapshot(telemetryService.getMetrics());

    const text = formatSnapshotText(snapshot);
    expect(text).toContain('Performance Snapshot');
    expect(text).toContain('Startup:');
    expect(text).toContain('cli_startup');
    expect(text).toContain('initialize_app');
    expect(text).toContain('Memory:');
    expect(text).toContain('Tool Performance:');
    expect(text).toContain('read_file');
    expect(text).toContain('shell');
    expect(text).toContain('gemini-2.5-pro');
    expect(text).toContain('hit rate');
  });

  it('report formatter produces markdown output from real data', () => {
    simulateStartupPhases();
    aggregator.captureStartup();
    clearStartupPhases();
    simulateToolCalls(telemetryService, aggregator);
    simulateApiResponses(telemetryService);

    const snapshot = aggregator.createSnapshot(telemetryService.getMetrics());

    const md = formatSnapshotMarkdown(snapshot);
    expect(md).toContain('## Performance Report');
    expect(md).toContain('| Phase | Duration |');
    expect(md).toContain('cli_startup');
    expect(md).toContain('### Tool Performance');
    expect(md).toContain('read_file');
  });

  it('JSON export produces valid parseable output', () => {
    simulateStartupPhases();
    aggregator.captureStartup();
    clearStartupPhases();
    simulateToolCalls(telemetryService, aggregator);
    simulateApiResponses(telemetryService);

    const snapshot = aggregator.createSnapshot(telemetryService.getMetrics());
    const json = formatSnapshotJSON(snapshot, true);

    const parsed = JSON.parse(json);
    expect(parsed.startup.phases).toHaveLength(8);
    expect(parsed.tools).toHaveLength(3);
    expect(parsed.models).toHaveLength(2);
    expect(parsed.tokenEfficiency.cacheHitRate).toBeGreaterThan(0);
  });

  it('baseline save → load → compare detects regression', async () => {
    // Create a "good" baseline snapshot
    simulateStartupPhases();
    aggregator.captureStartup();
    clearStartupPhases();
    simulateToolCalls(telemetryService, aggregator);
    simulateApiResponses(telemetryService);
    const baseline = aggregator.createSnapshot(telemetryService.getMetrics());

    // Create a "regressed" snapshot with slower startup
    const regressed = {
      ...baseline,
      timestamp: Date.now() + 1000,
      startup: {
        totalMs: baseline.startup.totalMs * 1.5, // 50% slower
        phases: baseline.startup.phases.map((p) => ({
          ...p,
          durationMs: p.durationMs * 1.5,
        })),
      },
    };

    const manager = new BaselineManager();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'perf-baseline-'));
    const baselinePath = path.join(tmpDir, 'baseline.json');

    try {
      await manager.saveBaseline(baseline, baselinePath);
      const loaded = await manager.loadBaseline(baselinePath);
      expect(loaded).not.toBeNull();
      expect(loaded!.startup.phases.length).toBe(8);

      const result = manager.compare(regressed, loaded!);
      expect(result.hasRegression).toBe(true);

      const startupMetric = result.metrics.find(
        (m) => m.metric === 'startup.totalMs',
      )!;
      expect(startupMetric.regression).toBe(true);
      expect(startupMetric.changePercent).toBeCloseTo(50, 0);

      expect(manager.getExitCode(result)).toBe(1);

      // Verify comparison text output
      const compText = formatComparisonText(result);
      expect(compText).toContain('Regression Detected');
      expect(compText).toContain('startup.totalMs');
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it('full pipeline end-to-end: startup → tools → API → snapshot → suggestions → report', () => {
    // Step 1: Simulate startup (like StartupProfiler in gemini.tsx)
    simulateStartupPhases();

    // Step 2: Capture before flush (like the wiring in gemini.tsx)
    aggregator.captureStartup();
    clearStartupPhases(); // simulate flush()

    // Step 3: Simulate tool calls (like logToolCall in loggers.ts)
    simulateToolCalls(telemetryService, aggregator);

    // Step 4: Simulate API responses (like logApiResponse in loggers.ts)
    simulateApiResponses(telemetryService);

    // Step 5: Create snapshot (what /perf command would do)
    const snapshot = aggregator.createSnapshot(telemetryService.getMetrics());

    // Step 6: Run suggestion engine
    const engine = new SuggestionEngine();
    const suggestions = engine.analyze(snapshot);

    // Step 7: Format everything
    const reportText = formatSnapshotText(snapshot);
    const suggestionsText = formatSuggestionsText(suggestions);

    // Verify the complete pipeline produced meaningful output
    expect(snapshot.startup.phases.length).toBe(8);
    expect(snapshot.tools.length).toBe(3);
    expect(snapshot.models.length).toBe(2);
    expect(snapshot.memory.heapUsedMB).toBeGreaterThan(0);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(reportText).toContain('Performance Snapshot');
    expect(reportText).toContain('cli_startup');
    expect(reportText).toContain('read_file');
    expect(reportText).toContain('gemini-2.5-pro');
    expect(suggestionsText).toContain('shell');

    // Verify report and suggestions are non-empty strings
    expect(reportText.length).toBeGreaterThan(100);
    expect(suggestionsText.length).toBeGreaterThan(10);
  });
});
