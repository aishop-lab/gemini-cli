/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { SuggestionEngine, type SuggestionRule } from './suggestionEngine.js';
import type { PerformanceSnapshot } from './performanceAggregator.js';

function createMockSnapshot(
  overrides?: Partial<PerformanceSnapshot>,
): PerformanceSnapshot {
  return {
    timestamp: Date.now(),
    startup: { totalMs: 500, phases: [] },
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
      totalCached: 2500,
      cacheHitRate: 0.5,
    },
    ...overrides,
  };
}

describe('SuggestionEngine', () => {
  describe('default rules', () => {
    it('should return no suggestions for healthy metrics', () => {
      const engine = new SuggestionEngine();
      const snapshot = createMockSnapshot();
      const suggestions = engine.analyze(snapshot);
      expect(suggestions).toHaveLength(0);
    });

    it('should warn on low cache utilization', () => {
      const engine = new SuggestionEngine();
      const snapshot = createMockSnapshot({
        tokenEfficiency: {
          totalInput: 5000,
          totalOutput: 3000,
          totalCached: 500,
          cacheHitRate: 0.1,
        },
      });

      const suggestions = engine.analyze(snapshot);
      const cacheSuggestion = suggestions.find((s) => s.category === 'token');
      expect(cacheSuggestion).toBeDefined();
      expect(cacheSuggestion!.severity).toBe('warning');
      expect(cacheSuggestion!.message).toContain('cache utilization');
    });

    it('should skip cache warning with insufficient data', () => {
      const engine = new SuggestionEngine();
      const snapshot = createMockSnapshot({
        tokenEfficiency: {
          totalInput: 50,
          totalOutput: 30,
          totalCached: 5,
          cacheHitRate: 0.1,
        },
      });

      const suggestions = engine.analyze(snapshot);
      const cacheSuggestion = suggestions.find((s) => s.category === 'token');
      expect(cacheSuggestion).toBeUndefined();
    });

    it('should not warn when cache rate is exactly at threshold', () => {
      const engine = new SuggestionEngine();
      const snapshot = createMockSnapshot({
        tokenEfficiency: {
          totalInput: 5000,
          totalOutput: 3000,
          totalCached: 1500,
          cacheHitRate: 0.3,
        },
      });

      const suggestions = engine.analyze(snapshot);
      const cacheSuggestion = suggestions.find((s) => s.category === 'token');
      expect(cacheSuggestion).toBeUndefined();
    });

    it('should warn on slow tool P95 latency', () => {
      const engine = new SuggestionEngine();
      const snapshot = createMockSnapshot({
        tools: [
          {
            name: 'read_file',
            callCount: 10,
            successRate: 1,
            avgLatencyMs: 3000,
            p95LatencyMs: 8000,
          },
        ],
      });

      const suggestions = engine.analyze(snapshot);
      const toolSuggestion = suggestions.find((s) => s.category === 'tool');
      expect(toolSuggestion).toBeDefined();
      expect(toolSuggestion!.message).toContain('read_file');
      expect(toolSuggestion!.message).toContain('8.0s');
    });

    it('should skip tool warning with insufficient call count', () => {
      const engine = new SuggestionEngine();
      const snapshot = createMockSnapshot({
        tools: [
          {
            name: 'rare_tool',
            callCount: 2,
            successRate: 1,
            avgLatencyMs: 10000,
            p95LatencyMs: 15000,
          },
        ],
      });

      const suggestions = engine.analyze(snapshot);
      const toolSuggestion = suggestions.find((s) => s.category === 'tool');
      expect(toolSuggestion).toBeUndefined();
    });

    it('should produce warning for elevated memory (>60%)', () => {
      const engine = new SuggestionEngine();
      const snapshot = createMockSnapshot({
        memory: {
          heapUsedMB: 1300,
          heapTotalMB: 1800,
          heapSizeLimitMB: 2048,
          rssMB: 1600,
          utilization: 0.65,
        },
      });

      const suggestions = engine.analyze(snapshot);
      const memSuggestion = suggestions.find((s) => s.category === 'memory');
      expect(memSuggestion).toBeDefined();
      expect(memSuggestion!.severity).toBe('warning');
      expect(memSuggestion!.message).toContain('65%');
    });

    it('should produce warning (not critical) at exactly 0.85 utilization', () => {
      const engine = new SuggestionEngine();
      const snapshot = createMockSnapshot({
        memory: {
          heapUsedMB: 1740,
          heapTotalMB: 1900,
          heapSizeLimitMB: 2048,
          rssMB: 1800,
          utilization: 0.85,
        },
      });

      const suggestions = engine.analyze(snapshot);
      const memSuggestion = suggestions.find((s) => s.category === 'memory');
      expect(memSuggestion).toBeDefined();
      expect(memSuggestion!.severity).toBe('warning');
    });

    it('should produce critical for high memory (>85%)', () => {
      const engine = new SuggestionEngine();
      const snapshot = createMockSnapshot({
        memory: {
          heapUsedMB: 1800,
          heapTotalMB: 2000,
          heapSizeLimitMB: 2048,
          rssMB: 1900,
          utilization: 0.9,
        },
      });

      const suggestions = engine.analyze(snapshot);
      const memSuggestion = suggestions.find((s) => s.category === 'memory');
      expect(memSuggestion).toBeDefined();
      expect(memSuggestion!.severity).toBe('critical');
      expect(memSuggestion!.message).toContain('heap exhaustion');
    });

    it('should not warn on memory below 60%', () => {
      const engine = new SuggestionEngine();
      const snapshot = createMockSnapshot({
        memory: {
          heapUsedMB: 500,
          heapTotalMB: 1000,
          heapSizeLimitMB: 2048,
          rssMB: 700,
          utilization: 0.25,
        },
      });

      const suggestions = engine.analyze(snapshot);
      const memSuggestion = suggestions.find((s) => s.category === 'memory');
      expect(memSuggestion).toBeUndefined();
    });

    it('should warn on slow startup (>3s)', () => {
      const engine = new SuggestionEngine();
      const snapshot = createMockSnapshot({
        startup: {
          totalMs: 5000,
          phases: [
            { name: 'load_cli_config', durationMs: 3500 },
            { name: 'initialize_app', durationMs: 1500 },
          ],
        },
      });

      const suggestions = engine.analyze(snapshot);
      const startupSuggestion = suggestions.find(
        (s) => s.category === 'startup',
      );
      expect(startupSuggestion).toBeDefined();
      expect(startupSuggestion!.severity).toBe('warning');
      expect(startupSuggestion!.message).toContain('load_cli_config');
    });

    it('should produce critical for very slow startup (>10s)', () => {
      const engine = new SuggestionEngine();
      const snapshot = createMockSnapshot({
        startup: {
          totalMs: 15000,
          phases: [{ name: 'cli_startup', durationMs: 15000 }],
        },
      });

      const suggestions = engine.analyze(snapshot);
      const startupSuggestion = suggestions.find(
        (s) => s.category === 'startup',
      );
      expect(startupSuggestion!.severity).toBe('critical');
    });

    it('should skip startup warning when no phases exist', () => {
      const engine = new SuggestionEngine();
      const snapshot = createMockSnapshot({
        startup: { totalMs: 5000, phases: [] },
      });

      const suggestions = engine.analyze(snapshot);
      const startupSuggestion = suggestions.find(
        (s) => s.category === 'startup',
      );
      expect(startupSuggestion).toBeUndefined();
    });

    it('should warn on high API error rate', () => {
      const engine = new SuggestionEngine();
      const snapshot = createMockSnapshot({
        models: [
          {
            model: 'gemini-2.0-flash',
            totalRequests: 20,
            errorRate: 0.15,
            avgLatencyMs: 500,
            inputTokens: 5000,
            outputTokens: 3000,
            cachedTokens: 1500,
            cacheHitRate: 0.3,
          },
        ],
      });

      const suggestions = engine.analyze(snapshot);
      const apiSuggestion = suggestions.find((s) => s.category === 'general');
      expect(apiSuggestion).toBeDefined();
      expect(apiSuggestion!.severity).toBe('warning');
      expect(apiSuggestion!.message).toContain('gemini-2.0-flash');
    });

    it('should produce critical for very high error rate (>30%)', () => {
      const engine = new SuggestionEngine();
      const snapshot = createMockSnapshot({
        models: [
          {
            model: 'failing-model',
            totalRequests: 10,
            errorRate: 0.5,
            avgLatencyMs: 500,
            inputTokens: 1000,
            outputTokens: 500,
            cachedTokens: 100,
            cacheHitRate: 0.1,
          },
        ],
      });

      const suggestions = engine.analyze(snapshot);
      const apiSuggestion = suggestions.find((s) => s.category === 'general');
      expect(apiSuggestion!.severity).toBe('critical');
    });

    it('should skip API error warning with insufficient requests', () => {
      const engine = new SuggestionEngine();
      const snapshot = createMockSnapshot({
        models: [
          {
            model: 'model-x',
            totalRequests: 2,
            errorRate: 0.5,
            avgLatencyMs: 500,
            inputTokens: 200,
            outputTokens: 100,
            cachedTokens: 0,
            cacheHitRate: 0,
          },
        ],
      });

      const suggestions = engine.analyze(snapshot);
      const apiSuggestion = suggestions.find((s) => s.category === 'general');
      expect(apiSuggestion).toBeUndefined();
    });

    it('should produce multiple suggestions for unhealthy snapshot', () => {
      const engine = new SuggestionEngine();
      const snapshot = createMockSnapshot({
        startup: {
          totalMs: 12000,
          phases: [{ name: 'cli_startup', durationMs: 12000 }],
        },
        memory: {
          heapUsedMB: 1800,
          heapTotalMB: 2000,
          heapSizeLimitMB: 2048,
          rssMB: 1900,
          utilization: 0.9,
        },
        tokenEfficiency: {
          totalInput: 5000,
          totalOutput: 3000,
          totalCached: 200,
          cacheHitRate: 0.04,
        },
      });

      const suggestions = engine.analyze(snapshot);
      expect(suggestions.length).toBeGreaterThanOrEqual(3);

      const categories = suggestions.map((s) => s.category);
      expect(categories).toContain('memory');
      expect(categories).toContain('startup');
      expect(categories).toContain('token');
    });
  });

  describe('custom rules', () => {
    it('should support adding custom rules', () => {
      const engine = new SuggestionEngine();

      const customRule: SuggestionRule = {
        name: 'custom-check',
        evaluate(_snapshot) {
          return {
            category: 'general',
            severity: 'info',
            message: 'Custom rule triggered.',
          };
        },
      };

      engine.addRule(customRule);
      const suggestions = engine.analyze(createMockSnapshot());
      const custom = suggestions.find(
        (s) => s.message === 'Custom rule triggered.',
      );
      expect(custom).toBeDefined();
    });

    it('should support engine with only custom rules', () => {
      const customRule: SuggestionRule = {
        name: 'only-rule',
        evaluate(snapshot) {
          if (snapshot.memory.heapUsedMB > 100) {
            return {
              category: 'memory',
              severity: 'info',
              message: 'Memory in use.',
            };
          }
          return null;
        },
      };

      const engine = new SuggestionEngine([customRule]);
      const suggestions = engine.analyze(createMockSnapshot());
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].message).toBe('Memory in use.');
    });

    it('should remove a rule by name', () => {
      const engine = new SuggestionEngine();
      const removed = engine.removeRule('low-cache-utilization');
      expect(removed).toBe(true);

      // Verify the rule no longer triggers
      const snapshot = createMockSnapshot({
        tokenEfficiency: {
          totalInput: 5000,
          totalOutput: 3000,
          totalCached: 500,
          cacheHitRate: 0.1,
        },
      });
      const suggestions = engine.analyze(snapshot);
      expect(suggestions.find((s) => s.category === 'token')).toBeUndefined();
    });

    it('should return false when removing a non-existent rule', () => {
      const engine = new SuggestionEngine();
      expect(engine.removeRule('does-not-exist')).toBe(false);
    });
  });

  describe('severity ordering', () => {
    it('should return critical suggestions before warnings', () => {
      const engine = new SuggestionEngine();
      const snapshot = createMockSnapshot({
        startup: {
          totalMs: 15000,
          phases: [{ name: 'cli_startup', durationMs: 15000 }],
        },
        tokenEfficiency: {
          totalInput: 5000,
          totalOutput: 3000,
          totalCached: 200,
          cacheHitRate: 0.04,
        },
      });

      const suggestions = engine.analyze(snapshot);
      expect(suggestions.length).toBeGreaterThanOrEqual(2);
      // Critical startup suggestion should come before warning cache suggestion
      expect(suggestions[0].severity).toBe('critical');
    });

    it('should sort mixed severities correctly', () => {
      const rules: SuggestionRule[] = [
        {
          name: 'info-rule',
          evaluate: () => ({
            category: 'general',
            severity: 'info',
            message: 'info',
          }),
        },
        {
          name: 'critical-rule',
          evaluate: () => ({
            category: 'general',
            severity: 'critical',
            message: 'critical',
          }),
        },
        {
          name: 'warning-rule',
          evaluate: () => ({
            category: 'general',
            severity: 'warning',
            message: 'warning',
          }),
        },
      ];

      const engine = new SuggestionEngine(rules);
      const suggestions = engine.analyze(createMockSnapshot());

      expect(suggestions[0].severity).toBe('critical');
      expect(suggestions[1].severity).toBe('warning');
      expect(suggestions[2].severity).toBe('info');
    });
  });

  describe('getDefaultRules', () => {
    it('should return a copy of default rules', () => {
      const rules = SuggestionEngine.getDefaultRules();
      expect(rules.length).toBe(5);

      const names = rules.map((r) => r.name);
      expect(names).toContain('low-cache-utilization');
      expect(names).toContain('slow-tool-p95');
      expect(names).toContain('high-memory-usage');
      expect(names).toContain('slow-startup');
      expect(names).toContain('high-api-error-rate');
    });

    it('should return independent copies', () => {
      const rules1 = SuggestionEngine.getDefaultRules();
      const rules2 = SuggestionEngine.getDefaultRules();
      expect(rules1).not.toBe(rules2);
    });
  });
});
