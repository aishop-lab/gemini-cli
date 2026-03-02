/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PerformanceSnapshot } from './performanceAggregator.js';

/**
 * An actionable optimization suggestion.
 */
export interface Suggestion {
  category: 'memory' | 'startup' | 'tool' | 'token' | 'general';
  severity: 'info' | 'warning' | 'critical';
  message: string;
}

/**
 * Extensible rule interface for the suggestion engine.
 * Contributors can add custom rules without modifying the engine itself.
 */
export interface SuggestionRule {
  name: string;
  evaluate(snapshot: PerformanceSnapshot): Suggestion | null;
}

const DEFAULT_RULES: SuggestionRule[] = [
  {
    name: 'low-cache-utilization',
    evaluate(snapshot) {
      const { cacheHitRate, totalInput } = snapshot.tokenEfficiency;
      if (totalInput < 100) return null;
      if (cacheHitRate < 0.3) {
        return {
          category: 'token',
          severity: 'warning',
          message: `Low cache utilization (${(cacheHitRate * 100).toFixed(1)}%) — consider structuring prompts for better caching.`,
        };
      }
      return null;
    },
  },
  {
    name: 'slow-tool-p95',
    evaluate(snapshot) {
      let worst: (typeof snapshot.tools)[number] | null = null;
      for (const tool of snapshot.tools) {
        if (tool.callCount < 3) continue;
        if (tool.p95LatencyMs > 5000) {
          if (!worst || tool.p95LatencyMs > worst.p95LatencyMs) {
            worst = tool;
          }
        }
      }
      if (!worst) return null;
      return {
        category: 'tool',
        severity: 'warning',
        message: `Tool \`${worst.name}\` is slow (P95: ${(worst.p95LatencyMs / 1000).toFixed(1)}s) — check for large file reads or network calls.`,
      };
    },
  },
  {
    name: 'high-memory-usage',
    evaluate(snapshot) {
      if (snapshot.memory.utilization > 0.85) {
        return {
          category: 'memory',
          severity: 'critical',
          message: `High memory usage (${(snapshot.memory.utilization * 100).toFixed(0)}% of heap limit) — risk of heap exhaustion crash.`,
        };
      }
      if (snapshot.memory.utilization > 0.6) {
        return {
          category: 'memory',
          severity: 'warning',
          message: `Elevated memory usage (${(snapshot.memory.utilization * 100).toFixed(0)}% of heap limit) — consider shorter sessions or fewer concurrent tools.`,
        };
      }
      return null;
    },
  },
  {
    name: 'slow-startup',
    evaluate(snapshot) {
      if (snapshot.startup.phases.length === 0) return null;
      if (snapshot.startup.totalMs > 3000) {
        const slowest = snapshot.startup.phases.reduce(
          (max, p) => (p.durationMs > max.durationMs ? p : max),
          { name: 'unknown', durationMs: 0 },
        );
        return {
          category: 'startup',
          severity: snapshot.startup.totalMs > 10000 ? 'critical' : 'warning',
          message: `Slow startup (${(snapshot.startup.totalMs / 1000).toFixed(1)}s) — slowest phase: \`${slowest.name}\` (${(slowest.durationMs / 1000).toFixed(1)}s).`,
        };
      }
      return null;
    },
  },
  {
    name: 'high-api-error-rate',
    evaluate(snapshot) {
      for (const model of snapshot.models) {
        if (model.totalRequests < 3) continue;
        if (model.errorRate > 0.1) {
          return {
            category: 'general',
            severity: model.errorRate > 0.3 ? 'critical' : 'warning',
            message: `High API error rate for \`${model.model}\` (${(model.errorRate * 100).toFixed(0)}%) — check network connectivity or API quotas.`,
          };
        }
      }
      return null;
    },
  },
];

// Higher number = more urgent. Used to surface critical issues first.
const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

/**
 * Rule-based engine that analyzes performance snapshots and produces
 * actionable optimization suggestions. Ships with sensible defaults
 * and supports custom rules via the SuggestionRule interface.
 */
export class SuggestionEngine {
  private rules: SuggestionRule[];

  constructor(rules?: SuggestionRule[]) {
    this.rules = rules ?? [...DEFAULT_RULES];
  }

  /**
   * Adds a custom suggestion rule.
   */
  addRule(rule: SuggestionRule): void {
    this.rules.push(rule);
  }

  /**
   * Removes a rule by name. Returns true if the rule was found and removed.
   */
  removeRule(name: string): boolean {
    const idx = this.rules.findIndex((r) => r.name === name);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    return true;
  }

  /**
   * Analyzes a performance snapshot and returns all triggered suggestions,
   * ordered by severity (critical first).
   */
  analyze(snapshot: PerformanceSnapshot): Suggestion[] {
    const suggestions: Suggestion[] = [];
    for (const rule of this.rules) {
      const suggestion = rule.evaluate(snapshot);
      if (suggestion) {
        suggestions.push(suggestion);
      }
    }
    suggestions.sort(
      (a, b) =>
        (SEVERITY_WEIGHT[b.severity] || 0) - (SEVERITY_WEIGHT[a.severity] || 0),
    );
    return suggestions;
  }

  /**
   * Returns a copy of the built-in default rules.
   */
  static getDefaultRules(): SuggestionRule[] {
    return [...DEFAULT_RULES];
  }
}
