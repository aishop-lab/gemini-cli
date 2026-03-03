/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Domain filtering engine for the network proxy.
 *
 * Evaluates hostnames against allowlist/denylist rules with priority ordering.
 * Used by both the HTTP proxy (CONNECT domain extraction) and SOCKS5 proxy
 * to make allow/deny/prompt decisions before forwarding connections.
 *
 * Pattern syntax (inspired by Squid's dstdomain):
 *   "api.google.com"  → exact match
 *   ".google.com"     → suffix match (google.com and all subdomains)
 *   "*.google.com"    → glob match (subdomains only, NOT google.com itself)
 *   "192.168.*.*"     → IP glob match
 *
 * Priority order:
 *   1. Built-in allowlist (Gemini API, localhost) — cannot be overridden
 *   2. Session decisions (from interactive prompts)
 *   3. Denylist (deny overrides allow when both match)
 *   4. Allowlist
 *   5. Default action
 */

// ── Types ───────────────────────────────────────────────────────────────

export type FilterDecision = 'allowed' | 'denied' | 'prompt';

export type RuleSource =
  | 'builtin'
  | 'session-allow'
  | 'session-deny'
  | 'denylist'
  | 'allowlist'
  | 'default';

export type PatternType = 'exact' | 'suffix' | 'glob';

export interface DomainRule {
  /** Raw pattern string from configuration. */
  pattern: string;
  /** How this pattern is matched. */
  type: PatternType;
  /** Pre-compiled RegExp for glob patterns (null for exact/suffix). */
  compiled: RegExp | null;
}

export interface FilterResult {
  /** The filtering decision. */
  decision: FilterDecision;
  /** The rule that produced the decision (absent for session/default). */
  matchedRule?: DomainRule;
  /** Which list or mechanism produced this decision. */
  source: RuleSource;
}

export interface FilterStats {
  totalChecks: number;
  allowed: number;
  denied: number;
  prompted: number;
  builtinHits: number;
  sessionAllowHits: number;
  sessionDenyHits: number;
}

export interface DomainFilterConfig {
  defaultAction: FilterDecision;
  allowlist: string[];
  denylist: string[];
}

// ── Constants ───────────────────────────────────────────────────────────

/**
 * Domains that are always allowed and cannot be overridden by denylist.
 * These are essential for Gemini CLI's own operation.
 */
const BUILTIN_EXACT: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
]);

/**
 * Suffix patterns for built-in allowlist.
 * Matches the domain itself and all subdomains.
 */
const BUILTIN_SUFFIXES: readonly string[] = ['.googleapis.com', '.google.com'];

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Classify a pattern string into its matching type and optionally compile
 * it into a RegExp for glob patterns.
 */
export function compilePattern(pattern: string): DomainRule {
  if (pattern === '**') {
    return { pattern, type: 'glob', compiled: /^.*$/ };
  }

  // Suffix pattern: leading dot matches domain itself and all subdomains
  // e.g., ".google.com" matches "google.com" and "api.google.com"
  if (pattern.startsWith('.') && !pattern.includes('*')) {
    return { pattern, type: 'suffix', compiled: null };
  }

  // Glob pattern: contains wildcards
  if (pattern.includes('*')) {
    // Step 1: Escape all regex metacharacters EXCEPT the asterisk
    // Step 2: Replace bare asterisks with a label-boundary match [^.]+
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^.]+');
    return {
      pattern,
      type: 'glob',
      compiled: new RegExp(`^${escaped}$`, 'i'),
    };
  }

  // Exact match
  return { pattern, type: 'exact', compiled: null };
}

/**
 * Check if a hostname matches a suffix pattern.
 * ".google.com" matches both "google.com" and "api.google.com".
 */
function matchesSuffix(hostname: string, suffix: string): boolean {
  const bare = suffix.slice(1); // Remove leading dot
  return hostname === bare || hostname.endsWith(suffix);
}

// ── DomainFilter ────────────────────────────────────────────────────────

export class DomainFilter {
  private readonly config: DomainFilterConfig;
  private readonly allowRules: DomainRule[];
  private readonly denyRules: DomainRule[];
  private readonly sessionAllowlist: Set<string> = new Set();
  private readonly sessionDenylist: Set<string> = new Set();
  private readonly stats: FilterStats = {
    totalChecks: 0,
    allowed: 0,
    denied: 0,
    prompted: 0,
    builtinHits: 0,
    sessionAllowHits: 0,
    sessionDenyHits: 0,
  };

  constructor(config: DomainFilterConfig) {
    this.config = config;
    this.allowRules = config.allowlist.map(compilePattern);
    this.denyRules = config.denylist.map(compilePattern);
  }

  /**
   * Check a hostname against the filter rules.
   * Returns a FilterResult with the decision, matched rule, and source.
   */
  check(hostname: string): FilterResult {
    hostname = hostname.toLowerCase().trim();
    this.stats.totalChecks++;

    // 1. Built-in allowlist — always allowed, cannot be overridden
    if (this.isBuiltin(hostname)) {
      this.stats.allowed++;
      this.stats.builtinHits++;
      return { decision: 'allowed', source: 'builtin' };
    }

    // 2. Session decisions from interactive prompts (highest user intent)
    if (this.sessionAllowlist.has(hostname)) {
      this.stats.allowed++;
      this.stats.sessionAllowHits++;
      return { decision: 'allowed', source: 'session-allow' };
    }
    if (this.sessionDenylist.has(hostname)) {
      this.stats.denied++;
      this.stats.sessionDenyHits++;
      return { decision: 'denied', source: 'session-deny' };
    }

    // 3. Denylist — checked before allowlist (deny takes priority)
    const denyMatch = this.findMatch(hostname, this.denyRules);
    if (denyMatch) {
      this.stats.denied++;
      return {
        decision: 'denied',
        matchedRule: denyMatch,
        source: 'denylist',
      };
    }

    // 4. Allowlist
    const allowMatch = this.findMatch(hostname, this.allowRules);
    if (allowMatch) {
      this.stats.allowed++;
      return {
        decision: 'allowed',
        matchedRule: allowMatch,
        source: 'allowlist',
      };
    }

    // 5. Default action
    const decision = this.config.defaultAction;
    if (decision === 'allowed') {
      this.stats.allowed++;
    } else if (decision === 'denied') {
      this.stats.denied++;
    } else {
      this.stats.prompted++;
    }
    return { decision, source: 'default' };
  }

  /**
   * Add a hostname to the session allowlist (from interactive "allow for session").
   */
  addSessionAllow(hostname: string): void {
    const normalized = hostname.toLowerCase().trim();
    this.sessionDenylist.delete(normalized); // Remove conflicting deny
    this.sessionAllowlist.add(normalized);
  }

  /**
   * Add a hostname to the session denylist (from interactive "deny").
   */
  addSessionDeny(hostname: string): void {
    const normalized = hostname.toLowerCase().trim();
    this.sessionAllowlist.delete(normalized); // Remove conflicting allow
    this.sessionDenylist.add(normalized);
  }

  /**
   * Clear all session-level decisions. Called on session reset.
   */
  resetSession(): void {
    this.sessionAllowlist.clear();
    this.sessionDenylist.clear();
  }

  /**
   * Get filtering statistics for the current session.
   */
  getStats(): FilterStats {
    return { ...this.stats };
  }

  /**
   * Get the number of configured rules (for diagnostics).
   */
  getRuleCount(): { allow: number; deny: number } {
    return {
      allow: this.allowRules.length,
      deny: this.denyRules.length,
    };
  }

  // ── Private ─────────────────────────────────────────────────────────

  private isBuiltin(hostname: string): boolean {
    if (BUILTIN_EXACT.has(hostname)) return true;
    for (const suffix of BUILTIN_SUFFIXES) {
      if (matchesSuffix(hostname, suffix)) return true;
    }
    return false;
  }

  private findMatch(
    hostname: string,
    rules: DomainRule[],
  ): DomainRule | undefined {
    for (const rule of rules) {
      if (this.matchesRule(hostname, rule)) return rule;
    }
    return undefined;
  }

  private matchesRule(hostname: string, rule: DomainRule): boolean {
    switch (rule.type) {
      case 'exact':
        return hostname === rule.pattern.toLowerCase();
      case 'suffix':
        return matchesSuffix(hostname, rule.pattern.toLowerCase());
      case 'glob':
        return rule.compiled!.test(hostname);
      default:
        return false;
    }
  }
}
