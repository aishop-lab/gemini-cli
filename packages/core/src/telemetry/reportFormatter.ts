/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PerformanceSnapshot } from './performanceAggregator.js';
import type { ComparisonResult } from './baselineManager.js';
import type { Suggestion } from './suggestionEngine.js';

/**
 * Supported output formats for performance reports.
 */
export type ReportFormat = 'text' | 'json' | 'markdown';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function pad(str: string, width: number): string {
  if (str.length > width) return str.slice(0, width - 1) + '…';
  return str.padEnd(width);
}

/**
 * Formats a performance snapshot as plain text for terminal output.
 * Designed for the `/perf` command response.
 */
export function formatSnapshotText(snapshot: PerformanceSnapshot): string {
  const lines: string[] = [];

  lines.push('Performance Snapshot');
  lines.push('─'.repeat(50));

  // Startup
  lines.push('');
  lines.push(`Startup: ${formatDuration(snapshot.startup.totalMs)}`);
  for (const phase of snapshot.startup.phases) {
    lines.push(`  ${pad(phase.name, 30)} ${formatDuration(phase.durationMs)}`);
  }

  // Memory
  lines.push('');
  lines.push(
    `Memory: ${snapshot.memory.heapUsedMB.toFixed(0)}MB / ${snapshot.memory.heapSizeLimitMB.toFixed(0)}MB (${formatPercent(snapshot.memory.utilization)})`,
  );
  lines.push(`  RSS: ${snapshot.memory.rssMB.toFixed(0)}MB`);

  // Tools
  if (snapshot.tools.length > 0) {
    lines.push('');
    lines.push('Tool Performance:');
    lines.push(
      `  ${pad('Tool', 20)} ${pad('Calls', 8)} ${pad('P95', 10)} ${pad('Avg', 10)} Success`,
    );
    lines.push(`  ${'─'.repeat(58)}`);
    for (const tool of snapshot.tools) {
      lines.push(
        `  ${pad(tool.name, 20)} ${pad(String(tool.callCount), 8)} ${pad(formatDuration(tool.p95LatencyMs), 10)} ${pad(formatDuration(tool.avgLatencyMs), 10)} ${formatPercent(tool.successRate)}`,
      );
    }
  }

  // Models
  if (snapshot.models.length > 0) {
    lines.push('');
    lines.push('API Performance:');
    for (const model of snapshot.models) {
      lines.push(
        `  ${model.model}: ${model.totalRequests} reqs, ${formatDuration(model.avgLatencyMs)} avg, ${formatPercent(1 - model.errorRate)} success`,
      );
    }
  }

  // Token efficiency
  lines.push('');
  const te = snapshot.tokenEfficiency;
  lines.push(
    `Tokens: ${te.totalInput} in / ${te.totalOutput} out / ${te.totalCached} cached (${formatPercent(te.cacheHitRate)} hit rate)`,
  );

  return lines.join('\n');
}

/**
 * Formats a baseline comparison result as terminal text for CI output.
 */
export function formatComparisonText(result: ComparisonResult): string {
  if (!result.hasRegression) {
    return 'No performance regressions detected.';
  }

  const lines: string[] = [];
  lines.push(
    `Performance Regression Detected (severity: ${result.highestSeverity})`,
  );
  lines.push('─'.repeat(60));

  for (const metric of result.metrics) {
    if (!metric.regression) continue;
    const sign = metric.changePercent > 0 ? '+' : '';
    lines.push(
      `  [${metric.severity.toUpperCase()}] ${metric.metric}: ${metric.baseline} → ${metric.current} (${sign}${metric.changePercent.toFixed(1)}%)`,
    );
  }

  return lines.join('\n');
}

const SEVERITY_ICONS: Record<string, string> = {
  critical: '[!]',
  warning: '[*]',
  info: '[-]',
};

/**
 * Formats suggestions as terminal text, ordered by severity.
 */
export function formatSuggestionsText(suggestions: Suggestion[]): string {
  if (suggestions.length === 0) return 'No optimization suggestions.';

  const lines: string[] = [];
  for (const s of suggestions) {
    lines.push(`${SEVERITY_ICONS[s.severity] || '[ ]'} ${s.message}`);
  }

  return lines.join('\n');
}

/**
 * Serializes a snapshot as JSON. Use `pretty` for human-readable file export.
 */
export function formatSnapshotJSON(
  snapshot: PerformanceSnapshot,
  pretty: boolean = false,
): string {
  return pretty ? JSON.stringify(snapshot, null, 2) : JSON.stringify(snapshot);
}

/**
 * Formats a snapshot as Markdown suitable for PR comments or reports.
 */
export function formatSnapshotMarkdown(snapshot: PerformanceSnapshot): string {
  const lines: string[] = [];

  lines.push('## Performance Report');
  lines.push('');

  // Startup
  lines.push(`**Startup:** ${formatDuration(snapshot.startup.totalMs)}`);
  if (snapshot.startup.phases.length > 0) {
    lines.push('');
    lines.push('| Phase | Duration |');
    lines.push('|-------|----------|');
    for (const phase of snapshot.startup.phases) {
      lines.push(`| ${phase.name} | ${formatDuration(phase.durationMs)} |`);
    }
  }

  // Memory
  lines.push('');
  lines.push(
    `**Memory:** ${snapshot.memory.heapUsedMB.toFixed(0)}MB / ${snapshot.memory.heapSizeLimitMB.toFixed(0)}MB (${formatPercent(snapshot.memory.utilization)})`,
  );

  // Tools
  if (snapshot.tools.length > 0) {
    lines.push('');
    lines.push('### Tool Performance');
    lines.push('');
    lines.push('| Tool | Calls | P95 | Avg | Success |');
    lines.push('|------|-------|-----|-----|---------|');
    for (const tool of snapshot.tools) {
      lines.push(
        `| ${tool.name} | ${tool.callCount} | ${formatDuration(tool.p95LatencyMs)} | ${formatDuration(tool.avgLatencyMs)} | ${formatPercent(tool.successRate)} |`,
      );
    }
  }

  // Token efficiency
  lines.push('');
  const te = snapshot.tokenEfficiency;
  lines.push(
    `**Tokens:** ${te.totalInput} input, ${te.totalOutput} output, ${formatPercent(te.cacheHitRate)} cache hit rate`,
  );

  return lines.join('\n');
}

/**
 * Formats a comparison result as Markdown for PR review comments.
 */
export function formatComparisonMarkdown(result: ComparisonResult): string {
  if (!result.hasRegression) {
    return [
      '### Regression Check: Passed',
      '',
      'No performance regressions detected.',
    ].join('\n');
  }

  const lines: string[] = [];
  lines.push(`### Regression Check: Failed (${result.highestSeverity})`);
  lines.push('');
  lines.push('| Metric | Baseline | Current | Change | Severity |');
  lines.push('|--------|----------|---------|--------|----------|');

  for (const metric of result.metrics) {
    if (!metric.regression) continue;
    const sign = metric.changePercent > 0 ? '+' : '';
    lines.push(
      `| ${metric.metric} | ${metric.baseline} | ${metric.current} | ${sign}${metric.changePercent.toFixed(1)}% | ${metric.severity} |`,
    );
  }

  return lines.join('\n');
}
